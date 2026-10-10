// Shared contracts for the AI (ONNX) inference layer — used by the onnx utility
// worker, the main-process orchestrator, and the preload bridge. No pixel data
// or paths ever leave the device; this is all in-process IPC.

export type ExecutionProvider = 'CoreML' | 'DirectML' | 'CUDA' | 'CPU'

// Official darktable-ai release-5.6.0 export of Megvii's MIT SIDD width-32
// checkpoint. This graph has a static 768px input; smaller OOM tiles are invalid.
export const RESTORATION_MODEL = {
  id: 'nafnet-sidd-width32',
  filename: 'nafnet-sidd-width32.onnx',
  sha256: '8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230',
  input: 'input', output: 'output', tile: 768, overlap: 32,
  runnerVersion: 'rgb-reflect-cosine32-v1'
} as const
export const RESTORATION_MODEL_FINGERPRINT = `${RESTORATION_MODEL.id}:${RESTORATION_MODEL.sha256}:${RESTORATION_MODEL.runnerVersion}`
// Electron on macOS traps on the arena's large allocation, then on the second
// run's memory-pattern allocation if only the arena is disabled. Direct per-node
// allocation supports consecutive runs without either oversized pooled block.
export const RESTORATION_SESSION_OPTIONS = { graphOptimizationLevel: 'all', enableCpuMemArena: false, enableMemPattern: false } as const

// ── Worker (utility process) message contract ──
export interface OnnxDenoiseRequest {
  type: 'denoise'
  requestId: string
  modelPath: string
  modelFingerprint: string
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
  fellBack?: boolean // true if the requested execution provider fell back to CPU
  modelFingerprint?: string // actual model bytes + inference algorithm revision
  message?: string // present when ok === false
  cache?: { status: 'stored' | 'hit' | 'error'; message?: string }
}

/** A preview cache request is scoped to a library photo, never a destination path. */
export interface RestorationPreviewRequest {
  requestId: string
  filePath: string
  sourceMtimeMs: number
  sourceSize: number
  rgba: Uint8Array
  width: number
  height: number
}
