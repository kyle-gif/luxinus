import { ipcMain } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { EditState } from '../shared/edits'
import { assertAuthorizedPhoto, assertTrustedSender } from './file-policy'
import { readRegularFile } from './safe-file'
import { loadEdits, saveEdits, sidecarPath } from './sidecar-store'

export { loadEdits, saveEdits, sidecarPath, readEditSnapshot } from './sidecar-store'

async function editedList(filePaths: string[]): Promise<string[]> {
  if (!Array.isArray(filePaths) || filePaths.length > 50000) throw new Error('사진 목록이 유효하지 않습니다.')
  const edited: string[] = []
  for (let offset = 0; offset < filePaths.length; offset += 64) {
    const results = await Promise.all(filePaths.slice(offset, offset + 64).map(async (filePath) => {
      const photo = await assertAuthorizedPhoto(filePath)
      return await readRegularFile(sidecarPath(photo)) === null ? null : photo
    }))
    edited.push(...results.filter((photo): photo is string => photo !== null))
  }
  return edited
}

export function registerEditHandlers(): void {
  ipcMain.handle(IpcChannels.edits.load, (event, filePath: string) => {
    assertTrustedSender(event)
    return loadEdits(filePath, true)
  })
  ipcMain.handle(IpcChannels.edits.save, (event, filePath: string, edits: EditState) => {
    assertTrustedSender(event)
    return saveEdits(filePath, edits)
  })
  ipcMain.handle(IpcChannels.edits.editedList, (event, filePaths: string[]) => {
    assertTrustedSender(event)
    return editedList(filePaths)
  })
}
