import { create } from 'zustand'
import type { PhotoVM } from '../types'

export type Workspace = 'library' | 'develop'
export type LibrarySort = 'name' | 'date' | 'rating'
export type PhotoBackground = 'dark' | 'gray' | 'light'
function preference<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(`lx-${key}`) ?? 'null') ?? fallback } catch { return fallback }
}
function persist(key: string, value: unknown): void {
  try { localStorage.setItem(`lx-${key}`, JSON.stringify(value)) } catch { /* session settings still work */ }
}
interface WorkspaceState {
  viewRequest: { zoom: number; id: number } | null
  requestView: (zoom: number) => void
  editPanelTab: 'adjust' | 'presets' | 'history'
  setEditPanelTab: (tab: 'adjust' | 'presets' | 'history') => void
  workspace: Workspace
  setWorkspace: (workspace: Workspace) => void
  photoOnly: boolean
  setPhotoOnly: (value: boolean) => void
  filmstripOpen: boolean
  toggleFilmstrip: () => void
  panelCollapsed: boolean
  togglePanel: () => void
  infoOpen: boolean
  toggleInfo: () => void
  background: PhotoBackground
  setBackground: (value: PhotoBackground) => void
  sort: LibrarySort
  setSort: (value: LibrarySort) => void
  thumbSize: number
  setThumbSize: (value: number) => void
  scrollTop: number
  setScrollTop: (value: number) => void
}
export const useWorkspaceStore = create<WorkspaceState>((set) => ({
  viewRequest: null,
  requestView: (zoom) => set((state) => ({ viewRequest: { zoom: Math.min(12, Math.max(0.1, zoom)), id: (state.viewRequest?.id ?? 0) + 1 } })),
  editPanelTab: 'adjust',
  setEditPanelTab: (editPanelTab) => set({ editPanelTab }),
  workspace: 'library',
  setWorkspace: (workspace) => set({ workspace, photoOnly: false }),
  photoOnly: false,
  setPhotoOnly: (photoOnly) => set({ photoOnly }),
  filmstripOpen: preference('filmstrip', true),
  toggleFilmstrip: () => set((s) => { persist('filmstrip', !s.filmstripOpen); return { filmstripOpen: !s.filmstripOpen } }),
  panelCollapsed: false,
  togglePanel: () => set((s) => ({ panelCollapsed: !s.panelCollapsed })),
  infoOpen: false,
  toggleInfo: () => set((s) => ({ infoOpen: !s.infoOpen })),
  background: preference('photo-background', 'dark'),
  setBackground: (background) => { persist('photo-background', background); set({ background }) },
  sort: preference('library-sort', 'name'),
  setSort: (sort) => { persist('library-sort', sort); set({ sort }) },
  thumbSize: preference('thumbnail-size', 180),
  setThumbSize: (thumbSize) => { persist('thumbnail-size', thumbSize); set({ thumbSize }) },
  scrollTop: 0,
  setScrollTop: (scrollTop) => set({ scrollTop })
}))
export function sortPhotos(photos: PhotoVM[], sort: LibrarySort): PhotoVM[] {
  return [...photos].sort((a, b) => {
    if (sort === 'rating' && a.rating !== b.rating) return b.rating - a.rating
    if (sort === 'date') {
      const at = a.meta?.capturedAt ? new Date(a.meta.capturedAt).getTime() : a.mtimeMs
      const bt = b.meta?.capturedAt ? new Date(b.meta.capturedAt).getTime() : b.mtimeMs
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    }
    return a.fileName.localeCompare(b.fileName, 'ko', { numeric: true })
  })
}
