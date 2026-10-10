import { constants, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const contentHash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
export const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'

export async function readRegularFile(target: string, maxBytes = 16 * 1024 * 1024): Promise<Buffer | null> {
  let handle
  try {
    handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw new Error('일반 파일만 읽을 수 있으며 파일 크기 제한을 초과할 수 없습니다.')
    }
    const buffer = Buffer.alloc(stat.size + 1)
    let used = 0
    while (used < buffer.length) {
      const result = await handle.read(buffer, used, buffer.length - used, null)
      if (!result.bytesRead) break
      used += result.bytesRead
    }
    if (used > stat.size) throw new Error('파일을 읽는 동안 내용이 변경되었습니다. 다시 시도해 주세요.')
    return buffer.subarray(0, used)
  } finally {
    await handle.close()
  }
}

export function decodeUtf8(buffer: Buffer): string {
  // Reject lossy decoding: unsupported source encodings must never be rewritten.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer)
}

const queues = new Map<string, Promise<unknown>>()
export async function serializeFile<T>(target: string, action: () => Promise<T>): Promise<T> {
  const before = queues.get(target) ?? Promise.resolve()
  const result = before.catch(() => {}).then(action)
  queues.set(target, result)
  try { return await result } finally { if (queues.get(target) === result) queues.delete(target) }
}

/** Same-directory, exclusive temporary file; check the reviewed hash again at
 * commit time. Rename replaces the directory entry and never writes its target.
 * App writes are serialized by callers. External editors receive conflict errors.
 */
export async function atomicReplace(
  target: string,
  data: string | Buffer,
  expectedHash: string | null,
  validateLocation: () => Promise<unknown>
): Promise<string> {
  await validateLocation()
  const directory = path.dirname(target)
  const parent = await fs.lstat(directory)
  if (!parent.isDirectory() || parent.isSymbolicLink() || await fs.realpath(directory) !== directory) {
    throw new Error('심볼릭 링크를 통해 저장할 수 없습니다.')
  }
  const temp = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`)
  let handle
  try {
    handle = await fs.open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await validateLocation()
    const now = await fs.lstat(directory)
    if (parent.dev !== now.dev || parent.ino !== now.ino || await fs.realpath(directory) !== directory) {
      throw new Error('저장 중 폴더가 변경되었습니다.')
    }
    const current = await readRegularFile(target)
    if ((current === null ? null : contentHash(current)) !== expectedHash) {
      throw new Error('파일이 다른 작업에서 변경되었습니다. 다시 불러온 뒤 적용해 주세요. (충돌)')
    }
    if (expectedHash === null) {
      // link is exclusive: an external creation between hash check and commit
      // cannot be overwritten. Both names are on the same filesystem.
      await fs.link(temp, target)
      await fs.unlink(temp)
    } else {
      await fs.rename(temp, target)
    }
    return contentHash(data)
  } finally {
    await handle?.close().catch(() => {})
    await fs.rm(temp, { force: true }).catch(() => {})
  }
}
