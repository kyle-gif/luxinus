import { app } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { PORTRAIT_MODELS, PORTRAIT_MODEL_FINGERPRINT, type PortraitModelKey, type PortraitModelPaths } from '../shared/portrait-model'

const verified = new Map<string, string>()
export async function resolvePortraitModels(): Promise<PortraitModelPaths | null> {
  const result = {} as PortraitModelPaths
  for (const key of Object.keys(PORTRAIT_MODELS) as PortraitModelKey[]) {
    const model = PORTRAIT_MODELS[key]
    const file = [app.getPath('userData'), app.getAppPath(), process.resourcesPath ?? ''].map(root => path.join(root, 'models', model.filename)).find(candidate => existsSync(candidate))
    if (!file) return null
    const before = await fs.stat(file)
    const identity = [before.dev, before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':')
    if (!before.isFile() || before.size !== model.bytes) throw new Error(`${model.id} 인물 모델의 파일 크기가 올바르지 않습니다.`)
    if (verified.get(file) !== identity) {
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(file)) hash.update(chunk)
      const after = await fs.stat(file)
      if ([after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(':') !== identity) throw new Error('검증 중 인물 모델 파일이 변경되었습니다.')
      if (hash.digest('hex') !== model.sha256) throw new Error(`${model.id} 인물 모델 체크섬 검증에 실패했습니다.`)
      verified.set(file, identity)
    }
    result[key] = file
  }
  return result
}
export async function getPortraitModelFingerprint(): Promise<string | null> {
  return await resolvePortraitModels() ? PORTRAIT_MODEL_FINGERPRINT : null
}
