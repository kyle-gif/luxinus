import { create } from 'zustand'
import type { PortraitRegionResult, PortraitStatus } from '../../../shared/portrait'
import { useStore } from './useStore'

interface PortraitState {
  photoId: string | null
  phase: 'idle' | 'running' | 'ready' | 'error'
  regions: PortraitRegionResult[]
  message: string
  warnings: string[]
  model: PortraitStatus | null
  refreshModel: () => Promise<void>
  analyze: () => Promise<void>
  cancel: () => void
  reset: () => void
}
let generation = 0
let activeRequest: string | null = null

export const usePortraitStore = create<PortraitState>((set, get) => ({
  photoId: null, phase: 'idle', regions: [], message: '', warnings: [], model: null,
  refreshModel: async () => {
    try { set({ model: await window.luxinus.portrait.status() }) }
    catch (error) { set({ model: { modelAvailable: false, message: (error as Error).message } }) }
  },
  analyze: async () => {
    const snapshot = useStore.getState(), path = snapshot.selectedPath
    const photo = snapshot.photos.find(item => item.filePath === path)
    if (!path || !photo || snapshot.editLoading || snapshot.syncing || snapshot.proxy.status !== 'ready' || snapshot.proxy.filePath !== path || !snapshot.proxy.url || get().phase === 'running') return
    const turn = ++generation, requestId = crypto.randomUUID()
    activeRequest = requestId
    set({ photoId: path, phase: 'running', message: '인물과 얼굴 부위를 찾고 있습니다…', regions: [], warnings: [] })
    const stillCurrent = (): boolean => turn === generation && useStore.getState().selectedPath === path && useStore.getState().proxy === snapshot.proxy
    try {
      const image = new Image(); image.src = snapshot.proxy.url; await image.decode()
      if (!stillCurrent()) return
      const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('사진을 분석할 픽셀을 읽지 못했습니다.')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
      const result = await window.luxinus.portrait.analyze({ requestId, filePath: path, sourceMtimeMs: photo.mtimeMs, sourceSize: photo.size, rgba: new Uint8Array(pixels.data), width: canvas.width, height: canvas.height })
      canvas.width = 1; canvas.height = 1
      if (!stillCurrent()) return
      if (!result.ok) throw new Error(result.message ?? '인물을 분석하지 못했습니다.')
      const regions = result.regions ?? []
      set({ phase: 'ready', regions, warnings: result.warnings ?? [], message: regions.length ? '보정할 부위를 선택하세요.' : '선택할 인물 부위를 찾지 못했습니다. 다른 사진이나 수동 선택을 사용하세요.' })
    } catch (error) {
      if (stillCurrent()) set({ phase: 'error', message: (error as Error).message })
    } finally {
      if (turn === generation) {
        activeRequest = null
        // Also recover when this store is used without the App subscription.
        // A same-photo proxy replacement otherwise leaves a discarded job busy.
        if (!stillCurrent()) set({ phase: 'idle', regions: [], warnings: [], message: '사진 미리보기가 바뀌었습니다. 인물을 다시 분석해 주세요.' })
      }
    }
  },
  cancel: () => {
    generation++
    if (activeRequest) void window.luxinus?.portrait.cancel(activeRequest).catch(() => {})
    activeRequest = null
    set({ phase: 'idle', message: '인물 분석을 중단했습니다.', regions: [], warnings: [] })
  },
  reset: () => {
    get().cancel()
    set({ photoId: null, phase: 'idle', message: '', regions: [], warnings: [] })
  }
}))

export function listenForPortraitSelection(): () => void {
  return useStore.subscribe((next, previous) => {
    if (next.selectedPath !== previous.selectedPath || next.folderPath !== previous.folderPath) usePortraitStore.getState().reset()
    else if (next.proxy !== previous.proxy && usePortraitStore.getState().phase === 'running') usePortraitStore.getState().cancel()
  })
}
