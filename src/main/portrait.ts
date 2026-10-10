import { ipcMain } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import type { PortraitAnalyzeRequest, PortraitImageRequest } from '../shared/portrait'
import { assertTrustedSender } from './file-policy'
import { PortraitService } from './portrait-service'
import { runPortraitSegmentation, getPortraitModelFingerprint, getPortraitGeneration, cancelPortraitSegmentation, isPortraitModelBusy } from './portrait-model-runner'

const service = new PortraitService({ fingerprint: getPortraitModelFingerprint, generation: getPortraitGeneration, infer: runPortraitSegmentation, cancel: cancelPortraitSegmentation })
export const analyzePortrait = (ownerId: number, input: PortraitAnalyzeRequest) => service.analyze(ownerId, input)
export const analyzePortraitImage = (ownerId: number, input: PortraitImageRequest) => service.analyze(ownerId, input)
export const cancelPortrait = (ownerId: number, requestId: string) => service.cancel(ownerId, requestId)
export const isPortraitBusy = (): boolean => service.isBusy() || isPortraitModelBusy()
export const shutdownPortrait = (): Promise<void> => service.shutdown()

export function registerPortraitHandlers(): void {
  ipcMain.handle(IpcChannels.portrait.status, async event => {
    assertTrustedSender(event)
    try { const modelFingerprint = await getPortraitModelFingerprint(); return { modelAvailable: !!modelFingerprint, modelFingerprint, message: null } }
    catch (error) { return { modelAvailable: false, message: (error as Error).message } }
  })
  ipcMain.handle(IpcChannels.portrait.analyze, (event, input: PortraitAnalyzeRequest) => { assertTrustedSender(event); return analyzePortrait(event.sender.id, input) })
  ipcMain.handle(IpcChannels.portrait.cancel, (event, requestId: string) => { assertTrustedSender(event); return cancelPortrait(event.sender.id, requestId) })
}
