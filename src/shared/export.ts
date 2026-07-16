import type { EditState } from './edits'
import type { PhotoMeta } from './library'

// One export job for one photo (renderer → main). editState is the live buffer
// for the active photo; null for others (main loads their sidecar).
export interface ExportItem {
  filePath: string
  fileName: string
  editState: EditState | null
  meta: PhotoMeta | null
}

// Export contract — shared by the renderer (dialog), main (orchestrator), and the
// hidden window (full-res render). All local: files are written only to a folder
// the user picks; nothing is transmitted.

export type ExportFormat = 'jpeg' | 'png' | 'tiff'
export type ExifMode = 'keep' | 'strip' | 'frame'
export type FrameStyle = 'minimal' | 'film'

export interface ExportOptions {
  format: ExportFormat
  quality: number // 1..100 (JPEG)
  /** Long-edge cap in px, or 0 for original resolution. */
  longEdge: number
  /** Filename pattern with tokens: {name} {seq} {date} {W} {H}. */
  filenamePattern: string
  exifMode: ExifMode
  frameStyle: FrameStyle
  destDir: string
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  format: 'jpeg',
  quality: 90,
  longEdge: 0,
  filenamePattern: '{name}',
  exifMode: 'keep',
  frameStyle: 'minimal',
  destDir: ''
}

// One line of the Frame-mode caption (label + value), e.g. "ISO" / "400".
export interface FrameField {
  label: string
  value: string
}

// Build the shooting-info fields for Frame mode from metadata + filename.
export function frameFields(meta: PhotoMeta | null, fileName: string): FrameField[] {
  const fields: FrameField[] = []
  const camera = [meta?.cameraMake, meta?.cameraModel].filter(Boolean).join(' ').trim()
  if (camera) fields.push({ label: 'Camera', value: camera })
  if (meta?.focalLen) fields.push({ label: 'Focal', value: `${Math.round(meta.focalLen)}mm` })
  if (meta?.aperture) fields.push({ label: 'Aperture', value: `ƒ/${meta.aperture.toFixed(1)}` })
  if (meta?.shutter) fields.push({ label: 'Shutter', value: shutterLabel(meta.shutter) })
  if (meta?.iso) fields.push({ label: 'ISO', value: String(meta.iso) })
  if (meta?.capturedAt) fields.push({ label: 'Date', value: dateLabel(meta.capturedAt) })
  if (!fields.length) fields.push({ label: 'File', value: fileName })
  return fields
}

function shutterLabel(sec: number): string {
  if (sec <= 0) return ''
  if (sec >= 1) return `${sec.toFixed(1)}s`
  return `1/${Math.round(1 / sec)}s`
}
function dateLabel(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

// Apply filename pattern tokens. Extension is added by the caller per format.
export function renderFilename(
  pattern: string,
  ctx: { name: string; seq: number; width: number; height: number }
): string {
  const now = new Date()
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  return (pattern || '{name}')
    .replace(/\{name\}/g, ctx.name)
    .replace(/\{seq\}/g, String(ctx.seq).padStart(3, '0'))
    .replace(/\{date\}/g, date)
    .replace(/\{W\}/g, String(ctx.width))
    .replace(/\{H\}/g, String(ctx.height))
    .replace(/[\\/:*?"<>|]/g, '_') // sanitize
}

// ── Hidden-window render contract ───────────────────────────────────────────
export interface ExportRenderRequest {
  id: string
  ext: string // original extension (lowercased, with dot)
  isRaw: boolean
  bytes: Uint8Array // original file bytes (or a PNG main pre-converted for TIFF/HEIF)
  editState: EditState
  longEdge: number // 0 = original
  frame: { style: FrameStyle; fields: FrameField[] } | null
}

export interface ExportRenderResult {
  rgba: Uint8Array // upright RGBA
  width: number
  height: number
}

export interface ExportProgress {
  done: number
  total: number
  current: string
}
