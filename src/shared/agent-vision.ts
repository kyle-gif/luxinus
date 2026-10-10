import type { EditState } from './edits'
import { editFingerprint } from './local-agent'

export const AGENT_SCREENSHOT_MAX_EDGE = 1536
export const AGENT_SCREENSHOT_MAX_BYTES = 2 * 1024 * 1024
export const AGENT_CAPTURE_TIMEOUT_MS = 15_000
export type AgentCaptureTarget = 'original' | 'current' | 'staged'

/** Trusted main-to-renderer photo-only capture. Never forwarded to the model. */
export interface AgentCaptureRequest {
  captureId: string
  requestId: string
  photoId: string
  baseEditFingerprint: string
  edit: EditState
  target: AgentCaptureTarget
  overlayMaskId?: string
  /** Filled by the main capture broker, checked against the loaded proxy. */
  sourceMtimeMs?: number
  sourceSize?: number
}
export interface AgentCaptureResult { dataUrl: string; width: number; height: number }
export type AgentCaptureResponse = {
  captureId: string; requestId: string; photoId: string
} & ({ ok: true; result: AgentCaptureResult } | { ok: false; error: string })

export interface AgentToolProgress {
  requestId: string
  operationId: string
  tool: string
  status: 'started' | 'completed' | 'failed'
  message: string
  /** A bounded photo-only preview; local UI receipt, never a desktop image. */
  imageDataUrl?: string
}
export interface AgentVisionApi {
  onCaptureRequest(listener: (request: AgentCaptureRequest) => void): () => void
  captureResult(response: AgentCaptureResponse): void
  onToolProgress(listener: (event: AgentToolProgress) => void): () => void
}

/** The existing editFingerprint is canonical JSON, so hash it before IPC. */
export async function agentEditDigest(edit: EditState): Promise<string> {
  const bytes = new TextEncoder().encode(editFingerprint(edit))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
