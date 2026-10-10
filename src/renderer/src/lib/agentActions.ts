import { useStore, selectFilteredPhotos } from '../store/useStore'
import { useWorkspaceStore, sortPhotos } from '../store/useWorkspaceStore'
import { useAgentStore } from '../store/useAgentStore'
import { editFingerprint } from '../../../shared/local-agent'
import { validateAgentActions, validateAgentContext, type AgentAppAction, type AgentAppContext } from '../../../shared/agent-tools'

/** Paths stay in this renderer snapshot; only context is sent to the model. */
export interface AgentContextSnapshot {
  context: AgentAppContext
  photoPaths: Record<string, string>
  selectedPath: string | null
  localFilter: AgentAppContext['filter']
}
export function buildAgentContext(includeLibrary = false): AgentContextSnapshot {
  const state = useStore.getState(), workspace = useWorkspaceStore.getState()
  const current = state.photos.find(photo => photo.filePath === state.selectedPath)
  const ordered = sortPhotos(selectFilteredPhotos(state), workspace.sort)
  const shared = includeLibrary ? ordered.filter(photo => photo.filePath !== current?.filePath).slice(0, current ? 99 : 100) : []
  if (current) shared.unshift(current)
  const photoPaths: Record<string, string> = Object.create(null)
  const photos = shared.map(photo => {
    const id = `photo-${crypto.randomUUID()}`
    photoPaths[id] = photo.filePath
    return { id, index: Math.max(1, ordered.findIndex(item => item.filePath === photo.filePath) + 1), rating: photo.rating, flagged: photo.flagged, current: photo.filePath === state.selectedPath }
  })
  const context = validateAgentContext({
    currentPhotoId: photos.find(photo => photo.current)?.id ?? null,
    photos, libraryIncluded: includeLibrary,
    workspace: workspace.workspace, editorMode: state.mode, filter: { ...state.filter, text: '' }, sort: workspace.sort,
    canUndo: state.undoStack.length > 0, canRedo: state.redoStack.length > 0
  })
  return { context, photoPaths, selectedPath: state.selectedPath, localFilter: { ...state.filter } }
}

export function validateAgentActionSnapshot(snapshot: AgentContextSnapshot, actions: AgentAppAction[] = []): void {
  const state = useStore.getState()
  if (state.selectedPath !== snapshot.selectedPath) throw new Error('제안 이후 선택한 사진이 바뀌었습니다. 다시 요청해 주세요.')
  if (state.editLoading || state.syncing || state.editGestureActive) throw new Error('진행 중인 보정을 마친 뒤 적용해 주세요.')
  for (const photo of snapshot.context.photos) {
    const path = snapshot.photoPaths[photo.id]
    if (!path || !state.photos.some(item => item.filePath === path)) throw new Error('제안에 사용된 사진 목록이 바뀌었습니다. 다시 요청해 주세요.')
    if (photo.current && path !== state.selectedPath) throw new Error('현재 사진의 식별자가 일치하지 않습니다.')
    if (photo.current && actions.some(action => action.kind === 'setRating' || action.kind === 'setFlag')) {
      const current = state.photos.find(item => item.filePath === path)!
      if (current.rating !== photo.rating || current.flagged !== photo.flagged) throw new Error('제안 이후 사진의 별점·표시가 바뀌었습니다. 다시 요청해 주세요.')
    }
  }
  const workspace = useWorkspaceStore.getState()
  if (actions.some(action => ['setFilter', 'selectPhoto'].includes(action.kind)) && JSON.stringify(state.filter) !== JSON.stringify(snapshot.localFilter)) throw new Error('제안 이후 사진 필터가 바뀌었습니다. 다시 요청해 주세요.')
  if (actions.some(action => ['setSort', 'selectPhoto'].includes(action.kind)) && workspace.sort !== snapshot.context.sort) throw new Error('제안 이후 정렬 순서가 바뀌었습니다. 다시 요청해 주세요.')
  if (actions.some(action => action.kind === 'setWorkspace') && workspace.workspace !== snapshot.context.workspace) throw new Error('제안 이후 작업 화면이 바뀌었습니다. 다시 요청해 주세요.')
  if (actions.some(action => action.kind === 'setEditorMode') && state.mode !== snapshot.context.editorMode) throw new Error('제안 이후 보정 모드가 바뀌었습니다. 다시 요청해 주세요.')
}
function ready(snapshot: AgentContextSnapshot, actions: AgentAppAction[]): void {
  validateAgentActionSnapshot(snapshot, actions)
  if (useStore.getState().previewEdit) throw new Error('미리보기를 마친 뒤 적용해 주세요.')
}

/** Dispatch only a main-approved plan. Validate the entire plan before its first effect. */
export async function applyAgentActions(input: AgentAppAction[], snapshot: AgentContextSnapshot): Promise<void> {
  validateAgentActionSnapshot(snapshot)
  const initial = useStore.getState()
  const actions = validateAgentActions(input, { ...snapshot.context, canUndo: initial.undoStack.length > 0, canRedo: initial.redoStack.length > 0 })
  if (!actions.length) return
  ready(snapshot, actions)
  const before = editFingerprint(initial.edit)
  if (!(await initial.flushSaves())) throw new Error('현재 사진의 보정을 저장하지 못해 앱 동작을 적용하지 않았습니다.')
  ready(snapshot, actions)
  if (before !== editFingerprint(useStore.getState().edit)) throw new Error('저장 중 보정이 바뀌었습니다. 다시 확인한 뒤 적용해 주세요.')
  for (const action of actions) {
    const state = useStore.getState(), workspace = useWorkspaceStore.getState()
    switch (action.kind) {
      case 'selectPhoto':
        state.selectPhoto(snapshot.photoPaths[action.photoId]); break
      case 'setRating': {
        const path = state.selectedPath!
        if (!(await window.luxinus.library.setRating(path, action.rating))) throw new Error('별점을 저장하지 못했습니다.')
        useStore.setState(current => ({ photos: current.photos.map(photo => photo.filePath === path ? { ...photo, rating: action.rating } : photo) }))
        break
      }
      case 'setFlag': {
        const path = state.selectedPath!
        if (!(await window.luxinus.library.setFlag(path, action.flagged))) throw new Error('사진 표시를 저장하지 못했습니다.')
        useStore.setState(current => ({ photos: current.photos.map(photo => photo.filePath === path ? { ...photo, flagged: action.flagged } : photo) }))
        break
      }
      case 'setFilter': state.setFilter(action.filter); break
      case 'setSort': workspace.setSort(action.sort); break
      case 'setWorkspace': workspace.setWorkspace(action.workspace); break
      case 'setEditorMode': state.setMode(action.mode); break
      case 'history':
        state[action.direction]()
        if (!(await useStore.getState().flushSaves())) throw new Error('편집 기록은 변경했지만 보정을 저장하지 못했습니다. 저장 오류를 확인해 주세요.')
        break
      case 'setView': workspace.setWorkspace('develop'); workspace.requestView(action.zoom); break
      case 'setCompare': workspace.setWorkspace('develop'); useAgentStore.getState().setComparison(null); state.setShowBefore(action.mode === 'before'); state.setSplit(action.mode === 'split'); break
      case 'setClipping': state.setShowClipping(action.enabled); break
      case 'setBackground': workspace.setBackground(action.background); break
      case 'setFilmstrip': if (workspace.filmstripOpen !== action.visible) workspace.toggleFilmstrip(); break
      case 'setPhotoOnly':
        workspace.setWorkspace('develop')
        if (action.enabled) {
          state.setCropMode(false); state.setMaskMode(false); state.setWbPicking(false); state.setColorPicking(false)
          state.setStraightening(false); state.setShowBefore(false); state.setSplit(false); state.setShowClipping(false)
          useAgentStore.getState().setComparison(null)
        }
        workspace.setPhotoOnly(action.enabled)
        break
      case 'openPanel': {
        if (action.panel === 'settings') { document.dispatchEvent(new CustomEvent('luxinus:models-open')); break }
        if (action.panel === 'export') { state.setExportOpen(true); break }
        if (action.panel === 'info') { if (!workspace.infoOpen) workspace.toggleInfo(); break }
        workspace.setWorkspace('develop')
        if (window.innerWidth < 1200) useAgentStore.getState().setOpen(false)
        if (workspace.panelCollapsed) workspace.togglePanel()
        state.setCropMode(action.panel === 'crop')
        state.setMaskMode(action.panel === 'masks')
        if (['adjust', 'presets', 'history'].includes(action.panel)) workspace.setEditPanelTab(action.panel as 'adjust' | 'presets' | 'history')
        break
      }
    }
  }
}
