import { useStore } from '../../store/useStore'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'
import { togglePhotoOnly } from '../../App'
import { Button } from '../ui/Button'
import { isMac } from '../../lib/editShortcuts'
import { useAgentStore } from '../../store/useAgentStore'
export function TopBar(): JSX.Element {
  const hasPhoto = useStore((s) => s.selectedPath !== null)
  const ui = useWorkspaceStore()
  const aiOpen = useAgentStore((s) => s.open)
  return <header className="lx-topbar lx-drag" style={{ paddingLeft: isMac ? 84 : 16 }}>
    <span className="lx-brand">Luxinus</span>
    <nav aria-label="사진 작업 화면" className="lx-workspace-tabs lx-no-drag">
      {(['library', 'develop'] as const).map((view) => <button key={view} aria-current={ui.workspace === view ? 'page' : undefined} onClick={() => ui.setWorkspace(view)}>{view === 'library' ? '사진 목록' : '사진 편집'}</button>)}
    </nav>
    <div className="lx-top-actions lx-no-drag">
      {ui.workspace === 'develop' && <>
        <button title="사진만 크게 보기 (F)" onClick={togglePhotoOnly}>사진만 보기</button>
        <button title="오른쪽 보정 도구 표시" aria-pressed={!ui.panelCollapsed && !(aiOpen && window.innerWidth < 1200)} onClick={() => {
          if (aiOpen && window.innerWidth < 1200) {
            useAgentStore.getState().setOpen(false)
            if (ui.panelCollapsed) ui.togglePanel()
          } else ui.togglePanel()
        }}>보정 도구</button>
        <button title="하단 사진 목록 표시" aria-pressed={ui.filmstripOpen} onClick={ui.toggleFilmstrip}>하단 사진</button>
      </>}
      <button title={`AI 채팅 열기 (${isMac ? '⌘K' : 'Ctrl+K'})`} aria-pressed={aiOpen} onClick={() => {
        if (aiOpen) useAgentStore.getState().setOpen(false)
        else document.dispatchEvent(new CustomEvent('luxinus:agent-open'))
      }}>AI 채팅 <kbd>{isMac ? '⌘K' : 'Ctrl+K'}</kbd></button>
      <button onClick={() => document.dispatchEvent(new CustomEvent('luxinus:models-open'))}>AI 설정</button>
      <Button variant="primary" disabled={!hasPhoto} onClick={() => useStore.getState().setExportOpen(true)}>내보내기</Button>
    </div>
  </header>
}
