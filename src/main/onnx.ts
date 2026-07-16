import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import type { DenoiseResult, OnnxWorkerRequest, OnnxWorkerResponse } from '../shared/ai'

// Owns the ONNX inference utility process and bridges it to the renderer. All
// onnxruntime-node work happens in the forked process; this file only routes.
// Everything is on-device — no pixels or paths ever leave the machine.

let worker: UtilityProcess | null = null
let ready: Promise<void> | null = null
let readyResolve: (() => void) | null = null

interface Pending {
  resolve: (v: DenoiseResult) => void
}
const pending = new Map<string, Pending>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// The model isn't bundled (it's large); resolve it from userData first, then the
// app's models/ folder (dev). Missing model → callers degrade gracefully.
export function resolveModelPath(): string | null {
  const candidates = [
    path.join(app.getPath('userData'), 'models', 'nafnet.onnx'),
    path.join(app.getAppPath(), 'models', 'nafnet.onnx'),
    path.join(process.resourcesPath ?? '', 'models', 'nafnet.onnx')
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function routeMessage(msg: OnnxWorkerResponse): void {
  switch (msg.type) {
    case 'ready':
      readyResolve?.()
      return
    case 'denoise:progress':
      broadcast(IpcChannels.ai.progress, { requestId: msg.requestId, progress: msg.progress })
      return
    case 'denoise:result': {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        p.resolve({
          ok: true,
          rgba: msg.rgba,
          width: msg.width,
          height: msg.height,
          provider: msg.provider,
          fellBack: msg.fellBack
        })
      }
      return
    }
    case 'denoise:error': {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        p.resolve({ ok: false, message: msg.message })
      }
      return
    }
  }
}

function ensureWorker(): Promise<void> {
  if (worker && ready) return ready
  const workerPath = path.join(__dirname, 'onnx.worker.js')
  worker = utilityProcess.fork(workerPath, [], {
    serviceName: 'luxinus-onnx',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  worker.stderr?.on('data', (d) => console.error('[onnx]', d.toString().trimEnd()))
  worker.stdout?.on('data', (d) => console.log('[onnx]', d.toString().trimEnd()))
  worker.on('message', (msg: OnnxWorkerResponse) => routeMessage(msg))
  worker.on('exit', (code) => {
    console.warn('[onnx] worker exited', code)
    worker = null
    ready = null
    // Fail anything in flight gracefully so the UI recovers (degrade, never crash).
    for (const [id, p] of pending) {
      pending.delete(id)
      p.resolve({ ok: false, message: 'Inference process stopped.' })
    }
  })
  ready = new Promise<void>((resolve) => {
    readyResolve = resolve
  })
  return ready
}

export function registerAiHandlers(): void {
  ipcMain.handle(IpcChannels.ai.status, () => ({ modelAvailable: resolveModelPath() !== null }))

  ipcMain.handle(
    IpcChannels.ai.denoise,
    async (
      _e,
      payload: { rgba: Uint8Array; width: number; height: number; strength: number }
    ): Promise<DenoiseResult> => {
      const modelPath = resolveModelPath()
      if (!modelPath) {
        // Graceful: no model on disk → tell the UI so it can hint, don't error.
        return { ok: false, fellBack: true, message: 'Denoise model not installed.' }
      }
      await ensureWorker()
      const requestId = randomUUID()
      const req: OnnxWorkerRequest = {
        type: 'denoise',
        requestId,
        modelPath,
        rgba: payload.rgba,
        width: payload.width,
        height: payload.height,
        strength: payload.strength
      }
      return new Promise<DenoiseResult>((resolve) => {
        pending.set(requestId, { resolve })
        worker!.postMessage(req)
      })
    }
  )
}

export function shutdownAi(): void {
  worker?.kill()
  worker = null
  ready = null
}
