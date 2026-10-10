import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import { PORTRAIT_REGIONS, type PortraitInferenceInput, type PortraitInferenceResult } from '../shared/portrait'
import { PORTRAIT_MODEL_FINGERPRINT } from '../shared/portrait-model'
import { resolvePortraitModels } from './portrait-model'
import { workerReadiness } from './worker-readiness'
import { acquireHeavyInference } from './inference-gate'
export { getPortraitModelFingerprint } from './portrait-model'

let worker: UtilityProcess | null = null
let ready: Promise<void> | null = null
let startup: ((error?: Error) => void) | null = null
let generation = 0
let busy = false
let idle: ReturnType<typeof setTimeout> | null = null
let pending: { id: string; resolve: (result: PortraitInferenceResult) => void; timer: ReturnType<typeof setTimeout> } | null = null
export const getPortraitGeneration = (): number => generation
export const isPortraitModelBusy = (): boolean => busy

export function cancelPortraitSegmentation(): void {
  generation++
  startup?.(new Error('인물 분석을 취소했습니다.'))
  startup = null
  if (pending) { clearTimeout(pending.timer); pending.resolve({ ok: false, message: '인물 분석을 취소했습니다.' }); pending = null }
  if (idle) clearTimeout(idle)
  idle = null
  const stopped = worker
  worker = null; ready = null
  stopped?.kill()
}

function ensureWorker(): Promise<void> {
  if (worker && ready) return ready
  const current = utilityProcess.fork(path.join(__dirname, 'portrait.worker.js'), [], { serviceName: 'luxinus-portrait', stdio: ['ignore', 'pipe', 'pipe'] })
  worker = current
  const expected = generation
  const readiness = workerReadiness(15_000, () => { if (worker === current && generation === expected) cancelPortraitSegmentation() })
  ready = readiness.ready; startup = readiness.settle
  current.stderr?.on('data', bytes => console.error('[portrait]', bytes.toString().trimEnd()))
  current.on('message', (message: { type: string; requestId?: string; result?: PortraitInferenceResult }) => {
    if (worker !== current || generation !== expected) return
    if (message.type === 'ready') { readiness.settle(); startup = null }
    else if (message.type === 'result' && pending && pending.id === message.requestId && message.result) {
      clearTimeout(pending.timer); pending.resolve(message.result); pending = null
      idle = setTimeout(() => { if (!busy && worker === current) cancelPortraitSegmentation() }, 60_000)
    }
  })
  current.on('exit', () => {
    readiness.settle(new Error('인물 모델 프로세스가 종료되었습니다.'))
    if (worker !== current) return
    worker = null; ready = null; startup = null
    if (pending) { clearTimeout(pending.timer); pending.resolve({ ok: false, message: '인물 모델 프로세스가 종료되었습니다.' }); pending = null }
  })
  return ready
}

export async function runPortraitSegmentation(input: PortraitInferenceInput): Promise<PortraitInferenceResult> {
  if (busy) return { ok: false, message: '다른 인물 분석이 실행 중입니다.' }
  if (!input || !(input.rgba instanceof Uint8Array) || !Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1 || input.width > 2048 || input.height > 2048 || input.width * input.height > 4_194_304 || input.rgba.length !== input.width * input.height * 4 || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId) || (input.regions && (!Array.isArray(input.regions) || input.regions.length > PORTRAIT_REGIONS.length || input.regions.some(region => !PORTRAIT_REGIONS.includes(region))))) return { ok: false, message: '인물 분석 입력이 유효하지 않습니다.' }
  const release = acquireHeavyInference('portrait')
  if (!release) return { ok: false, message: '노이즈 제거 작업이 실행 중입니다. 완료 후 인물 분석을 다시 시도하세요.' }
  busy = true
  const expected = generation
  try {
    const modelPaths = await resolvePortraitModels()
    if (!modelPaths) return { ok: false, message: '로컬 인물 분석 모델이 설치되지 않았습니다.' }
    if (generation !== expected) return { ok: false, message: '인물 분석을 취소했습니다.' }
    if (idle) clearTimeout(idle)
    idle = null
    await ensureWorker()
    if (generation !== expected || !worker) return { ok: false, message: '인물 분석을 취소했습니다.' }
    return await new Promise(resolve => {
      pending = { id: input.requestId, resolve, timer: setTimeout(cancelPortraitSegmentation, 180_000) }
      try { worker!.postMessage({ type: 'analyze', input, modelPaths, modelFingerprint: PORTRAIT_MODEL_FINGERPRINT }) }
      catch (error) {
        clearTimeout(pending.timer); pending = null
        resolve({ ok: false, message: (error as Error).message })
        cancelPortraitSegmentation()
      }
    })
  } catch (error) { return { ok: false, message: (error as Error).message } }
  finally { busy = false; release() }
}
