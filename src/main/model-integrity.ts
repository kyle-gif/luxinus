import { createHash } from 'node:crypto'
import { createReadStream, promises as fs, type Stats } from 'node:fs'

function identity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

/** Rehash replaced/modified files; a filename alone never identifies a model. */
export class ModelIntegrity {
  private verified: { path: string; identity: string; sha256: string } | null = null

  async verify(file: string, expectedSha256: string): Promise<void> {
    const before = await fs.stat(file)
    if (!before.isFile()) throw new Error('노이즈 제거 모델이 일반 파일이 아닙니다.')
    const key = identity(before)
    if (this.verified?.path === file && this.verified.identity === key && this.verified.sha256 === expectedSha256) return
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(file)) hash.update(chunk)
    const after = await fs.stat(file)
    if (identity(after) !== key) throw new Error('검증 중 노이즈 제거 모델이 변경되었습니다. 다시 시도해 주세요.')
    if (hash.digest('hex') !== expectedSha256) throw new Error('노이즈 제거 모델의 체크섬이 검증된 NAFNet SIDD 모델과 다릅니다.')
    this.verified = { path: file, identity: key, sha256: expectedSha256 }
  }
}
