import { app, BrowserWindow, ipcMain, utilityProcess, type UtilityProcess } from 'electron'
import { existsSync } from 'node:fs'
import { assertTrustedSender } from './file-policy'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import type { DenoiseResult, OnnxWorkerRequest, OnnxWorkerResponse } from '../shared/ai'
import { RESTORATION_MODEL, RESTORATION_MODEL_FINGERPRINT } from '../shared/ai'
import { ModelIntegrity } from './model-integrity'
import { workerReadiness } from './worker-readiness'
import { acquireHeavyInference } from './inference-gate'

// Owns the ONNX inference utility process and bridges it to the renderer. All
// onnxruntime-node work happens in the forked process; this file only routes.
// Everything is on-device — no pixels or paths ever leave the machine.

let worker: UtilityProcess | null = null
let ready: Promise<void> | null = null
let startup: { worker: UtilityProcess; settle: (error?: Error) => void } | null = null

interface Pending {
  resolve: (v: DenoiseResult) => void
  timer: ReturnType<typeof setTimeout>
  modelFingerprint: string
}
const pending = new Map<string, Pending>()

// The forked process holds the ~112MiB model + ORT session in memory. Inference
// is occasional, so release the whole process after a quiet minute — the next
// request re-forks and reloads (~1s), a fine trade for a flat memory profile.
const IDLE_SHUTDOWN_MS = 60_000
let idleTimer: ReturnType<typeof setTimeout> | null = null
function scheduleIdleShutdown(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (pending.size === 0 && worker) {
      console.log('[onnx] idle — releasing inference process')
      const idleWorker = worker
      worker = null
      ready = null
      startup?.settle(new Error('사용하지 않는 모델 프로세스를 종료했습니다.'))
      idleWorker.kill()
    }
  }, IDLE_SHUTDOWN_MS)
}

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

// The model isn't bundled (it's large); resolve it from userData first, then the
// app's models/ folder (dev). Missing model → callers degrade gracefully.
export function resolveModelPath(): string | null {
  const candidates = [
    path.join(app.getPath('userData'), 'models', RESTORATION_MODEL.filename),
    path.join(app.getAppPath(), 'models', RESTORATION_MODEL.filename),
    path.join(process.resourcesPath ?? '', 'models', RESTORATION_MODEL.filename)
  ]
  return candidates.find((p) => p && existsSync(p)) ?? null
}

function routeMessage(msg: OnnxWorkerResponse): void {
  switch (msg.type) {
    case 'ready':
      return
    case 'denoise:progress':
      broadcast(IpcChannels.ai.progress, { requestId: msg.requestId, progress: msg.progress })
      return
    case 'denoise:result': {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        clearTimeout(p.timer)
        if (pending.size === 0) scheduleIdleShutdown()
        p.resolve({
          ok: true,
          rgba: msg.rgba,
          width: msg.width,
          height: msg.height,
          provider: msg.provider,
          fellBack: msg.fellBack,
          modelFingerprint: p.modelFingerprint
        })
      }
      return
    }
    case 'denoise:error': {
      const p = pending.get(msg.requestId)
      if (p) {
        pending.delete(msg.requestId)
        clearTimeout(p.timer)
        if (pending.size === 0) scheduleIdleShutdown()
        p.resolve({ ok: false, message: msg.message })
      }
      return
    }
  }
}

function ensureWorker(): Promise<void> {
  if (worker && ready) return ready
  const workerPath = path.join(__dirname, 'onnx.worker.js')
  const launched = utilityProcess.fork(workerPath, [], {
    serviceName: 'luxinus-onnx',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  worker = launched
  const launchGeneration = generation
  const readiness = workerReadiness(15_000, () => {
    // A stale launch timer may never terminate a replacement process.
    if (worker === launched && generation === launchGeneration) {
      worker = null
      ready = null
      if (startup?.worker === launched) startup = null
      launched.kill()
    }
  })
  const settle = (error?: Error): void => {
    if (startup?.worker === launched) startup = null
    readiness.settle(error)
  }
  ready = readiness.ready
  startup = { worker: launched, settle }
  launched.stderr?.on('data', (d) => console.error('[onnx]', d.toString().trimEnd()))
  launched.stdout?.on('data', (d) => console.log('[onnx]', d.toString().trimEnd()))
  launched.on('message', (msg: OnnxWorkerResponse) => {
    if (worker !== launched || generation !== launchGeneration) return
    if (msg.type === 'ready') settle()
    else routeMessage(msg)
  })
  launched.on('exit', (code) => {
    settle(new Error('모델 프로세스가 준비되기 전에 종료되었습니다.'))
    if (worker !== launched) return
    console.warn('[onnx] worker exited', code)
    worker = null
    ready = null
    // Fail anything in flight gracefully so the UI recovers (degrade, never crash).
    for (const [id, p] of pending) {
      pending.delete(id)
      clearTimeout(p.timer)
      p.resolve({ ok: false, message: '모델 프로세스가 종료되었습니다.' })
    }
  })
  return ready
}

const integrity = new ModelIntegrity()
let busy = false
let generation = 0
export function getRestorationGeneration(): number { return generation }
export async function getRestorationModelFingerprint(): Promise<string | null> {
  return await validateRestorationModel() ? RESTORATION_MODEL_FINGERPRINT : null
}
export async function validateRestorationModel(): Promise<string | null> {
  const modelPath = resolveModelPath()
  if (!modelPath) return null
  await integrity.verify(modelPath, RESTORATION_MODEL.sha256)
  return modelPath
}

export async function runRestoration(payload: { rgba: Uint8Array; width: number; height: number; strength: number }): Promise<DenoiseResult> {
  if (busy) return { ok: false, message: '다른 노이즈 제거 작업이 실행 중입니다. 완료 후 다시 시도하세요.' }
  const { width, height, rgba, strength } = payload
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 40_000_000 || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4 || !Number.isFinite(strength) || strength < 0 || strength > 100) {
    return { ok: false, message: '복원 입력 크기 또는 강도가 유효하지 않습니다(최대 40MP).' }
  }
  const release = acquireHeavyInference('restoration')
  if (!release) return { ok: false, message: '인물 분석 작업이 실행 중입니다. 완료 후 노이즈 제거를 다시 시도하세요.' }
  busy = true
  const requestGeneration = generation
  try {
    const modelPath = await validateRestorationModel()
    if (!modelPath) return { ok: false, message: 'NAFNet SIDD 노이즈 제거 모델이 설치되지 않았습니다.' }
    if (requestGeneration !== generation) return { ok: false, message: '노이즈 제거가 취소되었습니다.' }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
    await ensureWorker()
    if (requestGeneration !== generation) return { ok: false, message: '노이즈 제거가 취소되었습니다.' }
    if (!worker) return { ok: false, message: '모델 프로세스를 시작하지 못했습니다.' }
    const requestId = randomUUID()
    const req: OnnxWorkerRequest = { type: 'denoise', requestId, modelPath, modelFingerprint: RESTORATION_MODEL_FINGERPRINT, ...payload }
    return await new Promise<DenoiseResult>((resolve) => {
      const timer = setTimeout(() => shutdownAi(), 300_000)
      pending.set(requestId, { resolve, timer, modelFingerprint: RESTORATION_MODEL_FINGERPRINT })
      worker!.postMessage(req)
    })
  } catch (error) {
    return { ok: false, message: (error as Error).message }
  } finally { busy = false; release() }
}

export function registerAiHandlers(): void {
  ipcMain.handle(IpcChannels.ai.status, async (event) => {
    assertTrustedSender(event)
    try {
      const modelFingerprint = await getRestorationModelFingerprint()
      return { modelAvailable: modelFingerprint !== null, role: 'rgb-denoise', model: RESTORATION_MODEL.id, modelFingerprint, loaded: !!worker, message: null }
    } catch (error) { return { modelAvailable: false, message: (error as Error).message } }
  })
  ipcMain.handle(IpcChannels.ai.denoise, (event, payload) => { assertTrustedSender(event); return runRestoration(payload) })
  ipcMain.handle(IpcChannels.ai.cancel, (event) => { assertTrustedSender(event); shutdownAi(); return true })
}

export function shutdownAi(): void {
  generation++
  // Wake requests awaiting startup now, rather than after the old timeout.
  startup?.settle(new Error('노이즈 제거가 취소되었습니다.'))
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.resolve({ ok: false, message: '노이즈 제거가 취소되었습니다.' })
    pending.delete(id)
  }
  const stopped = worker
  worker = null
  ready = null
  stopped?.kill()
}
