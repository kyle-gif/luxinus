// Shared contracts for the AI (ONNX) inference layer — used by the onnx utility
// worker, the main-process orchestrator, and the preload bridge. No pixel data
// or paths ever leave the device; this is all in-process IPC.

export type ExecutionProvider = 'CoreML' | 'DirectML' | 'CUDA' | 'CPU'

// ── Worker (utility process) message contract ──
export interface OnnxDenoiseRequest {
  type: 'denoise'
  requestId: string
  modelPath: string
  rgba: Uint8Array // RGBA source pixels
  width: number
  height: number
  strength: number // 0..100 (blend restored vs original)
}

export type OnnxWorkerRequest = OnnxDenoiseRequest

export type OnnxWorkerResponse =
  | { type: 'ready' }
  | { type: 'denoise:progress'; requestId: string; progress: number }
  | { type: 'denoise:result'; requestId: string; rgba: Uint8Array; width: number; height: number; provider: ExecutionProvider; fellBack: boolean }
  | { type: 'denoise:error'; requestId: string; message: string }

// ── Renderer-facing IPC result ──
export interface DenoiseResult {
  ok: boolean
  rgba?: Uint8Array
  width?: number
  height?: number
  provider?: ExecutionProvider
  fellBack?: boolean // true if we degraded (smaller tiles / CPU / model missing)
  message?: string // present when ok === false
}

// Tile-size ladder — the NAFNet export only accepts spatial sizes ≥ 384, so OOM
// recovery steps DOWN this ladder rather than halving into invalid sizes.
export const TILE_LADDER = [768, 512, 384] as const
export const DEFAULT_TILE = 512
export const TILE_OVERLAP = 32
