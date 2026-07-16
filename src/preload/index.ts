import { contextBridge, ipcRenderer } from 'electron'
import {
  IpcChannels,
  type OpenFolderResult,
  type PlatformInfo,
  type ProxyResult,
  type ThumbnailReadyPayload
} from '../shared/ipc-channels'
import type { EditState } from '../shared/edits'
import type { ExportItem, ExportOptions, ExportProgress } from '../shared/export'
import type { Preset, XmpImportResult } from '../shared/presets'
import type { DenoiseResult } from '../shared/ai'

// The ONLY bridge between the sandboxed renderer and Node privileges. Every
// method is an explicit, typed invoke — the renderer gets no raw ipcRenderer,
// no Node, no filesystem, no network. This is the enforced local-only boundary.
const api = {
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IpcChannels.app.getVersion),
    getPlatformInfo: (): Promise<PlatformInfo> =>
      ipcRenderer.invoke(IpcChannels.app.getPlatformInfo)
  },
  library: {
    openFolder: (): Promise<OpenFolderResult> =>
      ipcRenderer.invoke(IpcChannels.library.openFolder),
    requestProxy: (filePath: string, mtimeMs: number): Promise<ProxyResult> =>
      ipcRenderer.invoke(IpcChannels.library.requestProxy, filePath, mtimeMs),
    setRating: (filePath: string, rating: number): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.library.setRating, filePath, rating),
    setFlag: (filePath: string, flagged: boolean): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.library.setFlag, filePath, flagged),
    // Subscribe to streamed thumbnail results; returns an unsubscribe fn.
    onThumbnail: (cb: (payload: ThumbnailReadyPayload) => void): (() => void) => {
      const listener = (_e: unknown, payload: ThumbnailReadyPayload): void => cb(payload)
      ipcRenderer.on(IpcChannels.library.thumbnailReady, listener)
      return () => ipcRenderer.removeListener(IpcChannels.library.thumbnailReady, listener)
    }
  },
  edits: {
    load: (filePath: string): Promise<EditState | null> =>
      ipcRenderer.invoke(IpcChannels.edits.load, filePath),
    save: (filePath: string, edits: EditState): Promise<boolean> =>
      ipcRenderer.invoke(IpcChannels.edits.save, filePath, edits),
    editedList: (filePaths: string[]): Promise<string[]> =>
      ipcRenderer.invoke(IpcChannels.edits.editedList, filePaths)
  },
  exportr: {
    pickDir: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.exportr.pickDir),
    run: (
      items: ExportItem[],
      options: ExportOptions
    ): Promise<{ written: string[]; errors: { file: string; message: string }[] }> =>
      ipcRenderer.invoke(IpcChannels.exportr.run, items, options),
    onProgress: (cb: (p: ExportProgress) => void): (() => void) => {
      const listener = (_e: unknown, p: ExportProgress): void => cb(p)
      ipcRenderer.on(IpcChannels.exportr.progress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.exportr.progress, listener)
    }
  },
  presets: {
    list: (): Promise<Preset[]> => ipcRenderer.invoke(IpcChannels.presets.list),
    save: (name: string, edits: EditState): Promise<Preset> =>
      ipcRenderer.invoke(IpcChannels.presets.save, name, edits),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.presets.delete, id),
    importXmp: (): Promise<(XmpImportResult & { preset: Preset }) | null> =>
      ipcRenderer.invoke(IpcChannels.presets.importXmp)
  },
  ai: {
    status: (): Promise<{ modelAvailable: boolean }> =>
      ipcRenderer.invoke(IpcChannels.ai.status),
    denoise: (payload: {
      rgba: Uint8Array
      width: number
      height: number
      strength: number
    }): Promise<DenoiseResult> => ipcRenderer.invoke(IpcChannels.ai.denoise, payload),
    onProgress: (cb: (p: { requestId: string; progress: number }) => void): (() => void) => {
      const listener = (_e: unknown, p: { requestId: string; progress: number }): void => cb(p)
      ipcRenderer.on(IpcChannels.ai.progress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.ai.progress, listener)
    }
  },
  update: {
    check: (): Promise<{ available: boolean; latestVersion: string }> =>
      ipcRenderer.invoke(IpcChannels.update.check)
  }
}

export type LuxinusApi = typeof api

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('luxinus', api)
} else {
  // Should never happen (contextIsolation is forced on), but fail loud in dev.
  throw new Error('[luxinus] contextIsolation is required but was disabled')
}
