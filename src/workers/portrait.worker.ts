import type { PortraitInferenceInput, PortraitInferenceResult } from '../shared/portrait'
import { PORTRAIT_MODEL_FINGERPRINT, type PortraitModelPaths } from '../shared/portrait-model'
import { inferPortrait } from './portrait-inference'

const parent = (process as unknown as { parentPort?: NodeJS.EventEmitter & { postMessage(message: unknown): void } }).parentPort
interface Request { type: 'analyze'; input: PortraitInferenceInput; modelPaths: PortraitModelPaths; modelFingerprint: string }
let busy = false
parent?.on('message', (event: { data?: Request } | Request) => {
  const request = ('data' in event ? event.data : event) as Request | undefined
  if (request?.type !== 'analyze') return
  const send = (result: PortraitInferenceResult): void => parent.postMessage({ type: 'result', requestId: request.input.requestId, result })
  if (busy || request.modelFingerprint !== PORTRAIT_MODEL_FINGERPRINT) { send({ ok: false, message: '인물 모델 요청 상태가 올바르지 않습니다.' }); return }
  busy = true
  inferPortrait(request.input, request.modelPaths).then(send, error => send({ ok: false, message: (error as Error).message })).finally(() => { busy = false })
})
parent?.postMessage({ type: 'ready' })
