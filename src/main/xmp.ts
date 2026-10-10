import { XMLParser, XMLValidator } from 'fast-xml-parser'
import { HSL_BANDS, type CurvePoint, type EditState, type HslBand } from '../shared/edits'
import { presetBaseEdits, type XmpImportResult } from '../shared/presets'

// Import a Lightroom/Camera-Raw .xmp preset: parse the crs: namespace and map
// what we support onto Luxinus parameters. This is an APPROXIMATE mapping — the
// rendering engines differ — and unmapped fields are reported, not silently lost.

const clamp = (v: number, lo = -100, hi = 100): number => Math.max(lo, Math.min(hi, v))
const num = (v: unknown): number | null => {
  if (v == null) return null
  const raw = String(v).trim()
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function validateXmpXml(xml: string): void {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > 4 * 1024 * 1024) throw new Error('XMP는 4 MB 이하의 UTF-8 문서여야 합니다.')
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) throw new Error('XMP의 DTD 및 외부 엔티티는 허용되지 않습니다.')
  if (/\u0000/.test(xml) || /<\?xml[^>]*encoding\s*=\s*['"](?!utf-8['"]|utf8['"])[^'"]+['"]/i.test(xml)) throw new Error('UTF-8 XMP만 지원합니다. 원문을 보존했습니다.')
  const checked = XMLValidator.validate(xml)
  if (checked !== true) throw new Error(`XMP 문법 오류: ${checked.err.msg} (${checked.err.line}:${checked.err.col})`)
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
  'Version', 'ProcessVersion', 'Name', 'ShortName', 'SortName',
  'Group', 'RawFileName', 'HasSettings', 'HasCrop', 'AlreadyApplied', 'uuid',
  'SupportsAmount', 'SupportsColor', 'SupportsMonochrome', 'SupportsHighDynamicRange',
  'SupportsNormalDynamicRange', 'SupportsSceneReferred', 'SupportsOutputReferred',
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
  validateXmpXml(xml)
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    removeNSPrefix: false,
    parseAttributeValue: false,
    processEntities: false
  })
  const doc = parser.parse(xml)

  // Resolve namespace URIs instead of treating a familiar prefix as authority.
  // A vendor may bind "crs" to a different schema, or use another prefix for CRS.
  const crs: Record<string, unknown> = {}
  let descriptions = 0
  const visit = (name: string, value: unknown, inherited: Record<string, string>, depth: number): void => {
    if (depth > 32) throw new Error('XMP 구조가 너무 깊습니다.')
    if (Array.isArray(value)) { value.forEach((item) => visit(name, item, inherited, depth)); return }
    if (!value || typeof value !== 'object') return
    const object = value as Record<string, unknown>
    const namespaces = { ...inherited }
    for (const [key, entry] of Object.entries(object)) if (key.startsWith('xmlns:') && typeof entry === 'string') namespaces[key.slice(6)] = entry
    const [prefix, local] = name.split(':')
    if (local === 'Description' && namespaces[prefix] === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#') {
      descriptions++
      for (const [key, entry] of Object.entries(object)) {
        const [attributePrefix, field] = key.split(':')
        if (field && namespaces[attributePrefix] === 'http://ns.adobe.com/camera-raw-settings/1.0/') {
          if (field in crs) throw new Error(`중복 XMP 보정 항목은 가져올 수 없습니다: ${field}`)
          crs[field] = entry
        }
      }
    }
    for (const [key, entry] of Object.entries(object)) if (!key.startsWith('xmlns:')) visit(key, entry, namespaces, depth + 1)
  }
  visit('', doc, {}, 0)
  if (!descriptions) throw new Error('유효한 RDF namespace의 rdf:Description을 찾을 수 없습니다.')
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

  // ── Colour Grading / Split Toning → native 3-way color grade ──
  // Luxinus now has real color-grading wheels, so map the crs regions directly:
  // Hue 0–360, Saturation 0–100, Luminance −100…100 all line up. Legacy Split
  // Toning maps onto the shadow/highlight wheels.
  const cgRegions: { region: 'shadows' | 'midtones' | 'highlights' | 'global'; prefix: string }[] = [
    { region: 'shadows', prefix: 'ColorGradeShadow' },
    { region: 'midtones', prefix: 'ColorGradeMidtone' },
    { region: 'highlights', prefix: 'ColorGradeHighlight' },
    { region: 'global', prefix: 'ColorGradeGlobal' }
  ]
  const graded: string[] = []
  for (const { region, prefix } of cgRegions) {
    const h = use(`${prefix}Hue`)
    const s = use(`${prefix}Sat`)
    const l = use(`${prefix}Lum`)
    if (h !== null) edits.colorGrade[region].hue = clamp(h, 0, 360)
    if (s !== null) edits.colorGrade[region].sat = clamp(s, 0, 100)
    if (l !== null) edits.colorGrade[region].lum = clamp(l)
    if (s || l) graded.push(region)
  }
  // Legacy split-toning (only fill regions the modern keys didn't set).
  const stShadowH = use('SplitToningShadowHue')
  const stShadowS = use('SplitToningShadowSaturation')
  if (stShadowS !== null && stShadowS > 0 && edits.colorGrade.shadows.sat === 0) {
    edits.colorGrade.shadows.hue = clamp(stShadowH ?? 0, 0, 360)
    edits.colorGrade.shadows.sat = clamp(stShadowS, 0, 100)
    graded.push('shadows')
  }
  const stHighH = use('SplitToningHighlightHue')
  const stHighS = use('SplitToningHighlightSaturation')
  if (stHighS !== null && stHighS > 0 && edits.colorGrade.highlights.sat === 0) {
    edits.colorGrade.highlights.hue = clamp(stHighH ?? 0, 0, 360)
    edits.colorGrade.highlights.sat = clamp(stHighS, 0, 100)
    graded.push('highlights')
  }
  const blend = use('ColorGradeBlending')
  if (blend !== null) edits.colorGrade.blending = clamp(blend, 0, 100)
  const balance = use('SplitToningBalance')
  if (balance !== null) edits.colorGrade.balance = clamp(balance)
  if (graded.length) mapped.push(`Colour grading (${[...new Set(graded)].join(', ')})`)

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
