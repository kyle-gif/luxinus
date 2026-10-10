import type { AgentRequest, AgentApproval, AgentProposal, ApprovedAgentEdit, LocalModelStatus } from '../shared/local-agent'
import type { CodexStatus, CodexModel } from '../shared/codex'
import type { AgentChatApi } from '../shared/agent-tools'
import type { AgentCaptureRequest, AgentCaptureResponse, AgentToolProgress } from '../shared/agent-vision'
import type { PortraitApi } from '../shared/portrait'
import type { XmpReview, XmpProposal, XmpApplyResult } from '../shared/xmp'
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
import type { DenoiseResult, RestorationPreviewRequest } from '../shared/ai'

// The ONLY bridge between the sandboxed renderer and Node privileges. Every
// method is an explicit, typed invoke — the renderer gets no raw ipcRenderer,
// no Node or filesystem access. Codex authentication stays in the main process.
const api = {
  app: {
    onPrepareClose: (cb: (token: string) => void): (() => void) => {
      const listener = (_event: unknown, token: string): void => cb(token)
      ipcRenderer.on(IpcChannels.app.prepareClose, listener)
      return () => ipcRenderer.removeListener(IpcChannels.app.prepareClose, listener)
    },
    closeResult: (saved: boolean, token: string): void => ipcRenderer.send(IpcChannels.app.closeResult, saved, token),
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
    cancel: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.exportr.cancel),
    pickDir: (): Promise<string | null> => ipcRenderer.invoke(IpcChannels.exportr.pickDir),
    run: (
      items: ExportItem[],
      options: ExportOptions
    ): Promise<{ written: string[]; errors: { file: string; message: string }[]; canceled: boolean }> =>
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
    restorePreview: (input: RestorationPreviewRequest): Promise<DenoiseResult> => ipcRenderer.invoke(IpcChannels.ai.restorePreview, input),
    cancel: (): Promise<boolean> => ipcRenderer.invoke(IpcChannels.ai.cancel),
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
  codex: {
    status: (): Promise<CodexStatus> => ipcRenderer.invoke(IpcChannels.codex.status),
    login: (): Promise<CodexStatus> => ipcRenderer.invoke(IpcChannels.codex.login),
    cancelLogin: (loginId?: string): Promise<CodexStatus> => ipcRenderer.invoke(IpcChannels.codex.cancelLogin, loginId),
    logout: (): Promise<CodexStatus> => ipcRenderer.invoke(IpcChannels.codex.logout),
    models: (): Promise<CodexModel[]> => ipcRenderer.invoke(IpcChannels.codex.models)
  },
  portrait: {
    status: (() => ipcRenderer.invoke(IpcChannels.portrait.status)) as PortraitApi['status'],
    analyze: ((input) => ipcRenderer.invoke(IpcChannels.portrait.analyze, input)) as PortraitApi['analyze'],
    cancel: ((requestId) => ipcRenderer.invoke(IpcChannels.portrait.cancel, requestId)) as PortraitApi['cancel']
  },
  localAgent: {
    onCaptureRequest: (cb: (request: AgentCaptureRequest) => void): (() => void) => {
      const listener = (_event: unknown, request: AgentCaptureRequest): void => cb(request)
      ipcRenderer.on(IpcChannels.localAgent.captureRequest, listener)
      return () => ipcRenderer.removeListener(IpcChannels.localAgent.captureRequest, listener)
    },
    captureResult: (response: AgentCaptureResponse): void => ipcRenderer.send(IpcChannels.localAgent.captureResult, response),
    onToolProgress: (cb: (event: AgentToolProgress) => void): (() => void) => {
      const listener = (_event: unknown, event: AgentToolProgress): void => cb(event)
      ipcRenderer.on(IpcChannels.localAgent.toolProgress, listener)
      return () => ipcRenderer.removeListener(IpcChannels.localAgent.toolProgress, listener)
    },
    chat: ((request) => ipcRenderer.invoke(IpcChannels.localAgent.chat, request)) as AgentChatApi['chat'],
    approveChat: ((request) => ipcRenderer.invoke(IpcChannels.localAgent.approveChat, request)) as AgentChatApi['approveChat'],
    pickImages: (() => ipcRenderer.invoke(IpcChannels.localAgent.pickImages)) as AgentChatApi['pickImages'],
    prepareImage: ((input) => ipcRenderer.invoke(IpcChannels.localAgent.prepareImage, input)) as AgentChatApi['prepareImage'],
    releaseImages: ((ids) => ipcRenderer.invoke(IpcChannels.localAgent.releaseImages, ids)) as AgentChatApi['releaseImages'],
    status: (): Promise<LocalModelStatus> => ipcRenderer.invoke(IpcChannels.localAgent.status),
    pickRuntime: (): Promise<LocalModelStatus> => ipcRenderer.invoke(IpcChannels.localAgent.pickRuntime),
    pickModel: (): Promise<LocalModelStatus> => ipcRenderer.invoke(IpcChannels.localAgent.pickModel),
    smokeTest: (requestId: string): Promise<LocalModelStatus> => ipcRenderer.invoke(IpcChannels.localAgent.smokeTest, requestId),
    unload: (): Promise<LocalModelStatus> => ipcRenderer.invoke(IpcChannels.localAgent.unload),
    propose: (request: AgentRequest): Promise<AgentProposal> => ipcRenderer.invoke(IpcChannels.localAgent.propose, request),
    cancel: (requestId: string): Promise<boolean> => ipcRenderer.invoke(IpcChannels.localAgent.cancel, requestId),
    approve: (request: AgentApproval): Promise<ApprovedAgentEdit> => ipcRenderer.invoke(IpcChannels.localAgent.approve, request)
  },
  xmp: {
    open: (): Promise<XmpReview | null> => ipcRenderer.invoke(IpcChannels.xmp.open),
    propose: (documentId: string, patch: Record<string, number>): Promise<XmpProposal> => ipcRenderer.invoke(IpcChannels.xmp.propose, documentId, patch),
    apply: (proposalId: string): Promise<XmpApplyResult> => ipcRenderer.invoke(IpcChannels.xmp.apply, proposalId),
    undo: (operationId: string): Promise<XmpReview> => ipcRenderer.invoke(IpcChannels.xmp.undo, operationId)
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
