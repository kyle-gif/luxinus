import { XmpDialog } from './components/ui/XmpDialog'
import { useDialogFocus } from './components/ui/useDialogFocus'
import { AgentPanel } from './components/ui/AgentPanel'
import { ModelsDialog } from './components/ui/ModelsDialog'
import { useEffect, useState } from 'react'
import { TopBar } from './components/layout/TopBar'
import { FileDrawer } from './components/layout/FileDrawer'
import { Stage } from './components/layout/Stage'
import { EditPanel } from './components/layout/EditPanel'
import { Filmstrip } from './components/layout/Filmstrip'
import { ExportDialog } from './components/ui/ExportDialog'
import { useStore } from './store/useStore'
import { useWorkspaceStore } from './store/useWorkspaceStore'
import { handleEditHistoryShortcut } from './lib/editShortcuts'
import { useAgentStore } from './store/useAgentStore'
import { listenForAgentCaptures } from './lib/agentCapture'
import { listenForPortraitSelection } from './store/usePortraitStore'

export default function App(): JSX.Element {
  const workspace = useWorkspaceStore((s) => s.workspace)
  const photoOnly = useWorkspaceStore((s) => s.photoOnly)
  const filmstrip = useWorkspaceStore((s) => s.filmstripOpen)
  const panelCollapsed = useWorkspaceStore((s) => s.panelCollapsed)
  const panelWidth = useStore((s) => s.panelWidth)
  const agentOpen = useAgentStore((s) => s.open)
  const [compact, setCompact] = useState(() => window.innerWidth < 1200)
  const showEditPanel = !photoOnly && !panelCollapsed && (!agentOpen || !compact)
  useThumbnailStream()
  useEffect(listenForAgentCaptures, [])
  useEffect(listenForPortraitSelection, [])
  useEffect(() => {
    const resize = (): void => setCompact(window.innerWidth < 1200)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    if (import.meta.env.DEV) void import('./dev/preview').then((m) => m.enablePreview())
    function keyboard(event: KeyboardEvent): void {
      if (handleEditHistoryShortcut(event)) return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.dispatchEvent(new CustomEvent('luxinus:agent-open'))
        return
      }
      const el = event.target instanceof Element ? event.target : null
      if (el?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="slider"]')) return
      if (event.key === 'Escape' && useWorkspaceStore.getState().photoOnly) {
        useWorkspaceStore.getState().setPhotoOnly(false)
      } else if (event.key.toLowerCase() === 'f' && !event.metaKey && !event.ctrlKey && useWorkspaceStore.getState().workspace === 'develop') {
        event.preventDefault()
        togglePhotoOnly()
      }
    }
    const removeClose = window.luxinus?.app?.onPrepareClose(async (token) => {
      if (useStore.getState().syncing) {
        window.luxinus.app.closeResult(false, token)
        window.alert('보정 동기화가 끝난 뒤 창을 닫아 주세요.')
        return
      }
      const ok = await useStore.getState().flushSaves()
      window.luxinus.app.closeResult(ok, token)
    })
    window.addEventListener('keydown', keyboard)
    const stopCompareOnEdit = useStore.subscribe((next, previous) => {
      if (next.selectedPath !== previous.selectedPath || next.edit !== previous.edit) useAgentStore.getState().setComparison(null)
    })
    return () => { window.removeEventListener('keydown', keyboard); removeClose?.(); stopCompareOnEdit() }
  }, [])
  return (
    <div className="lx-app">
      {!photoOnly && <TopBar />}
      <div className={`lx-work-area ${!photoOnly && agentOpen ? 'lx-ai-open' : ''}`}>
      <div className="lx-agent-slot" hidden={photoOnly || !agentOpen}><AgentPanel /></div>
      {workspace === 'library' ? <FileDrawer /> : (
        <main className="lx-develop" style={{ gridTemplateColumns: showEditPanel ? `minmax(0, 1fr) min(${panelWidth}px, 32vw)` : 'minmax(0, 1fr)' }}>
          <div className="lx-photo-workspace">
            <Stage photoOnly={photoOnly} />
            {!photoOnly && filmstrip && <Filmstrip />}
          </div>
          {showEditPanel && <EditPanel />}
        </main>
      )}
      </div>
      {!photoOnly && <StatusBar />}
      {photoOnly && <button className="lx-photo-exit" onClick={() => useWorkspaceStore.getState().setPhotoOnly(false)}>사진만 보기 종료 · F / Esc</button>}
      <ExportDialog />
      <AgentWindows />
    </div>
  )
}
export function togglePhotoOnly(): void {
  const ui = useWorkspaceStore.getState()
  if (!ui.photoOnly) {
    const s = useStore.getState()
    s.setCropMode(false)
    s.setMaskMode(false)
    s.setWbPicking(false)
    s.setStraightening(false)
    s.setShowBefore(false)
    s.setSplit(false)
    s.setShowClipping(false)
  }
  ui.setPhotoOnly(!ui.photoOnly)
}
function StatusBar(): JSX.Element {
  const [recovery, setRecovery] = useState(false)
  const ref = useDialogFocus(recovery, () => setRecovery(false))
  const photos = useStore((s) => s.photos)
  const loading = useStore((s) => s.loadingLibrary)
  const folder = useStore((s) => s.folderPath)
  const proxy = useStore((s) => s.proxy)
  const selected = useStore((s) => s.selection.size)
  const saveStatus = useStore((s) => s.saveStatus)
  const saveError = useStore((s) => s.saveError)
  const ready = photos.filter((p) => p.thumbUrl).length
  return <footer className="lx-status" role="status" aria-live="polite">
    <span>{loading ? '사진 목록을 읽는 중…' : !folder ? '폴더를 열어 시작하세요' : `${photos.length}장 · ${selected}장 선택`}</span>
    <span title={saveError ?? undefined}>{saveStatus === 'error' ? <button onClick={() => setRecovery(true)}>저장 실패 · 자세히 / 복구</button> : saveStatus === 'pending' ? '보정 저장 대기…' : saveStatus === 'saving' ? '보정 저장 중…' : saveStatus === 'saved' ? '보정 저장 완료' : ''}</span>
    <span>{proxy.status === 'error' ? '사진 열기 실패' : proxy.status === 'loading' ? '편집용 사진을 준비하는 중…' : photos.length > 0 && ready < photos.length ? `썸네일 ${ready}/${photos.length}` : '로컬 사진 작업실'}</span>
    {recovery && <div className="lx-modal-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="save-recovery-title" tabIndex={-1} className="lx-modal p-5 max-w-lg">
      <h2 id="save-recovery-title">보정 저장 확인</h2>
      <p className="my-4 break-words">{saveError ?? '현재 보정의 저장 상태를 확인하세요.'}</p>
      <p className="text-muted mb-4">다시 읽기를 선택하면 현재 사진의 저장하지 못한 변경을 버리고 디스크의 보정을 불러옵니다. 원본 사진과 디스크 보정 파일은 변경하지 않습니다.</p>
      <div className="flex flex-wrap gap-3 justify-end">
        <button onClick={() => setRecovery(false)}>닫기</button>
        <button onClick={() => { setRecovery(false); void useStore.getState().reloadCurrentEdits() }}>현재 사진 다시 읽기</button>
        <button onClick={async () => { if (await useStore.getState().retrySave()) setRecovery(false) }}>저장 재시도</button>
      </div>
    </div></div>}
  </footer>
}
function useThumbnailStream(): void {
  useEffect(() => {
    if (!window.luxinus) return
    return window.luxinus.library.onThumbnail((payload) => {
      useStore.getState().applyThumbnail(payload.filePath, payload.webp, payload.meta)
    })
  }, [])
}

function AgentWindows(): JSX.Element | null {
  const provider = useAgentStore((s) => s.provider)
  const changeProvider = useAgentStore((s) => s.setProvider)
  const [modelsOpen, setModelsOpen] = useState(false)
  const [xmpOpen, setXmpOpen] = useState(false)
  useEffect(() => {
    const openAgent = (): void => {
      if (document.querySelector('[role="dialog"]')) return
      useAgentStore.getState().setOpen(true)
      useWorkspaceStore.getState().setPhotoOnly(false)
      requestAnimationFrame(() => document.getElementById('agent-chat-prompt')?.focus())
    }
    const openModels = (): void => {
      if (document.querySelector('[role="dialog"]')) return
      setModelsOpen(true)
    }
    document.addEventListener('luxinus:agent-open', openAgent)
    document.addEventListener('luxinus:models-open', openModels)
    return () => {
      document.removeEventListener('luxinus:agent-open', openAgent)
      document.removeEventListener('luxinus:models-open', openModels)
    }
  }, [])
  if (!window.luxinus?.localAgent) return null
  return <>
    <ModelsDialog open={modelsOpen} onClose={() => { setModelsOpen(false); document.dispatchEvent(new CustomEvent('luxinus:agent-status')) }} onOpenXmp={() => setXmpOpen(true)} api={window.luxinus.localAgent} codexApi={window.luxinus.codex} provider={provider} onProviderChange={changeProvider} />
    <XmpDialog open={xmpOpen} onClose={() => setXmpOpen(false)} api={window.luxinus.xmp} />
  </>
}
