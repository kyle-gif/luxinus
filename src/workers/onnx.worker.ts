// ONNX inference utility process (Phase 6).
//
// Owns ALL onnxruntime-node work so inference never blocks main/renderer. The
// OOM-avoidance architecture lives here:
//   • tiled inference (fixed square tiles, reflect-padded, cosine-blended)
//   • provider probing → CoreML / DirectML / CUDA with CPU fallback
//   • sequential sessions: exactly one ONNX session alive at a time
//   • tile-size OOM ladder (768 → 512 → 384) instead of halving into sizes the
//     model rejects; final fallback returns the original image (never crash)
import os from 'node:os'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import {
  DEFAULT_TILE,
  TILE_LADDER,
  TILE_OVERLAP,
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

// Provider order. NOTE: for this NAFNet graph, CoreML measured ~8× SLOWER than
// CPU on Apple silicon (heavy CPU↔ANE partitioning: ~9s/tile vs ~1.2s/tile), so
// CPU is preferred on macOS. Set LUXINUS_ONNX_EP=coreml|dml|cuda|cpu to override.
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
  return [cpu] // macOS: CPU is fastest for this model
}

async function getSession(modelPath: string): Promise<InferenceSession> {
  if (session && sessionKey === modelPath) return session
  if (session) {
    await session.release?.().catch(() => {})
    session = null
  }
  for (const { ep, label } of epOrder()) {
    const t0 = Date.now()
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all'
      })
      sessionProvider = label
      sessionKey = modelPath
      log(`session ready · provider=${label} · load=${Date.now() - t0}ms`)
      return session
    } catch (e) {
      log(`provider ${label} unavailable (${String((e as Error).message).slice(0, 50)}) — trying next`)
    }
  }
  session = await ort.InferenceSession.create(modelPath)
  sessionProvider = 'CPU'
  sessionKey = modelPath
  log('session ready · provider=CPU (last resort)')
  return session
}

// Light "VRAM probe": on GPU providers, start smaller when system memory is
// modest; on CPU the ladder + OOM catch handle the rest.
function pickInitialTile(): number {
  const freeGB = os.freemem() / 1024 ** 3
  if (freeGB < 2) return 384
  if (freeGB > 6) return DEFAULT_TILE
  return DEFAULT_TILE
}

function isOom(err: unknown): boolean {
  const m = String((err as Error)?.message ?? err).toLowerCase()
  return m.includes('memory') || m.includes('alloc') || m.includes('oom') || m.includes('bad_alloc')
}

async function denoise(req: Extract<OnnxWorkerRequest, { type: 'denoise' }>): Promise<void> {
  const { requestId, modelPath, rgba, width: W, height: H, strength } = req
  const megapx = ((W * H) / 1e6).toFixed(1)
  log(`denoise start · ${W}×${H} (${megapx}MP) · strength=${strength} · freeMem=${(os.freemem() / 1024 ** 3).toFixed(1)}GB`)
  const tSession = Date.now()
  const sess = await getSession(modelPath)
  const inName = sess.inputNames[0]
  const outName = sess.outputNames[0]
  const src = rgbaToPlanar(rgba, W, H)

  // Candidate tile sizes: start at the probed size, then step DOWN the ladder.
  const start = pickInitialTile()
  const ladder = TILE_LADDER.filter((t) => t <= start)
  let fellBack = false

  for (let i = 0; i < ladder.length; i++) {
    const tile = ladder[i]
    let tileCount = 0
    let tileMs = 0
    try {
      const runner = async (input: Float32Array, size: number): Promise<Float32Array> => {
        const t: Tensor = new ort.Tensor('float32', input, [1, 3, size, size])
        const tt = Date.now()
        const out = await sess.run({ [inName]: t })
        tileMs += Date.now() - tt
        tileCount++
        return out[outName].data as Float32Array
      }
      const restored = await runTiled(src, W, H, runner, {
        tile,
        overlap: TILE_OVERLAP,
        onProgress: (f) => post({ type: 'denoise:progress', requestId, progress: f })
      })
      log(
        `denoise done · provider=${sessionProvider} · tile=${tile} · ${tileCount} tiles · ` +
          `${(tileMs / Math.max(1, tileCount)).toFixed(0)}ms/tile · infer=${(tileMs / 1000).toFixed(1)}s · ` +
          `total=${((Date.now() - tSession) / 1000).toFixed(1)}s`
      )
      const outRgba = planarToRgba(restored, rgba, W, H, strength / 100)
      post({
        type: 'denoise:result',
        requestId,
        rgba: outRgba,
        width: W,
        height: H,
        provider: sessionProvider,
        fellBack: fellBack || i > 0
      })
      return
    } catch (err) {
      if (isOom(err) && i < ladder.length - 1) {
        log(`OOM at tile=${tile} — stepping down to ${ladder[i + 1]}`)
        fellBack = true
        continue // step down to a smaller tile and retry
      }
      log(`denoise failed (${String((err as Error).message).slice(0, 80)}) — returning original`)
      // Graceful degradation: return the original image untouched, flagged.
      post({
        type: 'denoise:result',
        requestId,
        rgba,
        width: W,
        height: H,
        provider: sessionProvider,
        fellBack: true
      })
      return
    }
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
