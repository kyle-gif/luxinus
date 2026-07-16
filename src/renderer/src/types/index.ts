import type { LuxinusApi } from '../../../preload'
import type { LibraryPhoto, PhotoMeta } from '../../../shared/library'
import { defaultEditState, type EditState } from '../../../shared/edits'

// The preload exposes exactly this API on window. Nothing else crosses the
// sandbox boundary — no Node, no fs, no network.
declare global {
  interface Window {
    luxinus: LuxinusApi
  }
}

export type { LibraryPhoto, PhotoMeta }
export type { EditState }
export * from '../../../shared/edits'

export type EditorMode = 'simple' | 'expert'

// Client view-model: a scanned photo plus its decoded thumbnail (a blob: URL
// created in the renderer from webp bytes streamed over IPC).
export interface PhotoVM extends LibraryPhoto {
  thumbUrl: string | null
}

export type ProxyStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface ProxyState {
  filePath: string | null
  url: string | null
  status: ProxyStatus
  message: string | null
}

export interface FilterState {
  text: string
  ext: string // 'all' or a specific lowercased extension
  minRating: number // 0..5
  flaggedOnly: boolean
}

export const DEFAULT_FILTER: FilterState = {
  text: '',
  ext: 'all',
  minRating: 0,
  flaggedOnly: false
}

// The default edit state (all params at neutral). Full model lives in shared/edits.
export const DEFAULT_EDIT_STATE: EditState = defaultEditState()
