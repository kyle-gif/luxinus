import { coerceEditState, defaultEditState, type EditState } from './edits'

// Presets — reusable "looks". A preset stores the tonal/colour/curve/HSL/detail/
// effects state but NOT geometry (crop/rotate/flip are photo-specific), so
// applying a preset preserves the current photo's framing.

export const PRESET_SCHEMA_VERSION = 1

export interface Preset {
  id: string
  name: string
  edits: EditState // geometry fields are held at defaults
  createdAt: string
  /** 'xmp' if imported from a Lightroom .xmp, else 'native'. */
  origin: 'native' | 'xmp'
}

// The geometry fields a preset never carries.
const GEOMETRY_DEFAULTS = {
  crop: null,
  rotate: 0,
  flipH: false,
  flipV: false
} as const

// Capture the current edit as a preset payload (geometry stripped).
export function captureAsPreset(edit: EditState): EditState {
  return { ...edit, ...GEOMETRY_DEFAULTS, masks: edit.masks.filter(mask => mask.kind !== 'semantic') }
}

// Apply a preset to the current edit, preserving the photo's geometry.
// coerce runs first so presets saved by older schema versions apply cleanly.
export function applyPreset(current: EditState, preset: Preset): EditState {
  return {
    ...coerceEditState(preset.edits),
    crop: current.crop,
    rotate: current.rotate,
    flipH: current.flipH,
    flipV: current.flipV,
    masks: [...coerceEditState(preset.edits).masks.filter(mask => mask.kind !== 'semantic'), ...current.masks.filter(mask => mask.kind === 'semantic')]
  }
}

// A fresh preset edits object (used by the xmp mapper as its base).
export function presetBaseEdits(): EditState {
  return { ...defaultEditState(), ...GEOMETRY_DEFAULTS }
}

// ── XMP import result ───────────────────────────────────────────────────────
export interface XmpImportResult {
  name: string
  edits: EditState
  /** Human-readable fields we successfully mapped. */
  mapped: string[]
  /** crs: fields present in the file we don't support (listed for the summary). */
  ignored: string[]
}
