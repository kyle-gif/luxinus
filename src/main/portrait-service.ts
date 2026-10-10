import { promises as fs } from 'node:fs'
import sharp from 'sharp'
import { assertAuthorizedPhoto } from './file-policy'
import { contentHash } from './safe-file'
import { PORTRAIT_LABELS, PORTRAIT_REGIONS, encodeSemanticCoverage, validateSemanticGeom, type PortraitAnalyzeRequest, type PortraitAnalyzeResult, type PortraitImageRequest, type PortraitInferenceInput, type PortraitInferenceResult, type PortraitSourceStamp } from '../shared/portrait'

export interface PortraitRuntime {
  fingerprint(): Promise<string | null>
  generation(): number
  infer(input: PortraitInferenceInput): Promise<PortraitInferenceResult>
  cancel(): void | Promise<void>
}
async function sourceStamp(filePath: string): Promise<PortraitSourceStamp> {
  const source = await assertAuthorizedPhoto(filePath)
  const stat = await fs.lstat(source)
  return { pathHash: contentHash(source), mtimeMs: stat.mtimeMs, size: stat.size, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino }
}
function dimensions(rgba: unknown, width: number, height: number): asserts rgba is Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > 4_000_000 || !(rgba instanceof Uint8Array) || rgba.length !== width * height * 4) throw new Error('인물 분석에는 최대 2048픽셀·4MP의 원본 미리보기가 필요합니다.')
}

export class PortraitService {
  private active: { owner: number; id: string; cancelled: boolean } | null = null
  constructor(private readonly runtime: PortraitRuntime) {}
  isBusy(): boolean { return this.active !== null }
  async cancel(owner: number, id: string): Promise<boolean> {
    if (!this.active || this.active.owner !== owner || this.active.id !== id) return false
    this.active.cancelled = true
    await this.runtime.cancel()
    return true
  }
  async shutdown(): Promise<void> {
    if (this.active) this.active.cancelled = true
    await this.runtime.cancel()
  }
  async analyze(owner: number, input: PortraitAnalyzeRequest | PortraitImageRequest): Promise<PortraitAnalyzeResult> {
    if (!Number.isSafeInteger(owner) || owner < 0 || !input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) return { ok: false, message: '인물 분석 요청 식별자가 유효하지 않습니다.' }
    if (this.active) return { ok: false, message: '다른 인물 분석이 진행 중입니다.' }
    const job = { owner, id: input.requestId, cancelled: false }
    this.active = job
    const generation = this.runtime.generation()
    try {
      const source = await sourceStamp(input.filePath)
      if (input.sourceMtimeMs !== source.mtimeMs || input.sourceSize !== source.size) throw new Error('원본이 미리보기를 만든 시점과 다릅니다. 사진을 다시 열어 주세요.')
      const assertCurrent = async (): Promise<void> => {
        if (job.cancelled || generation !== this.runtime.generation()) throw new Error('인물 분석을 취소했습니다.')
        if (JSON.stringify(source) !== JSON.stringify(await sourceStamp(input.filePath))) throw new Error('분석 중 원본 사진이 변경되었습니다. 사진을 다시 열어 주세요.')
        if (job.cancelled || generation !== this.runtime.generation()) throw new Error('인물 분석을 취소했습니다.')
      }
      if (input.regions !== undefined && (!Array.isArray(input.regions) || input.regions.length < 1 || input.regions.length > PORTRAIT_REGIONS.length || new Set(input.regions).size !== input.regions.length || input.regions.some(region => !PORTRAIT_REGIONS.includes(region)))) throw new Error('지원하지 않는 인물 부위입니다.')
      const modelFingerprint = await this.runtime.fingerprint()
      if (!modelFingerprint) throw new Error('인물 분석 모델이 설치되지 않았습니다.')
      await assertCurrent()
      let rgba: Uint8Array, width: number, height: number
      if ('dataUrl' in input) {
        if (typeof input.dataUrl !== 'string' || input.dataUrl.length > 12 * 1024 * 1024 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(input.dataUrl)) throw new Error('원본 미리보기 JPEG 형식이 유효하지 않습니다.')
        const bytes = Buffer.from(input.dataUrl.slice(input.dataUrl.indexOf(',') + 1), 'base64')
        const decoded = await sharp(bytes, { limitInputPixels: 4_000_000 }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        rgba = new Uint8Array(decoded.data); width = decoded.info.width; height = decoded.info.height
      } else { rgba = input.rgba; width = input.width; height = input.height }
      dimensions(rgba, width, height)
      await assertCurrent()
      const inputHash = contentHash(Buffer.from(rgba))
      const result = await this.runtime.infer({ rgba, width, height, requestId: input.requestId, regions: input.regions })
      await assertCurrent()
      if (!result.ok) return { ok: false, message: result.message ?? '인물 분석 결과를 만들지 못했습니다.' }
      if (result.modelFingerprint !== modelFingerprint || !Number.isSafeInteger(result.width) || !Number.isSafeInteger(result.height) || !result.width || !result.height || result.width < 1 || result.height < 1 || result.width > 512 || result.height > 512 || Math.abs(result.width / result.height - width / height) > 2 / result.height || !Array.isArray(result.regions) || result.regions.length > PORTRAIT_REGIONS.length) throw new Error('인물 모델 결과의 크기 또는 식별자가 유효하지 않습니다.')
      const seen = new Set<string>()
      const regions: NonNullable<PortraitAnalyzeResult['regions']> = []
      for (const part of result.regions) {
        if (!PORTRAIT_REGIONS.includes(part.region) || seen.has(part.region) || (input.regions && !input.regions.includes(part.region)) || !(part.coverage instanceof Uint8Array) || part.coverage.length !== result.width * result.height) throw new Error('인물 부위 픽셀 결과가 유효하지 않습니다.')
        seen.add(part.region)
        let sum = 0
        for (const value of part.coverage) sum += value
        if (!sum) continue
        const semantic = { version: 1, space: 'source', encoding: 'gray8-base64', width: result.width, height: result.height, coverage: encodeSemanticCoverage(part.coverage), region: part.region, bounds: part.bounds, modelFingerprint, source, inputHash } as const
        validateSemanticGeom(semantic)
        regions.push({ region: part.region, label: PORTRAIT_LABELS[part.region], bounds: part.bounds, coverageFraction: sum / (255 * part.coverage.length), semantic })
      }
      await assertCurrent()
      return { ok: true, regions, modelFingerprint, facesDetected: Number.isSafeInteger(result.facesDetected) && result.facesDetected! >= 0 ? result.facesDetected : undefined,
        warnings: Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string').slice(0, 12).map(value => value.slice(0, 500)) : [] }
    } catch (error) { return { ok: false, message: (error as Error).message } }
    finally { if (this.active === job) this.active = null }
  }
}
