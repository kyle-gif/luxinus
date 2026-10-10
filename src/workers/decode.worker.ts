// Decode utility process (Phase 1).
//
// Owns the heavy image work off the main/renderer threads:
//   • recursive folder scan for supported formats
//   • standard-format decode + all resize/encode via sharp
//   • 2560px-long-edge proxy (previews) + small webp thumbnail (grid/filmstrip)
//   • SQLite (better-sqlite3) + webp thumbnail cache, invalidated on mtime change
//
// RAW decode itself is NOT done here: libraw-wasm is a browser build, so RAW
// bytes are decoded in the hidden Chromium decode window and returned to this
// process (via a host round-trip through main) as RGB / embedded JPEG, which we
// then resize+encode with sharp.
//
// Decode work runs through a sequential queue so a big folder never fans out
// into hundreds of concurrent decodes (OOM avoidance). Proxy requests jump the
// queue since they are user-driven (photo selection).

import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import fss, { type Dirent } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import Database from 'better-sqlite3'
import {
  PROXY_LONG_EDGE,
  THUMB_LONG_EDGE,
  isRawExt,
  isSupportedExt,
  type LibraryPhoto,
  type PhotoMeta,
  type RawDecodeMode,
  type RawDecodeResult,
  type WorkerRequest,
  type WorkerResponse
} from '../shared/library'

// libvips defaults to one thread per core and a generous pixel cache — right
// for a batch server, wasteful for a photo browser. Scale modestly with the
// machine (2 on a dual-core, up to 4 on a big one) so folder loading uses the
// hardware without letting RAW decodes fan out into an OOM; the bounded queue
// below caps parallel decodes on top of this.
const CPUS = Math.max(1, os.cpus()?.length ?? 4)
sharp.concurrency(Math.min(4, Math.max(2, CPUS >> 1)))
sharp.cache({ memory: 64, files: 0, items: 256 })

// ── utilityProcess message port ─────────────────────────────────────────────
interface ParentPort {
  on(ev: 'message', cb: (e: { data: WorkerRequest }) => void): void
  postMessage(m: WorkerResponse): void
}
const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort
function post(msg: WorkerResponse): void {
  parentPort.postMessage(msg)
}

// ── RAW decode host round-trip ──────────────────────────────────────────────
// Ask main to decode a RAW in the hidden Chromium decode window, and await the
// RGB / embedded-JPEG result. Keyed by requestId.
const rawPending = new Map<
  string,
  { resolve: (r: RawDecodeResult) => void; reject: (e: Error) => void }
>()

function requestRawFromHost(filePath: string, mode: RawDecodeMode): Promise<RawDecodeResult> {
  const requestId = randomUUID()
  return new Promise<RawDecodeResult>((resolve, reject) => {
    rawPending.set(requestId, { resolve, reject })
    post({ kind: 'host:decodeRaw', requestId, filePath, mode })
  })
}

// ── cache ───────────────────────────────────────────────────────────────────
let db: Database.Database
let proxyDir = ''

function initCache(cacheDir: string): void {
  fss.mkdirSync(cacheDir, { recursive: true })
  proxyDir = path.join(cacheDir, 'proxies')
  fss.mkdirSync(proxyDir, { recursive: true })
  void pruneProxyCache()
  db = new Database(path.join(cacheDir, 'library.sqlite'))
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS photos (
      path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      width INTEGER, height INTEGER,
      camera_make TEXT, camera_model TEXT,
      iso REAL, aperture REAL, shutter REAL, focal REAL, captured_at TEXT,
      thumb BLOB,
      rating INTEGER NOT NULL DEFAULT 0,
      flagged INTEGER NOT NULL DEFAULT 0
    )
  `)
}

// Proxies are keyed by path+mtime, so editing or re-saving a photo strands its
// old proxy on disk forever. Trim the cache to a bounded size at startup, oldest
// first — every entry is reproducible, so evicting one only costs a re-decode.
const PROXY_CACHE_MAX_BYTES = 2 * 1024 ** 3

async function pruneProxyCache(): Promise<void> {
  try {
    const names = await fs.readdir(proxyDir)
    const files = (
      await Promise.all(
        names
          .filter((n) => n.endsWith('.webp'))
          .map(async (n) => {
            const full = path.join(proxyDir, n)
            const st = await fs.stat(full).catch(() => null)
            return st ? { full, size: st.size, atime: st.atimeMs } : null
          })
      )
    ).filter((f): f is { full: string; size: number; atime: number } => f !== null)

    let total = files.reduce((n, f) => n + f.size, 0)
    if (total <= PROXY_CACHE_MAX_BYTES) return
    files.sort((a, b) => a.atime - b.atime) // least recently used first
    for (const f of files) {
      if (total <= PROXY_CACHE_MAX_BYTES) break
      await fs.unlink(f.full).catch(() => {})
      total -= f.size
    }
  } catch {
    /* cache hygiene is best-effort — never block startup on it */
  }
}

interface PhotoRow {
  mtime: number
  width: number | null
  height: number | null
  camera_make: string | null
  camera_model: string | null
  iso: number | null
  aperture: number | null
  shutter: number | null
  focal: number | null
  captured_at: string | null
  thumb: Buffer | null
  rating: number
  flagged: number
}

function rowToMeta(row: PhotoRow | undefined): PhotoMeta | null {
  if (!row || row.width == null || row.height == null) return null
  return {
    width: row.width,
    height: row.height,
    cameraMake: row.camera_make ?? undefined,
    cameraModel: row.camera_model ?? undefined,
    iso: row.iso ?? undefined,
    aperture: row.aperture ?? undefined,
    shutter: row.shutter ?? undefined,
    focalLen: row.focal ?? undefined,
    capturedAt: row.captured_at ?? undefined
  }
}

function ensureRow(filePath: string, mtimeMs: number): void {
  db.prepare('INSERT OR IGNORE INTO photos(path, mtime) VALUES (?, ?)').run(filePath, mtimeMs)
}

function writeMetaAndThumb(filePath: string, mtimeMs: number, meta: PhotoMeta, thumb: Buffer): void {
  ensureRow(filePath, mtimeMs)
  db.prepare(
    `UPDATE photos SET mtime=@mtime, width=@width, height=@height, camera_make=@make,
       camera_model=@model, iso=@iso, aperture=@aperture, shutter=@shutter, focal=@focal,
       captured_at=@captured, thumb=@thumb WHERE path=@path`
  ).run({
    path: filePath,
    mtime: mtimeMs,
    width: meta.width,
    height: meta.height,
    make: meta.cameraMake ?? null,
    model: meta.cameraModel ?? null,
    iso: meta.iso ?? null,
    aperture: meta.aperture ?? null,
    shutter: meta.shutter ?? null,
    focal: meta.focalLen ?? null,
    captured: meta.capturedAt ?? null,
    thumb
  })
}

// ── scan ────────────────────────────────────────────────────────────────────
interface RawEntry {
  filePath: string
  fileName: string
  ext: string
  isRaw: boolean
  mtimeMs: number
  size: number
}

// How many stat() calls to have in flight at once. Awaiting them one by one
// makes the scan latency-bound on a large folder; unbounded fan-out exhausts
// file descriptors. A fixed window gets the throughput without the risk.
const STAT_BATCH = 64

async function walk(dir: string, out: RawEntry[], depth: number): Promise<void> {
  if (depth > 12) return
  let entries: Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return // unreadable directory — skip, never crash the scan
  }
  const subdirs: string[] = []
  const candidates: { full: string; name: string; ext: string }[] = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      subdirs.push(full)
    } else if (e.isFile()) {
      const ext = path.extname(e.name)
      if (isSupportedExt(ext)) candidates.push({ full, name: e.name, ext })
    }
  }
  for (let i = 0; i < candidates.length; i += STAT_BATCH) {
    const slice = candidates.slice(i, i + STAT_BATCH)
    const stats = await Promise.all(
      slice.map((c) => fs.stat(c.full).catch(() => null)) // stat failed — skip file
    )
    for (let j = 0; j < slice.length; j++) {
      const st = stats[j]
      if (!st) continue
      const c = slice[j]
      out.push({
        filePath: c.full,
        fileName: c.name,
        ext: c.ext.toLowerCase(),
        isRaw: isRawExt(c.ext),
        mtimeMs: st.mtimeMs,
        size: st.size
      })
    }
  }
  for (const sub of subdirs) await walk(sub, out, depth + 1)
}

async function scanAsync(folderPath: string): Promise<LibraryPhoto[]> {
  const files: RawEntry[] = []
  await walk(folderPath, files, 0)
  files.sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }))
  const read = db.prepare(
    `SELECT mtime, width, height, camera_make, camera_model, iso, aperture, shutter, focal,
            captured_at, rating, flagged FROM photos WHERE path = ?`
  )
  const insert = db.prepare('INSERT OR IGNORE INTO photos(path, mtime) VALUES (?, ?)')
  // One transaction for the whole folder. Left implicit, each INSERT is its own
  // WAL commit — on a few thousand photos that fsync storm dominates the open.
  const collect = db.transaction((entries: RawEntry[]): LibraryPhoto[] =>
    entries.map((f) => {
      insert.run(f.filePath, f.mtimeMs)
      const row = read.get(f.filePath) as PhotoRow | undefined
      return {
        ...f,
        meta: rowToMeta(row),
        rating: row?.rating ?? 0,
        flagged: !!row?.flagged
      }
    })
  )
  return collect(files)
}

// ── decode ──────────────────────────────────────────────────────────────────
async function stdMeta(filePath: string): Promise<PhotoMeta> {
  const m = await sharp(filePath).metadata()
  let w = m.width ?? 0
  let h = m.height ?? 0
  if (m.orientation && m.orientation >= 5) [w, h] = [h, w]
  return { width: w, height: h }
}

async function decode(filePath: string, longEdge: number): Promise<{ webp: Buffer; meta: PhotoMeta }> {
  const isRaw = isRawExt(path.extname(filePath))
  const quality = longEdge >= PROXY_LONG_EDGE ? 90 : 80

  if (!isRaw) {
    const meta = await stdMeta(filePath)
    const webp = await sharp(filePath)
      .rotate() // honor EXIF orientation
      .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()
    return { webp, meta }
  }

  // RAW: decoded by the hidden Chromium decode window (libraw-wasm), returned as
  // an embedded JPEG (thumbnails) or demosaiced RGB (proxy). We resize+encode.
  const mode: RawDecodeMode = longEdge <= THUMB_LONG_EDGE ? 'thumb' : 'proxy'
  const res = await requestRawFromHost(filePath, mode)

  if (res.thumbJpeg && res.thumbJpeg.length > 0) {
    const jpeg = res.thumbJpeg
    const webp = await sharp(Buffer.from(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength))
      .rotate()
      .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality })
      .toBuffer()
    return { webp, meta: res.meta }
  }

  if (!res.rgb || !res.width || !res.height) throw new Error('decoder returned no pixels')
  const rgb = res.rgb
  const webp = await sharp(Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), {
    raw: { width: res.width, height: res.height, channels: (res.channels ?? 3) as 1 | 3 | 4 }
  })
    .resize(longEdge, longEdge, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality })
    .toBuffer()
  return { webp, meta: res.meta }
}

// A cache hit is a single synchronous SQLite read — it must NOT wait behind the
// decode queue, or reopening a known folder trickles in at decode speed instead
// of appearing at once.
function cachedThumbnail(
  filePath: string,
  mtimeMs: number
): { webp: Buffer; meta: PhotoMeta } | null {
  const row = db
    .prepare(
      `SELECT mtime, width, height, camera_make, camera_model, iso, aperture, shutter, focal,
              captured_at, thumb, rating, flagged FROM photos WHERE path = ?`
    )
    .get(filePath) as PhotoRow | undefined
  if (row?.thumb && row.mtime === mtimeMs && row.width != null) {
    return { webp: row.thumb, meta: rowToMeta(row)! }
  }
  return null
}

async function handleThumbnail(
  filePath: string,
  mtimeMs: number
): Promise<{ webp: Buffer; meta: PhotoMeta }> {
  const hit = cachedThumbnail(filePath, mtimeMs)
  if (hit) return hit
  const { webp, meta } = await decode(filePath, THUMB_LONG_EDGE)
  writeMetaAndThumb(filePath, mtimeMs, meta, webp)
  return { webp, meta }
}

async function handleProxy(
  filePath: string,
  mtimeMs: number
): Promise<{ webp: Buffer; meta: PhotoMeta }> {
  const key = createHash('sha1').update(`${filePath}:${mtimeMs}`).digest('hex')
  const proxyPath = path.join(proxyDir, `${key}.webp`)
  if (fss.existsSync(proxyPath)) {
    const webp = await fs.readFile(proxyPath)
    const row = db
      .prepare(`SELECT mtime, width, height, camera_make, camera_model, iso, aperture, shutter,
                focal, captured_at, rating, flagged FROM photos WHERE path = ?`)
      .get(filePath) as PhotoRow | undefined
    const meta = rowToMeta(row) ?? (await stdMeta(filePath).catch(() => ({ width: 0, height: 0 })))
    return { webp, meta }
  }
  const { webp, meta } = await decode(filePath, PROXY_LONG_EDGE)
  await fs.writeFile(proxyPath, webp)
  return { webp, meta }
}

// ── sequential decode queue (proxy = priority) ──────────────────────────────
interface Job {
  run: () => Promise<void>
  priority: boolean
}
const queue: Job[] = []
// Bounded concurrency: a little parallelism speeds folder loading, but stays
// small so RAW decodes (each a libraw worker) can't fan out into an OOM. Scaled
// to the machine within a hard 2..4 band.
const MAX_CONCURRENCY = Math.min(4, Math.max(2, CPUS >> 1))
let active = 0

function enqueue(job: Job): void {
  if (job.priority) queue.unshift(job)
  else queue.push(job)
  pump()
}

function pump(): void {
  while (active < MAX_CONCURRENCY && queue.length) {
    const job = queue.shift()!
    active++
    job
      .run()
      .catch(() => {
        /* job posts its own error */
      })
      .finally(() => {
        active--
        pump()
      })
  }
}

// ── message loop ────────────────────────────────────────────────────────────
parentPort.on('message', (e) => {
  const msg = e.data
  switch (msg.kind) {
    case 'init':
      initCache(msg.cacheDir)
      post({ kind: 'ready' })
      break

    case 'scan':
      scanAsync(msg.folderPath)
        .then((entries) => post({ kind: 'scan:result', requestId: msg.requestId, entries }))
        .catch((err) =>
          post({ kind: 'error', requestId: msg.requestId, message: describe(err) })
        )
      break

    case 'thumbnail': {
      // Fast path: already cached → answer now, never queue.
      const hit = cachedThumbnail(msg.filePath, msg.mtimeMs)
      if (hit) {
        post({
          kind: 'thumbnail:result',
          requestId: msg.requestId,
          filePath: msg.filePath,
          webp: new Uint8Array(hit.webp),
          meta: hit.meta
        })
        break
      }
      enqueue({
        priority: false,
        run: async () => {
          try {
            const { webp, meta } = await handleThumbnail(msg.filePath, msg.mtimeMs)
            post({
              kind: 'thumbnail:result',
              requestId: msg.requestId,
              filePath: msg.filePath,
              webp: new Uint8Array(webp),
              meta
            })
          } catch (err) {
            post({ kind: 'error', requestId: msg.requestId, message: describe(err) })
          }
        }
      })
      break
    }

    case 'proxy':
      enqueue({
        priority: true,
        run: async () => {
          try {
            const { webp, meta } = await handleProxy(msg.filePath, msg.mtimeMs)
            post({
              kind: 'proxy:result',
              requestId: msg.requestId,
              filePath: msg.filePath,
              webp: new Uint8Array(webp),
              meta
            })
          } catch (err) {
            post({ kind: 'error', requestId: msg.requestId, message: describe(err) })
          }
        }
      })
      break

    case 'setRating':
      ensureRow(msg.filePath, Date.now())
      db.prepare('UPDATE photos SET rating = ? WHERE path = ?').run(msg.rating, msg.filePath)
      post({ kind: 'ack', requestId: msg.requestId })
      break

    case 'setFlag':
      ensureRow(msg.filePath, Date.now())
      db.prepare('UPDATE photos SET flagged = ? WHERE path = ?').run(
        msg.flagged ? 1 : 0,
        msg.filePath
      )
      post({ kind: 'ack', requestId: msg.requestId })
      break

    case 'host:decodeRaw:result': {
      const p = rawPending.get(msg.requestId)
      if (p) {
        rawPending.delete(msg.requestId)
        p.resolve(msg.result)
      }
      break
    }

    case 'host:decodeRaw:error': {
      const p = rawPending.get(msg.requestId)
      if (p) {
        rawPending.delete(msg.requestId)
        p.reject(new Error(msg.message))
      }
      break
    }
  }
})

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
