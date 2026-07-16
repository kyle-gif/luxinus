import { app, BrowserWindow, dialog, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import type { LibraryPhoto, PhotoMeta, WorkerRequest, WorkerResponse } from '../shared/library'
import { decodeRawViaWindow, warmupDecodeWindow } from './decode-window'

// Owns the decode utility process and bridges it to the renderer over IPC.
// All heavy work happens in the forked process; this file only routes messages.

let worker: UtilityProcess | null = null
let readyResolve: (() => void) | null = null
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
      readyResolve?.()
      return
    case 'thumbnail:result':
      // Streamed to the renderer as each thumbnail finishes decoding.
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
      decodeRawViaWindow(msg.filePath, msg.mode)
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
  worker.stderr?.on('data', (d) => console.error('[decode]', d.toString().trimEnd()))
  worker.stdout?.on('data', (d) => console.log('[decode]', d.toString().trimEnd()))
  worker.on('message', (msg: WorkerResponse) => routeMessage(msg))
  worker.on('exit', (code) => {
    console.warn('[decode] worker exited', code)
    worker = null
    ready = null
    // Reject anything still in flight so the UI can recover.
    for (const [id, p] of pending) {
      pending.delete(id)
      p.reject(new Error('Decode process stopped unexpectedly.'))
    }
  })

  ready = new Promise<void>((resolve) => {
    readyResolve = resolve
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

async function scanFolder(folderPath: string): Promise<LibraryPhoto[]> {
  const entries = await request<LibraryPhoto[]>({
    kind: 'scan',
    requestId: randomUUID(),
    folderPath
  })
  // Pre-warm the RAW decode window while the user browses, so the first RAW
  // selection is snappy instead of paying window-creation latency.
  if (entries.some((e) => e.isRaw)) warmupDecodeWindow()
  // Kick off thumbnail generation for every photo; results stream to the
  // renderer via the thumbnailReady channel as the queue works through them.
  for (const e of entries) {
    void request({ kind: 'thumbnail', requestId: randomUUID(), filePath: e.filePath, mtimeMs: e.mtimeMs })
      .catch(() => {
        /* per-thumbnail failures are non-fatal; the grid keeps its placeholder */
      })
  }
  return entries
}

export function registerLibraryHandlers(): void {
  ipcMain.handle(IpcChannels.library.openFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Open photo folder',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) {
      return { canceled: true, folderPath: null, photos: [] as LibraryPhoto[] }
    }
    const folderPath = result.filePaths[0]
    const photos = await scanFolder(folderPath)
    return { canceled: false, folderPath, photos }
  })

  ipcMain.handle(
    IpcChannels.library.requestProxy,
    async (_e, filePath: string, mtimeMs: number) => {
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
    async (_e, filePath: string, rating: number) => {
      await request({ kind: 'setRating', requestId: randomUUID(), filePath, rating })
      return true
    }
  )

  ipcMain.handle(
    IpcChannels.library.setFlag,
    async (_e, filePath: string, flagged: boolean) => {
      await request({ kind: 'setFlag', requestId: randomUUID(), filePath, flagged })
      return true
    }
  )
}

export function shutdownLibrary(): void {
  worker?.kill()
  worker = null
  ready = null
}
