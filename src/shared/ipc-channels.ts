// Single source of truth for IPC channel names and their payload/return types.
// Shared by main (handlers), preload (bridge), and renderer (typed window.luxinus).
//
// Photo operations and local AI run on-device. Codex login and an explicitly
// selected Codex proposal use the official CLI; no automatic cloud fallback.

export const IpcChannels = {
  app: {
    getVersion: 'app:getVersion',
    getPlatformInfo: 'app:getPlatformInfo',
    prepareClose: 'app:prepareClose',
    closeResult: 'app:closeResult'
  },
  library: {
    openFolder: 'library:openFolder', // native folder picker + recursive scan
    requestProxy: 'library:requestProxy', // decode 2560px proxy for a photo
    setRating: 'library:setRating',
    setFlag: 'library:setFlag',
    thumbnailReady: 'library:thumbnailReady' // main → renderer push as thumbs decode
  },
  edits: {
    load: 'edits:load', // read a photo's sidecar edit state (or null)
    save: 'edits:save', // write a photo's sidecar (atomic, never touches original)
    editedList: 'edits:editedList' // which of these files have a sidecar
  },
  exportr: {
    cancel: 'export:cancel',
    pickDir: 'export:pickDir', // choose destination folder
    run: 'export:run', // render + encode + write a batch
    progress: 'export:progress' // main → renderer batch progress
  },
  presets: {
    list: 'presets:list',
    save: 'presets:save',
    delete: 'presets:delete',
    importXmp: 'presets:importXmp' // pick + parse a Lightroom .xmp
  },
  ai: {
    restorePreview: 'ai:restorePreview', // persist and reuse a scoped restoration preview
    cancel: 'ai:cancel',
    denoise: 'ai:denoise', // run NAFNet denoise on RGBA pixels (utility process)
    status: 'ai:status', // is a model present / which execution provider
    progress: 'ai:progress' // main → renderer inference progress (0..1)
  },
  xmp: { open: 'xmp:open', propose: 'xmp:propose', apply: 'xmp:apply', undo: 'xmp:undo' },
  portrait: { status: 'portrait:status', analyze: 'portrait:analyze', cancel: 'portrait:cancel' },
  codex: { status: 'codex:status', login: 'codex:login', cancelLogin: 'codex:cancelLogin', logout: 'codex:logout', models: 'codex:models' },
  localAgent: { status: 'localAgent:status', pickRuntime: 'localAgent:pickRuntime', pickModel: 'localAgent:pickModel', smokeTest: 'localAgent:smokeTest', unload: 'localAgent:unload', propose: 'localAgent:propose', cancel: 'localAgent:cancel', approve: 'localAgent:approve',
    chat: 'localAgent:chat', approveChat: 'localAgent:approveChat', pickImages: 'localAgent:pickImages', prepareImage: 'localAgent:prepareImage', releaseImages: 'localAgent:releaseImages',
    captureRequest: 'localAgent:captureRequest', captureResult: 'localAgent:captureResult', toolProgress: 'localAgent:toolProgress' },
  update: {
    check: 'update:check' // optional, user-initiated; sends no user data
  }
} as const

export interface PlatformInfo {
  platform: NodeJS.Platform
  arch: string
  // Which onnxruntime execution provider we expect to prefer on this machine.
  // Resolved for real in Phase 5; reported here so the UI can show capabilities.
  preferredExecutionProvider: 'DirectML' | 'CUDA' | 'CoreML' | 'CPU'
}

import type { LibraryPhoto, PhotoMeta } from './library'

export interface OpenFolderResult {
  canceled: boolean
  folderPath: string | null
  photos: LibraryPhoto[]
}

export interface ProxyResult {
  webp: Uint8Array
  meta: PhotoMeta
}

export interface ThumbnailReadyPayload {
  filePath: string
  webp: Uint8Array
  meta: PhotoMeta
}
