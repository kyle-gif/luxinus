export const PORTRAIT_REGIONS = ['person', 'face', 'eyes', 'nose', 'mouth', 'skin', 'clothes', 'hair'] as const
export type PortraitRegion = (typeof PORTRAIT_REGIONS)[number]
export const PORTRAIT_LABELS: Record<PortraitRegion, string> = {
  person: '인물 전체', face: '얼굴', eyes: '눈', nose: '코', mouth: '입', skin: '피부', clothes: '옷', hair: '머리카락'
}
export const SEMANTIC_MAX_EDGE = 512
export const SEMANTIC_MAX_MASKS = 16
export interface PortraitBounds { x: number; y: number; width: number; height: number }
export interface PortraitSourceStamp { pathHash: string; mtimeMs: number; size: number; ctimeMs: number; dev: number; ino: number }

/** Lossless source-space coverage; sufficient to render without the model. */
export interface SemanticGeom {
  version: 1
  space: 'source'
  encoding: 'gray8-base64'
  width: number
  height: number
  coverage: string
  region: PortraitRegion
  bounds: PortraitBounds
  modelFingerprint: string
  source: PortraitSourceStamp
  inputHash: string
}
export interface PortraitAnalyzeRequest {
  requestId: string
  filePath: string
  sourceMtimeMs: number
  sourceSize: number
  rgba: Uint8Array
  width: number
  height: number
  regions?: PortraitRegion[]
}
export type PortraitImageRequest = Omit<PortraitAnalyzeRequest, 'rgba' | 'width' | 'height'> & { dataUrl: string }
export interface PortraitRegionResult {
  region: PortraitRegion
  label: string
  bounds: PortraitBounds
  coverageFraction: number
  semantic: SemanticGeom
}
export interface PortraitAnalyzeResult {
  ok: boolean
  regions?: PortraitRegionResult[]
  modelFingerprint?: string
  facesDetected?: number
  warnings?: string[]
  message?: string
}
export interface PortraitStatus { modelAvailable: boolean; loaded?: boolean; modelFingerprint?: string | null; message?: string | null }
export interface PortraitApi {
  status(): Promise<PortraitStatus>
  analyze(input: PortraitAnalyzeRequest): Promise<PortraitAnalyzeResult>
  cancel(requestId: string): Promise<boolean>
}
export interface PortraitInferenceInput { rgba: Uint8Array; width: number; height: number; requestId: string; regions?: PortraitRegion[] }
export interface PortraitInferenceResult {
  ok: boolean
  width?: number
  height?: number
  regions?: { region: PortraitRegion; coverage: Uint8Array; bounds: PortraitBounds }[]
  modelFingerprint?: string
  facesDetected?: number
  warnings?: string[]
  message?: string
}

export function encodeSemanticCoverage(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768))
  return btoa(text)
}
export function decodeSemanticCoverage(value: Pick<SemanticGeom, 'width' | 'height' | 'coverage'>): Uint8Array {
  const { width, height, coverage } = value
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > SEMANTIC_MAX_EDGE || height > SEMANTIC_MAX_EDGE) throw new Error('인물 마스크 크기는 최대 512×512여야 합니다.')
  if (typeof coverage !== 'string' || coverage.length !== 4 * Math.ceil(width * height / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(coverage)) throw new Error('인물 마스크 픽셀 형식이 유효하지 않습니다.')
  const binary = atob(coverage)
  const result = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i)
  if (result.length !== width * height || encodeSemanticCoverage(result) !== coverage) throw new Error('인물 마스크 픽셀 길이가 유효하지 않습니다.')
  return result
}
export function validateSemanticGeom(value: unknown): asserts value is SemanticGeom {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('인물 마스크 정보가 필요합니다.')
  const v = value as SemanticGeom
  if (v.version !== 1 || v.space !== 'source' || v.encoding !== 'gray8-base64' || !PORTRAIT_REGIONS.includes(v.region)) throw new Error('지원하지 않는 인물 마스크 형식입니다.')
  if (typeof v.modelFingerprint !== 'string' || !/^[a-zA-Z0-9:._-]{16,300}$/.test(v.modelFingerprint) || !/^[a-f0-9]{64}$/.test(v.inputHash)) throw new Error('인물 마스크 모델·입력 식별자가 유효하지 않습니다.')
  if (!v.source || !/^[a-f0-9]{64}$/.test(v.source.pathHash) || ![v.source.mtimeMs, v.source.ctimeMs].every(Number.isFinite) || ![v.source.size, v.source.dev, v.source.ino].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('인물 마스크 원본 식별자가 유효하지 않습니다.')
  const b = v.bounds
  if (!b || ![b.x, b.y, b.width, b.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) || b.width <= 0 || b.height <= 0 || b.x + b.width > 1.000001 || b.y + b.height > 1.000001) throw new Error('인물 마스크 영역이 유효하지 않습니다.')
  decodeSemanticCoverage(v)
}
