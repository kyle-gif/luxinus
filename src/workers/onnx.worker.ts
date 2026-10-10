// ONNX inference utility process (Phase 6).
//
// Owns ALL onnxruntime-node work so inference never blocks main/renderer. The
// OOM-avoidance architecture lives here:
//   • tiled inference (fixed square tiles, reflect-padded, cosine-blended)
//   • provider probing → CoreML / DirectML / CUDA with CPU fallback
//   • sequential sessions: exactly one ONNX session alive at a time
//   • fixed 768px SIDD graph: report OOM instead of fabricating a result
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  RESTORATION_MODEL,
  RESTORATION_MODEL_FINGERPRINT,
  RESTORATION_SESSION_OPTIONS,
  type ExecutionProvider,
  type OnnxWorkerRequest,
  type OnnxWorkerResponse
} from '../shared/ai'
import { planarToRgba, rgbaToPlanar, runTiled } from './lib/tiledInference'

// eslint-disable-next-line @typescript-eslint/no-require-imports

const ort = require('onnxruntime-node') as typeof import('onnxruntime-node')

const parent = (process as unknown as { parentPort?: NodeJS.EventEmitter & { postMessage(m: unknown): void } }).parentPort
function post(msg: OnnxWorkerResponse): void {
  parent?.postMessage(msg)
}

// Timestamped debug log → stdout, which main pipes to the console as "[onnx] …".
// This is how we diagnose slow inference (provider, tile size/count, per-stage ms).
function log(...args: unknown[]): void {
  console.log('[perf]', ...args)
}

// ── Session cache (one at a time) ──
let session: InferenceSession | null = null
let sessionKey = ''
let sessionProvider: ExecutionProvider = 'CPU'
let sessionFellBack = false

// CPU is the measured macOS baseline for the SIDD graph. Other platforms try
// their native provider first. LUXINUS_ONNX_EP is an explicit diagnostic override.
function epOrder(): { ep: string; label: ExecutionProvider }[] {
  const override = process.env.LUXINUS_ONNX_EP?.toLowerCase()
  const cpu = { ep: 'cpu', label: 'CPU' as ExecutionProvider }
  const map: Record<string, { ep: string; label: ExecutionProvider }> = {
    coreml: { ep: 'coreml', label: 'CoreML' },
    dml: { ep: 'dml', label: 'DirectML' },
    cuda: { ep: 'cuda', label: 'CUDA' },
    cpu
  }
  if (override && map[override]) return [map[override], cpu]
  if (process.platform === 'win32') return [{ ep: 'dml', label: 'DirectML' }, cpu]
  if (process.platform === 'linux') return [{ ep: 'cuda', label: 'CUDA' }, cpu]
  return [cpu]
}

async function getSession(modelPath: string, fingerprint: string): Promise<InferenceSession> {
  if (fingerprint !== RESTORATION_MODEL_FINGERPRINT) throw new Error('지원하지 않는 노이즈 제거 모델입니다.')
  const key = `${modelPath}:${fingerprint}`
  if (session && sessionKey === key) return session
  if (session) {
    await session.release?.().catch(() => {})
    session = null
  }
  // Create the session from the exact verified bytes, closing the hash-to-load
  // path replacement race. The worker retains only the resulting ORT session.
  const bytes = await readFile(modelPath)
  if (createHash('sha256').update(bytes).digest('hex') !== RESTORATION_MODEL.sha256) throw new Error('노이즈 제거 모델 체크섬 검증에 실패했습니다.')
  const providers = epOrder()
  for (const [providerIndex, { ep, label }] of providers.entries()) {
    const t0 = Date.now()
    try {
      session = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
        ...RESTORATION_SESSION_OPTIONS,
        logSeverityLevel: 3
      })
      sessionProvider = label
      sessionKey = key
      sessionFellBack = providerIndex > 0
      log(`session ready · provider=${label} · load=${Date.now() - t0}ms`)
      return session
    } catch (e) {
      log(`provider ${label} unavailable (${String((e as Error).message).slice(0, 50)}) — trying next`)
    }
  }
  throw new Error('노이즈 제거 모델을 실행할 수 있는 ONNX 제공자가 없습니다.')
}

async function denoise(req: Extract<OnnxWorkerRequest, { type: 'denoise' }>): Promise<void> {
  const { requestId, modelPath, modelFingerprint, rgba, width: W, height: H, strength } = req
  const tSession = Date.now()
  const sess = await getSession(modelPath, modelFingerprint)
  if (sess.inputNames.length !== 1 || sess.inputNames[0] !== RESTORATION_MODEL.input || sess.outputNames.length !== 1 || sess.outputNames[0] !== RESTORATION_MODEL.output) throw new Error('검증된 NAFNet SIDD 입출력 규격이 아닙니다.')
  let tileCount = 0
  let tileMs = 0
  const runner = async (input: Float32Array, size: number): Promise<Float32Array> => {
    if (size !== RESTORATION_MODEL.tile) throw new Error('NAFNet SIDD 입력은 768픽셀 타일이어야 합니다.')
    const tensor: Tensor = new ort.Tensor('float32', input, [1, 3, size, size])
    let output: InferenceSession.OnnxValueMapType | undefined
    const tt = Date.now()
    try {
      output = await sess.run({ [RESTORATION_MODEL.input]: tensor })
      tileMs += Date.now() - tt
      tileCount++
      const result = output[RESTORATION_MODEL.output]
      if (result.type !== 'float32' || result.dims.length !== 4 || result.dims[0] !== 1 || result.dims[1] !== 3 || result.dims[2] !== size || result.dims[3] !== size) throw new Error('노이즈 제거 모델 출력 크기가 유효하지 않습니다.')
      const data = new Float32Array(result.data as Float32Array)
      if (data.some((v) => !Number.isFinite(v))) throw new Error('노이즈 제거 모델이 잘못된 픽셀을 반환했습니다.')
      return data
    } finally {
      tensor.dispose()
      if (output) for (const value of Object.values(output)) value.dispose()
    }
  }
  try {
    const restored = await runTiled(rgbaToPlanar(rgba, W, H), W, H, runner, {
      tile: RESTORATION_MODEL.tile,
      overlap: RESTORATION_MODEL.overlap,
      onProgress: (progress) => post({ type: 'denoise:progress', requestId, progress })
    })
    log(`denoise done · provider=${sessionProvider} · tile=${RESTORATION_MODEL.tile} · ${tileCount} tiles · infer=${tileMs}ms · total=${Date.now() - tSession}ms · freeMem=${(os.freemem() / 1024 ** 3).toFixed(1)}GB`)
    post({ type: 'denoise:result', requestId, rgba: planarToRgba(restored, rgba, W, H, strength / 100), width: W, height: H, provider: sessionProvider, fellBack: sessionFellBack })
  } catch (error) {
    // The verified graph is static. Silently retrying at 512/384 is invalid.
    throw new Error(`노이즈 제거 실패: ${(error as Error).message}`)
  }
}

// Electron utilityProcess delivers parentPort messages as a MessageEvent — the
// request is in `e.data`, not the event itself (same pattern as decode.worker).
// Reading the event as the request silently ignored every message and left the
// renderer hanging at 0%. The raw-value fallback keeps plain-node harness runs
// working (they post the request directly).
parent?.on('message', (e: { data?: OnnxWorkerRequest } | OnnxWorkerRequest) => {
  const msg = (e && typeof e === 'object' && 'data' in e ? e.data : e) as OnnxWorkerRequest | undefined
  if (!msg || typeof msg !== 'object' || !('type' in msg)) return
  if (msg.type === 'denoise') {
    denoise(msg).catch((err: Error) =>
      post({ type: 'denoise:error', requestId: msg.requestId, message: err.message })
    )
    return
  }
})

post({ type: 'ready' })
