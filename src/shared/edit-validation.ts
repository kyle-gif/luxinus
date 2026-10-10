import { coerceEditState, defaultEditState, HSL_BANDS, COLOR_GRADE_REGIONS, MASK_ADJUST_KEYS, type EditState } from './edits'
import { SEMANTIC_MAX_MASKS, validateSemanticGeom } from './portrait'

function record(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: 객체가 필요합니다.`)
}
function number(value: unknown, min: number, max: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${label}: ${min}~${max} 범위의 수치가 필요합니다.`)
  }
}
function boolean(value: unknown, label: string): void {
  if (typeof value !== 'boolean') throw new Error(`${label}: 참/거짓 값이 필요합니다.`)
}
function safeTree(value: unknown, depth = 0, budget = { remaining: 250000, characters: 8 * 1024 * 1024 }, keyName = ''): void {
  if (--budget.remaining < 0 || depth > 24) throw new Error('보정 데이터가 너무 큽니다.')
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('보정 값은 유한한 수치여야 합니다.')
  if (typeof value === 'string') {
    budget.characters -= value.length
    if (budget.characters < 0 || value.length > (keyName === 'coverage' ? 349528 : 10000)) throw new Error('보정 텍스트가 너무 깁니다.')
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('허용되지 않는 보정 키입니다.')
      safeTree(child, depth + 1, budget, key)
    }
  } else if (value !== null && !['number', 'string', 'boolean', 'undefined'].includes(typeof value)) throw new Error('직렬화 가능한 보정 값이 필요합니다.')
}
function geometry(value: unknown, kind: string): void {
  record(value, '마스크 좌표')
  if (kind === 'radial') {
    for (const key of ['cx', 'cy']) number(value[key], -10, 10, key)
    for (const key of ['rx', 'ry']) number(value[key], 0, 10, key)
    number(value.feather, 0, 1, 'feather'); boolean(value.invert, 'invert')
  } else if (kind === 'linear') {
    for (const key of ['x1', 'y1', 'x2', 'y2']) number(value[key], -10, 10, key)
  } else if (kind === 'lumRange') {
    for (const key of ['lo', 'hi', 'featherLo', 'featherHi']) number(value[key], 0, 1, key)
    if ((value.lo as number) > (value.hi as number)) throw new Error('명도 범위가 뒤바뀌었습니다.')
  } else if (kind === 'colorRange') {
    if (!Array.isArray(value.rgb) || value.rgb.length !== 3) throw new Error('RGB 세 값이 필요합니다.')
    value.rgb.forEach((v) => number(v, 0, 255, 'RGB'))
    number(value.tolerance, 0, 1, 'tolerance'); number(value.feather, 0, 1, 'feather')
  } else if (kind === 'semantic') {
    validateSemanticGeom(value)
  } else if (kind === 'brush') {
    if (!Array.isArray(value.strokes) || value.strokes.length > 10000) throw new Error('브러시 획이 유효하지 않습니다.')
    for (const stroke of value.strokes) {
      record(stroke, '브러시 획'); number(stroke.radius, 0, 2, '브러시 반경'); boolean(stroke.erase, 'erase')
      if (!Array.isArray(stroke.points) || stroke.points.length > 10000) throw new Error('브러시 좌표가 유효하지 않습니다.')
      for (const point of stroke.points) {
        record(point, '브러시 좌표'); number(point.x, -10, 10, 'x'); number(point.y, -10, 10, 'y')
      }
    }
  } else throw new Error('지원하지 않는 마스크 종류입니다.')
}

/** Migrate absent legacy fields, but reject wrong types and invalid values. */
export function validateEditState(input: unknown): EditState {
  record(input, '보정'); safeTree(input)
  for (const key of ['curves', 'hsl', 'colorGrade']) if (key in input) record(input[key], key)
  if ('crop' in input && input.crop !== null) record(input.crop, '자르기')
  if ('masks' in input) {
    if (!Array.isArray(input.masks)) throw new Error('마스크 목록은 배열이어야 합니다.')
    for (const mask of input.masks) {
      record(mask, '마스크')
      if ('adjust' in mask) record(mask.adjust, '마스크 보정')
      if ('refine' in mask) {
        if (!Array.isArray(mask.refine)) throw new Error('마스크 조합 목록은 배열이어야 합니다.')
        for (const refine of mask.refine) record(refine, '마스크 조합')
      }
    }
  }
  const edits = coerceEditState(input)
  for (const [key, value] of Object.entries(defaultEditState())) {
    if (typeof value === 'number') number(edits[key as keyof EditState],
      ['grain', 'sharpening', 'denoise'].includes(key) ? 0 : key === 'rotate' ? -36000 : -100,
      key === 'rotate' ? 36000 : 100, key)
  }
  boolean(edits.flipH, 'flipH'); boolean(edits.flipV, 'flipV')
  for (const channel of ['rgb', 'r', 'g', 'b'] as const) {
    const points = edits.curves[channel]
    if (!Array.isArray(points) || points.length < 2 || points.length > 1024) throw new Error('톤 커브 점 개수가 유효하지 않습니다.')
    let previous = -1
    for (const point of points) {
      record(point, '톤 커브'); number(point.x, 0, 1, 'curve.x'); number(point.y, 0, 1, 'curve.y')
      if (point.x <= previous) throw new Error('톤 커브 입력 좌표는 증가해야 합니다.')
      previous = point.x
    }
  }
  for (const band of HSL_BANDS) {
    record(edits.hsl[band], 'HSL')
    for (const key of ['hue', 'sat', 'lum'] as const) number(edits.hsl[band][key], -100, 100, `hsl.${band}.${key}`)
  }
  for (const region of COLOR_GRADE_REGIONS) {
    const value = edits.colorGrade[region]; record(value, '컬러 그레이딩')
    number(value.hue, 0, 360, 'hue'); number(value.sat, 0, 100, 'sat'); number(value.lum, -100, 100, 'lum')
  }
  number(edits.colorGrade.blending, 0, 100, 'blending'); number(edits.colorGrade.balance, -100, 100, 'balance')
  if (edits.crop !== null) {
    record(edits.crop, '자르기')
    for (const key of ['x', 'y', 'w', 'h'] as const) number(edits.crop[key], 0, 1, `crop.${key}`)
    if (edits.crop.w <= 0 || edits.crop.h <= 0 || edits.crop.x + edits.crop.w > 1.00001 || edits.crop.y + edits.crop.h > 1.00001) throw new Error('자르기 영역이 사진 경계를 벗어납니다.')
  }
  if (edits.masks.length > 256) throw new Error('마스크 개수 제한을 초과했습니다.')
  if (edits.masks.filter(mask => mask.kind === 'semantic').length > SEMANTIC_MAX_MASKS) throw new Error('인물 마스크는 최대 16개까지 저장할 수 있습니다.')
  for (const mask of edits.masks) {
    record(mask, '마스크')
    if (typeof mask.id !== 'string' || typeof mask.name !== 'string') throw new Error('마스크 이름과 ID가 필요합니다.')
    boolean(mask.enabled, 'enabled')
    if (mask.density !== undefined) number(mask.density, 0, 1, 'density')
    for (const key of MASK_ADJUST_KEYS) number(mask.adjust[key], key === 'sharpness' ? 0 : -100, 100, key)
    const key = mask.kind === 'lumRange' ? 'lum' : mask.kind === 'colorRange' ? 'color' : mask.kind
    geometry(mask[key], mask.kind)
    for (const refine of mask.refine ?? []) {
      if (!['add', 'subtract', 'intersect'].includes(refine.mode) || typeof refine.id !== 'string') throw new Error('마스크 조합이 유효하지 않습니다.')
      boolean(refine.invert, 'invert')
      if (!['lumRange', 'colorRange'].includes(refine.kind)) throw new Error('지원하지 않는 마스크 조합입니다.')
      geometry(refine.kind === 'lumRange' ? refine.lum : refine.color, refine.kind)
    }
  }
  return edits
}
