// Non-destructive edit model — shared by the renderer (UI + WebGL preview) and
// main (sidecar persistence). Originals are never modified; this state is the
// entire description of an edit and is written to a sidecar JSON next to the file.

// v2: masks gained combinable `refine` components (add/subtract/intersect).
// v1 sidecars load unchanged — coerceEditState fills `refine: []`.
export const EDIT_SCHEMA_VERSION = 2

// A single tone-curve control point in 0..1 space (input → output).
export interface CurvePoint {
  x: number
  y: number
}

// Identity curve (a straight line): the two corners.
export const IDENTITY_CURVE: CurvePoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 1 }
]

export type CurveChannel = 'rgb' | 'r' | 'g' | 'b'

export interface ToneCurves {
  rgb: CurvePoint[]
  r: CurvePoint[]
  g: CurvePoint[]
  b: CurvePoint[]
}

// The 8 HSL color bands (Lightroom's mixer order).
export const HSL_BANDS = [
  'red',
  'orange',
  'yellow',
  'green',
  'aqua',
  'blue',
  'purple',
  'magenta'
] as const
export type HslBand = (typeof HSL_BANDS)[number]

// Center hue (degrees) for each band — used by the WebGL mixer.
export const HSL_BAND_HUE: Record<HslBand, number> = {
  red: 0,
  orange: 30,
  yellow: 60,
  green: 120,
  aqua: 180,
  blue: 220,
  purple: 270,
  magenta: 320
}

export interface HslAdjust {
  hue: number // -100..100
  sat: number // -100..100
  lum: number // -100..100
}

export type HslMixer = Record<HslBand, HslAdjust>

export interface CropRect {
  // Normalized 0..1 within the (rotation-applied) image.
  x: number
  y: number
  w: number
  h: number
}

// ── Color grading (3-way + global) ──────────────────────────────────────────
// Lightroom-style color wheels: tint the shadows, midtones, and highlights (and
// a global cast) with an independent hue + saturation, plus a luminance shift.
// Balance biases the shadow/highlight split; Blending softens the transitions.
export interface ColorGradeRegion {
  hue: number // 0..360 (wheel angle)
  sat: number // 0..100 (distance from center)
  lum: number // -100..100 (regional luminance shift)
}
export interface ColorGrade {
  shadows: ColorGradeRegion
  midtones: ColorGradeRegion
  highlights: ColorGradeRegion
  global: ColorGradeRegion
  blending: number // 0..100 (transition softness; 50 = neutral)
  balance: number // -100..100 (shadow ↔ highlight bias)
}

export function zeroColorGradeRegion(): ColorGradeRegion {
  return { hue: 0, sat: 0, lum: 0 }
}
export function zeroColorGrade(): ColorGrade {
  return {
    shadows: zeroColorGradeRegion(),
    midtones: zeroColorGradeRegion(),
    highlights: zeroColorGradeRegion(),
    global: zeroColorGradeRegion(),
    blending: 50,
    balance: 0
  }
}
export const COLOR_GRADE_REGIONS = ['shadows', 'midtones', 'highlights', 'global'] as const
export type ColorGradeRegionKey = (typeof COLOR_GRADE_REGIONS)[number]

// ── Local-adjustment masks ──────────────────────────────────────────────────
// Each mask carries a subset of develop adjustments applied only where the mask
// covers, blended by coverage. Geometry is normalized 0..1 in view (post-crop)
// space — the same space the mask overlays draw in — applied by the shader as a
// compositing pass over the globally-developed image.

export type MaskKind = 'radial' | 'linear' | 'brush' | 'lumRange' | 'colorRange'

// The local adjustments a mask can carry (a focused subset of EditState).
export interface MaskAdjust {
  exposure: number // -100..100
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  temperature: number
  tint: number
  saturation: number
  clarity: number
  dehaze: number // -100..100 (v2)
  sharpness: number // 0..100 (v2)
}

export const MASK_ADJUST_KEYS = [
  'exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks',
  'temperature', 'tint', 'saturation', 'clarity', 'dehaze', 'sharpness'
] as const

export function zeroMaskAdjust(): MaskAdjust {
  return {
    exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0,
    temperature: 0, tint: 0, saturation: 0, clarity: 0, dehaze: 0, sharpness: 0
  }
}

// Radial (elliptical) mask — affects inside the ellipse (or outside if inverted).
export interface RadialGeom {
  cx: number // center 0..1
  cy: number
  rx: number // radii 0..1 (view space)
  ry: number
  feather: number // 0..1 softness
  invert: boolean
}

// Linear (graduated) mask — 0 coverage at p1, ramping to full at p2.
export interface LinearGeom {
  x1: number
  y1: number
  x2: number
  y2: number
}

// Luminance range mask — selects pixels whose SOURCE luminance falls inside
// [lo, hi], with a smooth falloff (feather) beyond each end. Evaluated on the
// pre-develop source so coverage stays stable while adjustments are dragged
// (no feedback loop between a mask's own edits and its selection). This is the
// primary dynamic-range recovery tool.
export interface LumRangeGeom {
  lo: number // 0..1 lower luminance bound
  hi: number // 0..1 upper bound
  featherLo: number // 0..1 falloff width below lo
  featherHi: number // 0..1 falloff width above hi
}

// Color range mask — selects pixels perceptually similar (Oklab distance) to a
// sampled color. The sample is stored as sRGB (0..255) so the UI can show a
// swatch; the shader converts to Oklab at upload. tolerance/feather are 0..1
// UI-normalized and mapped to perceptual distances at upload.
export interface ColorRangeGeom {
  rgb: [number, number, number] // sampled color, 0..255
  tolerance: number // 0..1 — how far a color may drift and still be selected
  feather: number // 0..1 — softness of the selection edge
}

export interface BrushPoint {
  x: number
  y: number
}
export interface BrushStroke {
  points: BrushPoint[]
  radius: number // normalized brush radius
  erase: boolean
}
export interface BrushGeom {
  strokes: BrushStroke[]
}

// ── Mask refinements ────────────────────────────────────────────────────────
// A mask's PRIMARY shape (its kind + geometry) can be refined by combining it
// with further selections: Add (union), Subtract, Intersect — Lightroom's
// "create a mask, then refine it" model. Refinements are the source-evaluated
// kinds (luminance / color range), which need no on-canvas gizmos.
export type RefineMode = 'add' | 'subtract' | 'intersect'
export type RefineKind = 'lumRange' | 'colorRange'
export interface MaskRefine {
  id: string
  kind: RefineKind
  mode: RefineMode
  invert: boolean
  lum?: LumRangeGeom
  color?: ColorRangeGeom
}

export interface Mask {
  id: string
  kind: MaskKind
  name: string
  enabled: boolean
  /** Max opacity of the mask's effect, 0..1. Absent = 1 (full). */
  density?: number
  adjust: MaskAdjust
  radial?: RadialGeom
  linear?: LinearGeom
  brush?: BrushGeom
  lum?: LumRangeGeom
  color?: ColorRangeGeom
  /** Combinable refinements applied to the primary shape (v2+). */
  refine?: MaskRefine[]
}

export interface EditState {
  // Light
  exposure: number // -100..100 (≈ ±2 EV)
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  // Color
  temperature: number // -100..100 (cool→warm)
  tint: number // -100..100 (green→magenta)
  saturation: number
  vibrance: number
  // Detail
  clarity: number
  texture: number // -100..100 (fine, high-frequency detail)
  sharpening: number // 0..100
  denoise: number // 0..100 (AI)
  dehaze: number // -100..100 (remove/add atmospheric veiling)
  // Effects
  vignette: number // -100..100
  grain: number // 0..100 (film grain)
  // Tone curve + HSL
  curves: ToneCurves
  hsl: HslMixer
  // Color grading (3-way + global wheels)
  colorGrade: ColorGrade
  // Geometry
  rotate: number // degrees (free)
  flipH: boolean
  flipV: boolean
  crop: CropRect | null
  // Local-adjustment masks (applied as compositing passes after global develop)
  masks: Mask[]
}

function zeroHsl(): HslMixer {
  return HSL_BANDS.reduce((acc, b) => {
    acc[b] = { hue: 0, sat: 0, lum: 0 }
    return acc
  }, {} as HslMixer)
}

export function defaultEditState(): EditState {
  return {
    exposure: 0,
    contrast: 0,
    highlights: 0,
    shadows: 0,
    whites: 0,
    blacks: 0,
    temperature: 0,
    tint: 0,
    saturation: 0,
    vibrance: 0,
    clarity: 0,
    texture: 0,
    sharpening: 0,
    denoise: 0,
    dehaze: 0,
    vignette: 0,
    grain: 0,
    curves: {
      rgb: [...IDENTITY_CURVE],
      r: [...IDENTITY_CURVE],
      g: [...IDENTITY_CURVE],
      b: [...IDENTITY_CURVE]
    },
    hsl: zeroHsl(),
    colorGrade: zeroColorGrade(),
    rotate: 0,
    flipH: false,
    flipV: false,
    crop: null,
    masks: []
  }
}

// The numeric scalar controls that can be reset/checked as "adjusted".
const SCALAR_KEYS = [
  'exposure',
  'contrast',
  'highlights',
  'shadows',
  'whites',
  'blacks',
  'temperature',
  'tint',
  'saturation',
  'vibrance',
  'clarity',
  'texture',
  'sharpening',
  'denoise',
  'dehaze',
  'vignette',
  'grain'
] as const

// Has this photo been edited away from defaults? Used for the thumbnail badge.
export function isEdited(e: EditState): boolean {
  if (SCALAR_KEYS.some((k) => e[k] !== 0)) return true
  if (e.rotate !== 0 || e.flipH || e.flipV || e.crop) return true
  if (e.masks && e.masks.length > 0) return true
  if (HSL_BANDS.some((b) => e.hsl[b].hue || e.hsl[b].sat || e.hsl[b].lum)) return true
  if (e.colorGrade && COLOR_GRADE_REGIONS.some((r) => e.colorGrade[r].sat || e.colorGrade[r].lum)) {
    return true
  }
  const curveEdited = (c: CurvePoint[]): boolean =>
    c.length !== 2 || c[0].x !== 0 || c[0].y !== 0 || c[1].x !== 1 || c[1].y !== 1
  if (curveEdited(e.curves.rgb) || curveEdited(e.curves.r) || curveEdited(e.curves.g) || curveEdited(e.curves.b)) {
    return true
  }
  return false
}

export interface Sidecar {
  version: number
  app: 'luxinus'
  edits: EditState
  updatedAt: string
}

// Merge a loaded (possibly partial/older) edit object onto current defaults so
// missing keys are filled — forward/backward safe.
export function coerceEditState(input: unknown): EditState {
  const base = defaultEditState()
  if (!input || typeof input !== 'object') return base
  const src = input as Partial<EditState>
  return {
    ...base,
    ...src,
    curves: { ...base.curves, ...(src.curves ?? {}) },
    hsl: { ...base.hsl, ...(src.hsl ?? {}) },
    colorGrade: { ...base.colorGrade, ...(src.colorGrade ?? {}) },
    crop: src.crop ?? null,
    // v1→v2 mask migration: fill the refine list and the adjust keys new in v2.
    // Everything else in a v1 mask is structurally valid v2.
    masks: Array.isArray(src.masks)
      ? src.masks.map((m) => ({
          ...m,
          adjust: { ...zeroMaskAdjust(), ...(m.adjust ?? {}) },
          refine: Array.isArray(m.refine) ? m.refine : []
        }))
      : []
  }
}
