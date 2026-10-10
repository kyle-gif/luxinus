import { contextBridge, ipcRenderer } from 'electron'
import type { DenoiseResult } from '../shared/ai'
import type { RawDecodeMode, RawDecodeResult } from '../shared/library'
import type { ExportRenderRequest, ExportRenderResult } from '../shared/export'

// Preload for the hidden decode/export window. Bridges RAW decode and full-res
// export-render requests from main to the WebGL/libraw code in this Chromium
// window, and results back.
export interface DecodeRequest {
  id: string
  bytes: Uint8Array
  mode: RawDecodeMode
}

const api = {
  restore: (payload: { id: string; rgba: Uint8Array; width: number; height: number; strength: number }): Promise<DenoiseResult> => ipcRenderer.invoke('decoder:restore', payload),
  onDecode: (cb: (req: DecodeRequest) => void): void => {
    ipcRenderer.on('decoder:request', (_e, req: DecodeRequest) => cb(req))
  },
  onExport: (cb: (req: ExportRenderRequest) => void): void => {
    ipcRenderer.on('decoder:export-request', (_e, req: ExportRenderRequest) => cb(req))
  },
  ready: (): void => ipcRenderer.send('decoder:ready'),
  result: (payload: { id: string } & RawDecodeResult): void =>
    ipcRenderer.send('decoder:reply', payload),
  fail: (payload: { id: string; message: string }): void =>
    ipcRenderer.send('decoder:fail', payload),
  exportResult: (payload: { id: string } & ExportRenderResult): void =>
    ipcRenderer.send('decoder:export-reply', payload),
  exportFail: (payload: { id: string; message: string }): void =>
    ipcRenderer.send('decoder:export-fail', payload)
}

contextBridge.exposeInMainWorld('luxDecoder', api)
export type LuxDecoderApi = typeof api
