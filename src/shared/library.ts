// Shared library/decoding contract — used by the decode utility process, the
// main process manager, the preload bridge, and the renderer. No pixel data,
// paths, or EXIF ever leaves the device; these types only cross in-process IPC.

export const RAW_EXTENSIONS = [
  '.cr2',
  '.cr3',
  '.nef',
  '.arw',
  '.dng',
  '.raf',
  '.orf',
  '.rw2',
  '.pef',
  '.srw',
  '.raw',
  '.3fr',
  '.erf',
  '.mrw',
  '.nrw'
]

export const STD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.tif', '.tiff', '.heic', '.heif', '.webp']

export const SUPPORTED_EXTENSIONS = [...RAW_EXTENSIONS, ...STD_EXTENSIONS]

export function isRawExt(ext: string): boolean {
  return RAW_EXTENSIONS.includes(ext.toLowerCase())
}
export function isSupportedExt(ext: string): boolean {
  return SUPPORTED_EXTENSIONS.includes(ext.toLowerCase())
}

/** Long-edge targets. Previews render from the proxy; full-res is export-only. */
export const PROXY_LONG_EDGE = 2560
export const THUMB_LONG_EDGE = 400

export interface PhotoMeta {
  width: number
  height: number
  cameraMake?: string
  cameraModel?: string
  iso?: number
  aperture?: number
  shutter?: number
  focalLen?: number
  /** ISO-8601 capture timestamp when known. */
  capturedAt?: string
}

/** One scanned file plus its persisted rating/flag/metadata. */
export interface LibraryPhoto {
  filePath: string
  fileName: string
  ext: string
  isRaw: boolean
  mtimeMs: number
  size: number
  meta: PhotoMeta | null
  rating: number
  flagged: boolean
}

/** Map a libraw-wasm metadata object to our PhotoMeta. Shared by the decode
 *  window (which runs libraw) and any consumer of its output. */
export function mapLibrawMeta(m: Record<string, unknown>): PhotoMeta {
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' && isFinite(v) && v !== 0 ? v : undefined
  const str = (v: unknown): string | undefined => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s.length ? s : undefined
  }
  let capturedAt: string | undefined
  const ts = m.timestamp
  if (ts) {
    const d = ts instanceof Date ? ts : new Date(ts as string | number)
    if (!isNaN(d.getTime()) && d.getFullYear() > 1970) capturedAt = d.toISOString()
  }
  return {
    width: Number(m.width) || 0,
    height: Number(m.height) || 0,
    cameraMake: str(m.camera_make),
    cameraModel: str(m.camera_model),
    iso: num(m.iso_speed),
    aperture: num(m.aperture),
    shutter: num(m.shutter),
    focalLen: num(m.focal_len),
    capturedAt
  }
}

// ── RAW decode-window contract (host ⇄ hidden Chromium decoder) ──────────────
export type RawDecodeMode = 'thumb' | 'proxy'

/** Result of decoding a RAW in the decode window. For thumbnails an embedded
 *  JPEG may be returned instead of RGB; otherwise raw RGB pixels + dimensions. */
export interface RawDecodeResult {
  meta: PhotoMeta
  /** Demosaiced RGB (proxy path, or thumb fallback when no embedded JPEG). */
  rgb?: Uint8Array
  width?: number
  height?: number
  channels?: number
  /** Embedded JPEG preview (fast thumbnail path). */
  thumbJpeg?: Uint8Array
}

// ── Decode worker message protocol ──────────────────────────────────────────
export type WorkerRequest =
  | { kind: 'init'; cacheDir: string }
  | { kind: 'scan'; requestId: string; folderPath: string }
  | { kind: 'thumbnail'; requestId: string; filePath: string; mtimeMs: number }
  | { kind: 'proxy'; requestId: string; filePath: string; mtimeMs: number }
  | { kind: 'setRating'; requestId: string; filePath: string; rating: number }
  | { kind: 'setFlag'; requestId: string; filePath: string; flagged: boolean }
  // Replies to the worker's host:decodeRaw requests (RAW decoded in the window).
  | { kind: 'host:decodeRaw:result'; requestId: string; result: RawDecodeResult }
  | { kind: 'host:decodeRaw:error'; requestId: string; message: string }

export type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'scan:result'; requestId: string; entries: LibraryPhoto[] }
  | {
      kind: 'thumbnail:result'
      requestId: string
      filePath: string
      webp: Uint8Array
      meta: PhotoMeta
    }
  | { kind: 'proxy:result'; requestId: string; filePath: string; webp: Uint8Array; meta: PhotoMeta }
  | { kind: 'ack'; requestId: string }
  | { kind: 'error'; requestId: string; message: string }
  // Worker asks the host to decode a RAW in the hidden Chromium decode window.
  | { kind: 'host:decodeRaw'; requestId: string; filePath: string; mode: RawDecodeMode }
