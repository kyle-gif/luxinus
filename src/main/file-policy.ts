import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

// Capabilities are granted only by native pickers and main-process scans. A
// renderer-supplied path never grants access, even when it exists on disk.
const renderers = new WeakMap<WebContents, string>()
type Identity = { dev: number; ino: number }
const libraries = new Map<string, Identity>()
const photos = new Map<string, { root: string; identity: Identity }>()
const exportDirs = new Map<string, Identity>()

export function trustRenderer(contents: WebContents, expectedUrl?: string): void {
  const url = new URL(expectedUrl ?? contents.getURL())
  url.hash = ''
  renderers.set(contents, url.href)
}

export function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!renderers.has(event.sender) || event.sender.isDestroyed() ||
      !event.senderFrame || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('허용되지 않은 창의 요청입니다.')
  }
  const url = new URL(event.senderFrame.url)
  url.hash = ''
  if (url.href !== renderers.get(event.sender)) throw new Error('앱 화면 이외의 문서에서는 요청할 수 없습니다.')
}

function checkedPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192 || value.includes('\0') ||
      !path.isAbsolute(value) || value.split(/[\\/]/).some((part) => part === '..')) {
    throw new Error('유효한 절대 경로가 필요합니다.')
  }
  return path.normalize(value)
}

function sameIdentity(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

export function isInsideDirectory(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function verifyDirectory(dir: string, identity: Identity): Promise<void> {
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameIdentity(identity, stat) || await fs.realpath(dir) !== dir) {
    throw new Error('폴더 위치가 변경되었습니다. 폴더를 다시 열어 주세요.')
  }
}

export async function authorizeLibraryFolder(folder: string): Promise<string> {
  const root = await fs.realpath(checkedPath(folder))
  const stat = await fs.lstat(root)
  if (!stat.isDirectory()) throw new Error('사진 폴더를 선택해 주세요.')
  libraries.set(root, { dev: stat.dev, ino: stat.ino })
  return root
}

export async function authorizeLibraryPhotos<T extends { filePath: string }>(root: string, entries: T[]): Promise<T[]> {
  const identity = libraries.get(root)
  if (!identity) throw new Error('먼저 사진 폴더를 열어 주세요.')
  await verifyDirectory(root, identity)
  const allowed: T[] = []
  for (let offset = 0; offset < entries.length; offset += 64) {
    const results = await Promise.all(entries.slice(offset, offset + 64).map(async (entry) => {
      const target = checkedPath(entry.filePath)
      if (!isInsideDirectory(root, target)) return null
      try {
        const stat = await fs.lstat(target)
        // realpath equality also rejects symlinks in any intermediate folder.
        if (!stat.isFile() || stat.isSymbolicLink() || await fs.realpath(target) !== target) return null
        photos.set(target, { root, identity: { dev: stat.dev, ino: stat.ino } })
        return entry
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }))
    for (const entry of results) if (entry !== null) allowed.push(entry as T)
  }
  return allowed
}

export async function assertAuthorizedPhoto(value: unknown): Promise<string> {
  const target = checkedPath(value)
  const grant = photos.get(target)
  const rootIdentity = grant && libraries.get(grant.root)
  if (!grant || !rootIdentity) throw new Error('열린 라이브러리의 사진만 처리할 수 있습니다.')
  await verifyDirectory(grant.root, rootIdentity)
  let stat
  try {
    stat = await fs.lstat(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('원본을 찾을 수 없습니다. 폴더를 다시 열어 연결해 주세요.')
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || !sameIdentity(stat, grant.identity) || await fs.realpath(target) !== target) {
    throw new Error('원본 위치가 변경되었거나 심볼릭 링크입니다. 폴더를 다시 열어 주세요.')
  }
  return target
}

export async function authorizeExportDirectory(folder: string): Promise<string> {
  const dir = await fs.realpath(checkedPath(folder))
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory()) throw new Error('내보낼 폴더를 선택해 주세요.')
  exportDirs.set(dir, { dev: stat.dev, ino: stat.ino })
  return dir
}

export async function assertExportDirectory(value: unknown): Promise<string> {
  const dir = checkedPath(value)
  const identity = exportDirs.get(dir)
  if (!identity) throw new Error('저장 위치 선택으로 내보낼 폴더를 지정해 주세요.')
  await verifyDirectory(dir, identity)
  return dir
}

export function validatePresetId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) {
    throw new Error('유효하지 않은 프리셋 ID입니다.')
  }
  return value
}
