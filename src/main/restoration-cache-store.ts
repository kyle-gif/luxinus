import { promises as fs } from 'node:fs'
import path from 'node:path'
import { assertAuthorizedPhoto } from './file-policy'
import { atomicReplace, contentHash, readRegularFile, serializeFile } from './safe-file'
import type { RestorationPreviewRequest } from '../shared/ai'

const MAGIC = Buffer.from('LUXREST1')
const MAX_PIXELS = 1600 * 1600
const MAX_FILE_BYTES = MAX_PIXELS * 4 + 4096 + 12
const FORMAT_VERSION = 1
type SourceIdentity = { pathHash: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface Descriptor { version: number; modelFingerprint: string; source: SourceIdentity; inputHash: string; width: number; height: number }
interface Header { descriptor: Descriptor; outputHash: string; createdAt: string }

export interface RestorationCacheTicket {
  key: string
  descriptor: Descriptor
  assertCurrent(): Promise<void>
}

function pixels(rgba: unknown, width: unknown, height: unknown): asserts rgba is Uint8Array {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || (width as number) < 1 || (height as number) < 1 ||
      (width as number) > 1600 || (height as number) > 1600 || !(rgba instanceof Uint8Array) || rgba.length !== (width as number) * (height as number) * 4) {
    throw new Error('복원 캐시 입력은 최대 1600×1600 RGBA 미리보기여야 합니다.')
  }
}
function fingerprint(value: string): void {
  if (typeof value !== 'string' || value.length > 200 || !/^[a-zA-Z0-9:._-]{16,200}$/.test(value)) throw new Error('검증된 복원 모델 식별자가 필요합니다.')
}
async function sourceIdentity(filePath: string): Promise<SourceIdentity> {
  const source = await assertAuthorizedPhoto(filePath)
  const stat = await fs.lstat(source)
  return { pathHash: contentHash(source), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
}

/** Lossless RGBA cache. Only generated SHA-256 filenames are accepted. */
export class RestorationCacheStore {
  constructor(private readonly directory: string) {}
  private async ensureDirectory(): Promise<void> {
    if (!path.isAbsolute(this.directory) || path.resolve(this.directory) !== this.directory) throw new Error('복원 캐시 폴더 경로가 유효하지 않습니다.')
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(this.directory) !== this.directory) throw new Error('복원 캐시는 앱 전용 일반 폴더에만 저장할 수 있습니다.')
  }
  private file(key: string): string {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('복원 캐시 식별자가 유효하지 않습니다.')
    return path.join(this.directory, `${key}.rgba`)
  }
  async prepare(input: RestorationPreviewRequest, modelFingerprint: string, cancelled: () => boolean = () => false): Promise<RestorationCacheTicket> {
    pixels(input.rgba, input.width, input.height)
    fingerprint(modelFingerprint)
    const source = await sourceIdentity(input.filePath)
    if (!Number.isFinite(input.sourceMtimeMs) || !Number.isSafeInteger(input.sourceSize) || input.sourceSize < 0 ||
        input.sourceMtimeMs !== source.mtimeMs || input.sourceSize !== source.size) throw new Error('원본이 미리보기를 만든 시점과 다릅니다. 폴더를 다시 열어 최신 사진을 불러와 주세요.')
    const descriptor: Descriptor = { version: FORMAT_VERSION, modelFingerprint, source,
      inputHash: contentHash(Buffer.from(input.rgba)), width: input.width, height: input.height }
    const serialized = JSON.stringify(descriptor)
    return { key: contentHash(serialized), descriptor, assertCurrent: async () => {
      if (cancelled()) throw new Error('복원을 취소했습니다. 이전 요청의 결과는 저장하거나 표시하지 않습니다.')
      if (JSON.stringify(await sourceIdentity(input.filePath)) !== JSON.stringify(descriptor.source)) throw new Error('복원 중 원본 파일이 변경되었습니다. 사진을 다시 열어 주세요.')
      if (cancelled()) throw new Error('복원을 취소했습니다. 이전 요청의 결과는 저장하거나 표시하지 않습니다.')
    } }
  }
  async read(ticket: RestorationCacheTicket): Promise<Uint8Array | null> {
    await ticket.assertCurrent()
    await this.ensureDirectory()
    const data = await readRegularFile(this.file(ticket.key), MAX_FILE_BYTES)
    if (!data) return null
    if (data.length < 12 || !data.subarray(0, 8).equals(MAGIC)) throw new Error('저장된 복원 결과의 형식이 손상되었습니다.')
    const headerSize = data.readUInt32BE(8)
    if (headerSize > 4096 || headerSize < 2 || data.length < 12 + headerSize) throw new Error('저장된 복원 결과의 머리글이 손상되었습니다.')
    let header: Header
    try { header = JSON.parse(data.subarray(12, 12 + headerSize).toString('utf8')) } catch { throw new Error('저장된 복원 결과의 정보를 읽지 못했습니다.') }
    const rgba = data.subarray(12 + headerSize)
    if (JSON.stringify(header.descriptor) !== JSON.stringify(ticket.descriptor) || header.outputHash !== contentHash(rgba) ||
        rgba.length !== ticket.descriptor.width * ticket.descriptor.height * 4) throw new Error('저장된 복원 결과가 현재 사진·모델·입력과 일치하지 않습니다.')
    await ticket.assertCurrent()
    return new Uint8Array(rgba)
  }
  async write(ticket: RestorationCacheTicket, rgba: Uint8Array): Promise<void> {
    pixels(rgba, ticket.descriptor.width, ticket.descriptor.height)
    const header = Buffer.from(JSON.stringify({ descriptor: ticket.descriptor, outputHash: contentHash(Buffer.from(rgba)), createdAt: new Date().toISOString() } satisfies Header))
    if (header.length > 4096) throw new Error('복원 결과 정보가 너무 큽니다.')
    const prefix = Buffer.alloc(12); MAGIC.copy(prefix); prefix.writeUInt32BE(header.length, 8)
    const data = Buffer.concat([prefix, header, Buffer.from(rgba)])
    await this.ensureDirectory()
    const file = this.file(ticket.key)
    await serializeFile(file, async () => {
      const previous = await readRegularFile(file, MAX_FILE_BYTES)
      await atomicReplace(file, data, previous ? contentHash(previous) : null, async () => { await this.ensureDirectory(); await ticket.assertCurrent() })
    })
  }
}
