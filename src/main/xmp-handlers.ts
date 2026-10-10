import { app, dialog, ipcMain } from 'electron'
import path from 'node:path'
import { IpcChannels } from '../shared/ipc-channels'
import { assertTrustedSender } from './file-policy'
import { XmpPatchService } from './xmp-patch'

let activeWrites = 0
export const isXmpBusy = (): boolean => activeWrites > 0
async function writing<T>(operation: () => Promise<T>): Promise<T> {
  activeWrites++
  try { return await operation() } finally { activeWrites-- }
}

export function registerXmpHandlers(): void {
  const service = new XmpPatchService(path.join(app.getPath('userData'), 'xmp-history'))
  ipcMain.handle(IpcChannels.xmp.open, async (event) => {
    assertTrustedSender(event)
    const result = await dialog.showOpenDialog({ title: '검토할 사진 프리셋 XMP 선택', properties: ['openFile'], filters: [{ name: '사진 프리셋 XMP', extensions: ['xmp'] }] })
    if (result.canceled || !result.filePaths[0]) return null
    return service.open(result.filePaths[0])
  })
  ipcMain.handle(IpcChannels.xmp.propose, (event, documentId: string, patch: Record<string, number>) => {
    assertTrustedSender(event)
    return service.propose(documentId, patch)
  })
  ipcMain.handle(IpcChannels.xmp.apply, (event, proposalId: string) => {
    assertTrustedSender(event)
    return writing(() => service.apply(proposalId))
  })
  ipcMain.handle(IpcChannels.xmp.undo, (event, operationId: string) => {
    assertTrustedSender(event)
    return writing(() => service.undo(operationId))
  })
}
