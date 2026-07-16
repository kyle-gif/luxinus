import { XMLParser } from 'fast-xml-parser'
import { HSL_BANDS, type CurvePoint, type EditState, type HslBand } from '../shared/edits'
import { presetBaseEdits, type XmpImportResult } from '../shared/presets'

// Import a Lightroom/Camera-Raw .xmp preset: parse the crs: namespace and map
// what we support onto Luxinus parameters. This is an APPROXIMATE mapping — the
// rendering engines differ — and unmapped fields are reported, not silently lost.

const clamp = (v: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, v))
const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = parseFloat(String(v))
  return isNaN(n) ? null : n
}

// crs color-adjustment suffixes → our HSL bands.
const HSL_COLORS: { xmp: string; band: HslBand }[] = [
  { xmp: 'Red', band: 'red' },
  { xmp: 'Orange', band: 'orange' },
  { xmp: 'Yellow', band: 'yellow' },
  { xmp: 'Green', band: 'green' },
  { xmp: 'Aqua', band: 'aqua' },
  { xmp: 'Blue', band: 'blue' },
  { xmp: 'Purple', band: 'purple' },
  { xmp: 'Magenta', band: 'magenta' }
]

// crs: keys that are structural/meta — never surfaced as "ignored".
const META_KEYS = new Set([
  'Version', 'ProcessVersion', 'WhiteBalance', 'Name', 'ShortName', 'SortName',
  'Group', 'RawFileName', 'HasSettings', 'HasCrop', 'AlreadyApplied', 'uuid',
  'SupportsAmount', 'SupportsColor', 'SupportsMonochrome', 'SupportsHighDynamicRange',
  'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred',
  'CameraProfile', 'CameraProfileDigest', 'Look', 'ToneCurveName', 'ToneCurveName2012',
  'ClipboardOrientation', 'ClipboardAspectRatio'
])

function parsePoints(seq: unknown): CurvePoint[] | null {
  // ToneCurve is an rdf:Seq of "x, y" strings (0..255).
  const s = seq as { 'rdf:Seq'?: { 'rdf:li'?: unknown } }
  const li = s?.['rdf:Seq']?.['rdf:li']
  if (li == null) return null
  const arr = Array.isArray(li) ? li : [li]
  const pts: CurvePoint[] = []
  for (const item of arr) {
    const m = String(item).split(',').map((t) => parseFloat(t.trim()))
    if (m.length === 2 && !isNaN(m[0]) && !isNaN(m[1])) {
      pts.push({ x: clamp(m[0], 0, 255) / 255, y: clamp(m[1], 0, 255) / 255 })
    }
  }
  return pts.length >= 2 ? pts : null
}

export function importXmp(xml: string, fallbackName: string): XmpImportResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: false,
    parseAttributeValue: false
  })
  const doc = parser.parse(xml)

  // Find rdf:Description (may be nested / an array).
  const rdf = doc?.['x:xmpmeta']?.['rdf:RDF'] ?? doc?.['xmpmeta']?.['RDF'] ?? doc?.['rdf:RDF']
  let desc = rdf?.['rdf:Description'] ?? rdf?.['Description']
  if (Array.isArray(desc)) desc = Object.assign({}, ...desc)
  if (!desc || typeof desc !== 'object') {
    throw new Error('Not a valid XMP file (no rdf:Description found).')
  }
  const d = desc as Record<string, unknown>

  // Collect crs: entries (attributes appear as 'crs:Key', children too).
  const crs: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(d)) {
    if (k.startsWith('crs:')) crs[k.slice(4)] = v
  }
  const get = (key: string): unknown => crs[key]

  const edits = presetBaseEdits()
  const mapped: string[] = []
  const consumed = new Set<string>()
  const use = (key: string): number | null => {
    const n = num(get(key))
    if (n !== null) consumed.add(key)
    return n
  }
  const sign = (n: number): string => (n > 0 ? `+${n}` : String(n))

  // ── Light ──
  const ev = use('Exposure2012')
  if (ev !== null) {
    edits.exposure = clamp((ev / 1.5) * 100)
    mapped.push(`Exposure ${sign(ev)} EV`)
  }
  const simple: [string, keyof EditState, string][] = [
    ['Contrast2012', 'contrast', 'Contrast'],
    ['Highlights2012', 'highlights', 'Highlights'],
    ['Shadows2012', 'shadows', 'Shadows'],
    ['Whites2012', 'whites', 'Whites'],
    ['Blacks2012', 'blacks', 'Blacks'],
    ['Clarity2012', 'clarity', 'Clarity'],
    ['Texture', 'texture', 'Texture'],
    ['Dehaze', 'dehaze', 'Dehaze'],
    ['GrainAmount', 'grain', 'Grain'],
    ['Vibrance', 'vibrance', 'Vibrance'],
    ['Saturation', 'saturation', 'Saturation']
  ]
  for (const [key, field, label] of simple) {
    const n = use(key)
    if (n !== null) {
      ;(edits[field] as number) = clamp(n)
      mapped.push(`${label} ${sign(n)}`)
    }
  }

  // ── White balance (incremental preferred; absolute approximated) ──
  const incT = use('IncrementalTemperature')
  if (incT !== null) {
    edits.temperature = clamp(incT)
    mapped.push(`Temperature ${sign(incT)}`)
  } else {
    const kelvin = use('Temperature')
    if (kelvin !== null && kelvin > 1000) {
      edits.temperature = clamp(((kelvin - 5500) / 5000) * 100)
      mapped.push(`Temperature ${kelvin}K (approx.)`)
    }
  }
  const incTint = use('IncrementalTint')
  if (incTint !== null) {
    edits.tint = clamp(incTint)
    mapped.push(`Tint ${sign(incTint)}`)
  } else {
    const tint = use('Tint')
    if (tint !== null) {
      edits.tint = clamp((tint / 150) * 100)
      mapped.push(`Tint ${sign(tint)} (approx.)`)
    }
  }

  // ── Detail / effects ──
  const sharp = use('Sharpness')
  if (sharp !== null) {
    edits.sharpening = clamp((sharp / 150) * 100, 0, 100)
    mapped.push(`Sharpening ${sharp}`)
  }
  const vig = use('PostCropVignetteAmount') ?? use('VignetteAmount')
  if (vig !== null) {
    edits.vignette = clamp(vig)
    mapped.push(`Vignette ${sign(vig)}`)
  }

  // ── Tone curves ──
  const curveMap: [string, keyof typeof edits.curves][] = [
    ['ToneCurvePV2012', 'rgb'],
    ['ToneCurvePV2012Red', 'r'],
    ['ToneCurvePV2012Green', 'g'],
    ['ToneCurvePV2012Blue', 'b']
  ]
  for (const [key, ch] of curveMap) {
    const raw = get(key)
    if (raw != null) {
      const pts = parsePoints(raw)
      if (pts) {
        edits.curves[ch] = pts
        consumed.add(key)
        if (ch === 'rgb') mapped.push('Tone curve')
        else mapped.push(`Tone curve (${ch.toUpperCase()})`)
      }
    }
  }

  // ── HSL / colour mixer ──
  let hslTouched = false
  for (const { xmp, band } of HSL_COLORS) {
    const h = use(`HueAdjustment${xmp}`)
    const s = use(`SaturationAdjustment${xmp}`)
    const l = use(`LuminanceAdjustment${xmp}`)
    if (h !== null) edits.hsl[band].hue = clamp(h)
    if (s !== null) edits.hsl[band].sat = clamp(s)
    if (l !== null) edits.hsl[band].lum = clamp(l)
    if (h !== null || s !== null || l !== null) hslTouched = true
  }
  if (hslTouched) {
    const bands = HSL_COLORS.filter(({ band }) => {
      const a = edits.hsl[band]
      return a.hue || a.sat || a.lum
    }).map(({ xmp }) => xmp)
    mapped.push(`Colour mixer (${bands.join(', ')})`)
  }
  void HSL_BANDS

  // ── Colour Grading / Split Toning → approximate global cast ──
  // Modern Lightroom presets carry much of their "look" in Colour Grading
  // (PV2012+) or legacy Split Toning, which have no Luxinus equivalent. Rather
  // than silently dropping the colour character (the #1 reason an imported preset
  // "does nothing" to colour), we aggregate the graded hue/saturation across the
  // tonal regions into a single representative cast and approximate it as a
  // Temperature + Tint nudge. Coarse, but it makes the intended look land.
  const gradeRegions: { hue: string; sat: string }[] = [
    { hue: 'ColorGradeGlobalHue', sat: 'ColorGradeGlobalSat' },
    { hue: 'ColorGradeShadowHue', sat: 'ColorGradeShadowSat' },
    { hue: 'ColorGradeMidtoneHue', sat: 'ColorGradeMidtoneSat' },
    { hue: 'ColorGradeHighlightHue', sat: 'ColorGradeHighlightSat' },
    // Legacy split-toning keys (Hue 0–360, Saturation 0–100).
    { hue: 'SplitToningShadowHue', sat: 'SplitToningShadowSaturation' },
    { hue: 'SplitToningHighlightHue', sat: 'SplitToningHighlightSaturation' }
  ]
  // Consume the lum/blend/balance keys too so they aren't reported as "ignored".
  for (const k of [
    'ColorGradeShadowLum', 'ColorGradeMidtoneLum', 'ColorGradeHighlightLum',
    'ColorGradeGlobalLum', 'ColorGradeBlending', 'SplitToningBalance'
  ]) {
    if (get(k) != null) consumed.add(k)
  }
  let vx = 0
  let vy = 0
  for (const { hue, sat } of gradeRegions) {
    const h = num(get(hue))
    const s = num(get(sat))
    if (h !== null) consumed.add(hue)
    if (s !== null) consumed.add(sat)
    if (h === null || s === null || s === 0) continue
    const rad = (h * Math.PI) / 180
    vx += s * Math.cos(rad)
    vy += s * Math.sin(rad)
  }
  const castSat = Math.hypot(vx, vy)
  if (castSat > 1) {
    // Only nudge WB if the preset didn't already set an explicit temperature/tint.
    const castHue = (Math.atan2(vy, vx) * 180) / Math.PI
    const s01 = Math.min(1, castSat / 100)
    const d = (deg: number): number => (Math.cos(((castHue - deg) * Math.PI) / 180)) * s01 * 45
    const dTemp = d(45) // warm (orange) ↔ cool (blue, 225°)
    const dTint = d(315) // magenta (315°) ↔ green (135°)
    if (edits.temperature === 0) edits.temperature = clamp(Math.round(dTemp))
    if (edits.tint === 0) edits.tint = clamp(Math.round(dTint))
    mapped.push('Colour grading → WB cast (approx.)')
  }

  // ── Ignored (present but unsupported) ──
  const ignored: string[] = []
  for (const key of Object.keys(crs)) {
    if (consumed.has(key) || META_KEYS.has(key)) continue
    // Skip obviously-structural rdf containers already handled.
    ignored.push(key)
  }

  // Preset name: crs:Name (rdf:Alt) or the filename.
  let name = fallbackName
  const rawName = get('Name')
  if (rawName) {
    const li = (rawName as { 'rdf:Alt'?: { 'rdf:li'?: unknown } })?.['rdf:Alt']?.['rdf:li']
    const text = Array.isArray(li) ? li[0] : li
    if (typeof text === 'object' && text && '#text' in text) name = String((text as { '#text': unknown })['#text'])
    else if (typeof text === 'string') name = text
  }

  return { name, edits, mapped, ignored: ignored.sort() }
}
