import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import type { LibraryPhoto, PhotoMeta, WorkerRequest, WorkerResponse } from '../shared/library'
import { decodeRawViaWindow, warmupDecodeWindow } from './decode-window'
import { assertAuthorizedPhoto, assertTrustedSender, authorizeLibraryFolder, authorizeLibraryPhotos } from './file-policy'

// Owns the decode utility process and bridges it to the renderer over IPC.
// All heavy work happens in the forked process; this file only routes messages.

let worker: UtilityProcess | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((error: Error) => void) | null = null
let readyTimer: ReturnType<typeof setTimeout> | null = null
let ready: Promise<void> | null = null

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}
const pending = new Map<string, Pending>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function routeMessage(msg: WorkerResponse): void {
  switch (msg.kind) {
    case 'ready':
      if (readyTimer) clearTimeout(readyTimer)
      readyTimer = null
      readyResolve?.()
      readyReject = null
      return
    case 'thumbnail:result':
      // Streamed to the renderer as each thumbnail finishes decoding. Settle the
      // in-flight entry too — otherwise every thumbnail ever requested stays in
      // `pending` for the life of the process (one leak per photo per folder).
      settle(msg.requestId, true)
      broadcast(IpcChannels.library.thumbnailReady, {
        filePath: msg.filePath,
        webp: msg.webp,
        meta: msg.meta
      })
      return
    case 'scan:result':
      settle(msg.requestId, msg.entries)
      return
    case 'proxy:result':
      settle(msg.requestId, { webp: msg.webp, meta: msg.meta })
      return
    case 'ack':
      settle(msg.requestId, true)
      return
    case 'error':
      fail(msg.requestId, msg.message)
      return
    case 'host:decodeRaw':
      // The worker needs a RAW decoded; route it to the hidden decode window.
      assertAuthorizedPhoto(msg.filePath).then((photo) => decodeRawViaWindow(photo, msg.mode))
        .then((result) =>
          worker?.postMessage({ kind: 'host:decodeRaw:result', requestId: msg.requestId, result })
        )
        .catch((err: Error) =>
          worker?.postMessage({
            kind: 'host:decodeRaw:error',
            requestId: msg.requestId,
            message: err.message
          })
        )
      return
  }
}

function settle(requestId: string, value: unknown): void {
  const p = pending.get(requestId)
  if (p) {
    pending.delete(requestId)
    p.resolve(value)
  }
}
function fail(requestId: string, message: string): void {
  const p = pending.get(requestId)
  if (p) {
    pending.delete(requestId)
    p.reject(new Error(message))
  }
}

function ensureWorker(): Promise<void> {
  if (worker && ready) return ready
  const workerPath = path.join(__dirname, 'decode.worker.js')
  worker = utilityProcess.fork(workerPath, [], {
    serviceName: 'luxinus-decode',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const launched = worker
  worker.stderr?.on('data', (d) => console.error('[decode]', d.toString().trimEnd()))
  worker.stdout?.on('data', (d) => console.log('[decode]', d.toString().trimEnd()))
  worker.on('message', (msg: WorkerResponse) => { if (worker === launched) routeMessage(msg) })
  worker.on('exit', (code) => {
    if (worker !== launched) return
    console.warn('[decode] worker exited', code)
    readyReject?.(new Error('사진 디코딩 프로세스를 시작하지 못했습니다. 폴더를 다시 열어 주세요.'))
    readyReject = null
    if (readyTimer) clearTimeout(readyTimer)
    readyTimer = null
    worker = null
    ready = null
    // Reject anything still in flight so the UI can recover.
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(new Error('Decode process stopped unexpectedly.'))
    }
  })

  ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve
    readyReject = reject
    readyTimer = setTimeout(() => {
      if (worker !== launched) return
      reject(new Error('사진 디코딩 프로세스 시작 시간이 초과되었습니다.'))
      launched.kill()
      worker = null
      ready = null
      readyReject = null
      readyTimer = null
    }, 20000)
  })
  const req: WorkerRequest = { kind: 'init', cacheDir: path.join(app.getPath('userData'), 'cache') }
  worker.postMessage(req)
  return ready
}

async function request<T>(req: Extract<WorkerRequest, { requestId: string }>): Promise<T> {
  await ensureWorker()
  return new Promise<T>((resolve, reject) => {
    pending.set(req.requestId, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage(req)
  })
}

// Fire-and-forget: the reply reaches the renderer over a broadcast channel, so
// there is no promise to keep. Used for thumbnails, where tracking one pending
// entry per photo would cost memory for nothing.
async function notify(req: Extract<WorkerRequest, { requestId: string }>): Promise<void> {
  await ensureWorker()
  worker?.postMessage(req)
}

async function scanFolder(folderPath: string): Promise<LibraryPhoto[]> {
  const scanned = await request<LibraryPhoto[]>({
    kind: 'scan',
    requestId: randomUUID(),
    folderPath
  })
  const entries = await authorizeLibraryPhotos(folderPath, scanned)
  // Pre-warm the RAW decode window while the user browses, so the first RAW
  // selection is snappy instead of paying window-creation latency.
  if (entries.some((e) => e.isRaw)) warmupDecodeWindow()
  // Kick off thumbnail generation for every photo; results stream to the
  // renderer via the thumbnailReady channel as the queue works through them.
  for (const e of entries) {
    // Non-fatal by design: a failed thumbnail just leaves its grid placeholder.
    void notify({
      kind: 'thumbnail',
      requestId: randomUUID(),
      filePath: e.filePath,
      mtimeMs: e.mtimeMs
    }).catch((error: Error) => console.error('[thumbnail]', e.fileName, error.message))
  }
  return entries
}

export function registerLibraryHandlers(): void {
  ipcMain.handle(IpcChannels.library.openFolder, async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog({
      title: '사진 폴더 열기',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, folderPath: null, photos: [] as LibraryPhoto[] }
    }
    const folderPath = await authorizeLibraryFolder(result.filePaths[0])
    const photos = await scanFolder(folderPath)
    return { canceled: false, folderPath, photos }
  })

  ipcMain.handle(
    IpcChannels.library.requestProxy,
    async (event, filePath: string, mtimeMs: number) => {
      assertTrustedSender(event)
      filePath = await assertAuthorizedPhoto(filePath)
      if (!Number.isFinite(mtimeMs) || mtimeMs < 0) throw new Error('파일 수정 시간이 유효하지 않습니다.')
      return request<{ webp: Uint8Array; meta: PhotoMeta }>({
        kind: 'proxy',
        requestId: randomUUID(),
        filePath,
        mtimeMs
      })
    }
  )

  ipcMain.handle(
    IpcChannels.library.setRating,
    async (event, filePath: string, rating: number) => {
      assertTrustedSender(event)
      filePath = await assertAuthorizedPhoto(filePath)
      if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new Error('별점은 0~5의 정수여야 합니다.')
      await request({ kind: 'setRating', requestId: randomUUID(), filePath, rating })
      return true
    }
  )

  ipcMain.handle(
    IpcChannels.library.setFlag,
    async (event, filePath: string, flagged: boolean) => {
      assertTrustedSender(event)
      filePath = await assertAuthorizedPhoto(filePath)
      if (typeof flagged !== 'boolean') throw new Error('플래그 값이 유효하지 않습니다.')
      await request({ kind: 'setFlag', requestId: randomUUID(), filePath, flagged })
      return true
    }
  )
}

export function shutdownLibrary(): void {
  readyReject?.(new Error('사진 디코딩이 중단되었습니다.'))
  readyReject = null
  readyResolve = null
  if (readyTimer) clearTimeout(readyTimer)
  readyTimer = null
  for (const [id, item] of pending) {
    pending.delete(id)
    item.reject(new Error('사진 디코딩이 중단되었습니다.'))
  }
  worker?.kill()
  worker = null
  ready = null
}
