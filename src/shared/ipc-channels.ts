// Single source of truth for IPC channel names and their payload/return types.
// Shared by main (handlers), preload (bridge), and renderer (typed window.luxinus).
//
// LOCAL-ONLY CONTRACT: none of these channels transmit data off-device. The only
// network-capable channel is an *optional*, user-initiated update check that sends
// no user data.

export const IpcChannels = {
  app: {
    getVersion: 'app:getVersion',
    getPlatformInfo: 'app:getPlatformInfo'
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
    denoise: 'ai:denoise', // run NAFNet denoise on RGBA pixels (utility process)
    status: 'ai:status', // is a model present / which execution provider
    progress: 'ai:progress' // main → renderer inference progress (0..1)
  },
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
