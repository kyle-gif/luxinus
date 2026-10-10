import { promises as fs } from 'node:fs'
import type { EditState } from '../shared/edits'
import { assertAuthorizedPhoto } from './file-policy'
import { contentHash } from './safe-file'

/** A source-specific mask must never be silently reused for another photo. */
export async function assertSemanticSource(edits: EditState, photoPath: string): Promise<void> {
  const masks = edits.masks.filter(mask => mask.kind === 'semantic')
  if (!masks.length) return
  const photo = await assertAuthorizedPhoto(photoPath)
  const stat = await fs.stat(photo)
  const pathHash = contentHash(photo)
  for (const mask of masks) {
    const source = mask.semantic?.source
    if (!source || source.pathHash !== pathHash || source.mtimeMs !== stat.mtimeMs || source.size !== stat.size || source.ctimeMs !== stat.ctimeMs || source.dev !== stat.dev || source.ino !== stat.ino) throw new Error('인물 마스크의 원본 사진이 현재 사진과 다릅니다. 원래 사진을 다시 열거나 인물 마스크를 다시 만들어 주세요.')
  }
}
