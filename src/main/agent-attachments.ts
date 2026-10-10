import sharp from 'sharp'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { AgentAttachment } from '../shared/agent-tools'

const MAX_SOURCE_BYTES = 16 * 1024 * 1024
const MAX_CACHE_BYTES = 32 * 1024 * 1024
const TTL = 10 * 60_000
interface Entry { owner: number; attachment: AgentAttachment; expires: number; bytes: number; source: 'current' | 'reference' }

/** User-selected content only; original bytes, paths and metadata are not retained. */
export class AgentAttachments {
  private entries = new Map<string, Entry>()
  constructor(private readonly now: () => number = Date.now) {}
  private prune(): void {
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.entries.delete(id)
  }
  async prepare(owner: number, bytes: Buffer, name: unknown, source: 'current' | 'reference' = 'reference'): Promise<AgentAttachment> {
    if (!bytes.length || bytes.length > MAX_SOURCE_BYTES) throw new Error('첨부 이미지는 파일당 16MB 이하여야 합니다.')
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false, failOn: 'error' })
    const meta = await image.metadata()
    if (!meta.format || !['jpeg', 'png', 'webp', 'tiff', 'heif', 'avif'].includes(meta.format) || (meta.pages ?? 1) > 1) throw new Error('JPEG, PNG, WebP, TIFF, HEIC, AVIF 정지 이미지를 선택해 주세요.')
    // Sharp strips EXIF/ICC/XMP by default. Rotate applies EXIF orientation
    // before the metadata-free JPEG is generated.
    const result = await image.rotate().resize({ width: 1536, height: 1536, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true })
    if (result.data.length > 3 * 1024 * 1024) throw new Error('축소된 이미지가 첨부 크기 제한을 초과했습니다.')
    this.prune()
    const used = [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    if (this.entries.size >= 12 || used + result.data.length > MAX_CACHE_BYTES) throw new Error('첨부 대기 공간이 가득 찼습니다. 사용하지 않는 이미지를 제거해 주세요.')
    const attachment: AgentAttachment = { id: randomUUID(),
      name: typeof name === 'string' ? basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 120) || '첨부 이미지' : '첨부 이미지',
      width: result.info.width, height: result.info.height, previewDataUrl: `data:image/jpeg;base64,${result.data.toString('base64')}` }
    this.entries.set(attachment.id, { owner, attachment, expires: this.now() + TTL, bytes: result.data.length, source })
    return { ...attachment }
  }
  async prepareDataUrl(owner: number, input: unknown): Promise<AgentAttachment> {
    const data = input as { dataUrl?: unknown; name?: unknown } | null
    if (!data || typeof data.dataUrl !== 'string' || data.dataUrl.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) + 128 ||
        !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(data.dataUrl)) throw new Error('첨부 미리보기 형식이 올바르지 않습니다.')
    const encoded = data.dataUrl.slice(data.dataUrl.indexOf(',') + 1)
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) throw new Error('첨부 미리보기 인코딩이 올바르지 않습니다.')
    return this.prepare(owner, bytes, data.name, 'current')
  }
  resolve(owner: number, ids: unknown): string[] {
    this.prune()
    if (!Array.isArray(ids) || ids.length > 4 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) throw new Error('한 요청에는 서로 다른 이미지를 최대 4개 첨부할 수 있습니다.')
    return ids.map(id => {
      const entry = this.entries.get(id)
      if (!entry || entry.owner !== owner) throw new Error('첨부가 만료되었거나 다른 창의 이미지입니다. 다시 첨부해 주세요.')
      return entry.attachment.previewDataUrl
    })
  }
  describe(owner: number, ids: string[]): string {
    this.resolve(owner, ids)
    return ids.map((id, index) => `첨부 ${index + 1}: ${this.entries.get(id)!.source === 'current' ? '현재 편집 사진의 보정 반영 축소본. 현재 보정값과 자르기가 이미 적용된 모습입니다.' : '사용자가 선택한 참고 이미지'}`).join('\n')
  }
  release(owner: number, ids: unknown): void {
    if (!Array.isArray(ids) || ids.length > 12 || ids.some(id => typeof id !== 'string')) throw new Error('잘못된 첨부 ID입니다.')
    for (const id of ids) if (this.entries.get(id)?.owner === owner) this.entries.delete(id)
  }
  clear(): void { this.entries.clear() }
}
