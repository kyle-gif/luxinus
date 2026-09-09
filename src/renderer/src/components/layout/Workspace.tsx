import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { ApertureMark } from '../ui/ApertureMark'
import { Thumbnail } from '../ui/Thumbnail'
import { ModeSwitch } from '../ui/ModeSwitch'
import { ExportDialog } from '../ui/ExportDialog'
import { Stage } from './Stage'
import { EditPanel } from './EditPanel'
import { Filmstrip } from './Filmstrip'
import '../../workspace.css'

type View = 'library' | 'develop'
type Matte = 'dark' | 'gray' | 'light'
const mattes: Record<Matte, string> = { dark: '#151515', gray: '#686868', light: '#C8C8C8' }
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

function readMatte(): Matte {
  try {
    const value = localStorage.getItem('luxinus.ui.matte')
    return value === 'gray' || value === 'light' ? value : 'dark'
  } catch {
    return 'dark'
  }
}

/** Presentation only: the existing store, RAW renderer and IPC stay authoritative. */
export function Workspace(): JSX.Element {
  const [view, setView] = useState<View>('library')
  const [focused, setFocused] = useState(false)
  const [matte, setMatte] = useState<Matte>(readMatte)
  const [message, setMessage] = useState('')
  const selectedPath = useStore((s) => s.selectedPath)
  const photos = useStore((s) => s.photos)
  const selectionCount = useStore((s) => s.selection.size)
  const loading = useStore((s) => s.loadingLibrary)
  const panelWidth = useStore((s) => s.panelWidth)
  const folderPath = useStore((s) => s.folderPath)
  const proxyStatus = useStore((s) => s.proxy.status)
  const proxyMessage = useStore((s) => s.proxy.message)
  const selectedPhoto = photos.find((p) => p.filePath === selectedPath)

  useEffect(() => {
    try { localStorage.setItem('luxinus.ui.matte', matte) } catch { /* Preferences are optional. */ }
  }, [matte])

  function navigate(next: View): void {
    if (next === 'develop' && !selectedPath) return
    setFocused(false)
    setView(next)
  }

  async function openFolder(): Promise<void> {
    setMessage('')
    try {
      await useStore.getState().openFolder()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '폴더를 열지 못했습니다.')
    }
  }

  const statusMessage = message || (loading ? '사진 목록을 불러오는 중'
    : view !== 'develop' ? ''
      : proxyStatus === 'error' ? proxyMessage || '미리보기를 만들지 못했습니다.'
        : proxyStatus === 'loading' ? '미리보기 준비 중' : '')

  const style = {
    '--lx-matte': mattes[matte],
    '--lx-panel-width': `${Math.max(280, Math.min(420, panelWidth))}px`
  } as CSSProperties

  return (
    <div className="lx-workspace" style={style}>
      <header className="lx-workspace-header lx-drag" style={{ paddingLeft: isMac ? 84 : 18 }}>
        <div className="lx-workspace-brand">
          <ApertureMark size={18} />
          <span>Luxinus</span>
          <span className="lx-brand-caption">사진 작업실</span>
        </div>
        <nav className="lx-workspace-nav lx-no-drag" aria-label="작업 화면">
          <button type="button" aria-pressed={view === 'library'} onClick={() => navigate('library')}>라이브러리</button>
          <button type="button" aria-pressed={view === 'develop'} disabled={!selectedPath} onClick={() => navigate('develop')}>현상</button>
        </nav>
        <div className="lx-workspace-actions lx-no-drag">
          {view === 'develop' && (
            <button type="button" className="lx-workspace-button lx-focus-toggle" aria-pressed={focused} onClick={() => setFocused(!focused)}>
              {focused ? '도구 표시' : '사진만 보기'}
            </button>
          )}
          <button type="button" className="lx-workspace-button" disabled={loading} onClick={() => void openFolder()}>
            {loading ? '불러오는 중…' : '폴더 열기'}
          </button>
          <button type="button" className="lx-workspace-button lx-workspace-primary" disabled={!selectedPath}
            onClick={() => useStore.getState().setExportOpen(true)}>내보내기</button>
        </div>
      </header>

      <main className="lx-workspace-body">
        {/* Remain mounted so returning from Develop preserves scroll and grid size. */}
        <LibraryWorkspace hidden={view !== 'library'} onDevelop={() => { setFocused(false); setView('develop') }} onOpenFolder={openFolder} />
        {view === 'develop' && (
          <section className="lx-develop-workspace" data-focused={focused} aria-label="사진 현상">
            <div className="lx-stage-host"><Stage /></div>
            <aside className="lx-inspector-host" aria-label="보정 도구" hidden={focused}>
              <div className="lx-inspector-mode"><span>보정 모드</span><ModeSwitch /></div>
              <div className="lx-edit-panel-host"><EditPanel /></div>
            </aside>
            <div className="lx-filmstrip-host" hidden={focused}><Filmstrip /></div>
          </section>
        )}
      </main>

      <footer className="lx-workspace-status">
        <div className="lx-status-context" title={view === 'develop' ? selectedPath ?? undefined : folderPath ?? undefined}>
          <span>{view === 'develop' ? selectedPhoto?.fileName ?? '사진 선택' : `${photos.length.toLocaleString()}장`}</span>
          {selectionCount > 1 && <span>{selectionCount.toLocaleString()}장 선택</span>}
          <span role="status" aria-live="polite">
            {statusMessage}
          </span>
        </div>
        <div className="lx-status-tools">
          {view === 'develop' && (
            <label className="lx-matte-control">배경
              <select value={matte} onChange={(e) => setMatte(e.target.value as Matte)} aria-label="사진 주변 배경 밝기">
                <option value="dark">어둡게</option><option value="gray">중간 회색</option><option value="light">밝게</option>
              </select>
            </label>
          )}
          <span className="lx-local-label" title="모델 로딩 상태가 아닌 로컬 처리 원칙을 나타냅니다.">로컬 사진 작업실</span>
        </div>
      </footer>
      <ExportDialog />
    </div>
  )
}

interface LibraryProps {
  hidden: boolean
  onDevelop: () => void
  onOpenFolder: () => Promise<void>
}

function LibraryWorkspace({ hidden, onDevelop, onOpenFolder }: LibraryProps): JSX.Element {
  const photos = useStore((s) => s.photos)
  const visible = useStore(selectFilteredPhotos)
  const selectedPath = useStore((s) => s.selectedPath)
  const selection = useStore((s) => s.selection)
  const pickPhoto = useStore((s) => s.pickPhoto)
  const folderPath = useStore((s) => s.folderPath)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)
  const loading = useStore((s) => s.loadingLibrary)
  const syncing = useStore((s) => s.syncing)
  const [thumbSize, setThumbSize] = useState(200)
  const [syncMessage, setSyncMessage] = useState('')
  const extensions = useMemo(() => Array.from(new Set(photos.map((p) => p.ext))).sort(), [photos])
  const filtered = filter.text !== '' || filter.ext !== 'all' || filter.minRating > 0 || filter.flaggedOnly
  const folderName = folderPath?.split(/[\\/]/).filter(Boolean).pop()

  useEffect(() => { setSyncMessage('') }, [selectedPath, selection.size])

  function resetFilters(): void {
    setFilter({ text: '', ext: 'all', minRating: 0, flaggedOnly: false })
  }

  async function syncSelection(): Promise<void> {
    const state = useStore.getState()
    if (state.selection.size < 2 || !state.selectedPath || !state.selection.has(state.selectedPath)) return
    if (!window.confirm(`현재 사진의 보정을 나머지 ${state.selection.size - 1}장에 복사합니다. 기존 보정값이 바뀌며 구도는 유지됩니다. 계속할까요?`)) return
    setSyncMessage('')
    try {
      const count = await useStore.getState().syncEditToSelection()
      setSyncMessage(`${count}장에 보정을 복사했습니다.`)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : '보정 동기화에 실패했습니다.')
    }
  }

  return (
    <section className="lx-library-workspace" hidden={hidden} aria-label="사진 라이브러리">
      <aside className="lx-library-sidebar">
        <h2>보관함</h2>
        <button type="button" className="lx-library-location" onClick={resetFilters}>
          <span>모든 사진</span><span>{photos.length.toLocaleString()}</span>
        </button>
        <h3>현재 폴더</h3>
        <p className="lx-folder-name" title={folderPath ?? undefined}>{folderName || '열린 폴더 없음'}</p>
        {folderPath && <p className="lx-folder-path" title={folderPath}>{folderPath}</p>}
        <button type="button" className="lx-workspace-button lx-folder-open" disabled={loading} onClick={() => void onOpenFolder()}>
          {loading ? '불러오는 중…' : '사진 폴더 열기'}
        </button>
        <div className="lx-library-filters">
          <h3>필터</h3>
          <label>파일 형식
            <select value={filter.ext} onChange={(e) => setFilter({ ext: e.target.value })}>
              <option value="all">모든 형식</option>
              {extensions.map((ext) => <option key={ext} value={ext}>{ext.replace('.', '').toUpperCase()}</option>)}
            </select>
          </label>
          <label>최소 별점
            <select value={filter.minRating} onChange={(e) => setFilter({ minRating: Number(e.target.value) })}>
              <option value={0}>모든 별점</option>
              {[1, 2, 3, 4, 5].map((rating) => <option key={rating} value={rating}>{rating}개 이상</option>)}
            </select>
          </label>
          <label className="lx-checkbox-label">
            <input type="checkbox" checked={filter.flaggedOnly} onChange={(e) => setFilter({ flaggedOnly: e.target.checked })} />
            플래그한 사진만
          </label>
          {filtered && <button type="button" className="lx-text-button" onClick={resetFilters}>필터 초기화</button>}
        </div>
        <p className="lx-library-note">원본은 그대로.<br />보정은 별도로 저장됩니다.</p>
      </aside>
      <div className="lx-library-content">
        <div className="lx-library-toolbar">
          <div className="lx-library-heading"><h1>{folderName || '라이브러리'}</h1><span>{visible.length.toLocaleString()}장</span></div>
          <label className="lx-library-search"><span className="lx-sr-only">파일 이름 검색</span>
            <input type="search" placeholder="파일 이름 검색" value={filter.text} onChange={(e) => setFilter({ text: e.target.value })} />
          </label>
          <label className="lx-grid-size" title="썸네일 크기">크기
            <input type="range" min={140} max={300} step={20} value={thumbSize} aria-label="썸네일 크기"
              onChange={(e) => setThumbSize(Number(e.target.value))} />
          </label>
        </div>
        <div className="lx-library-scroll" aria-busy={loading}>
          {photos.length === 0 ? (
            <div className="lx-library-empty"><ApertureMark size={36} />
              <h2>{loading ? '사진을 불러오고 있습니다' : '사진에서 시작하세요.'}</h2>
              <p>{loading ? '목록과 미리보기가 준비되는 대로 표시됩니다.' : '폴더를 열고, 사진을 고르고, 나만의 색을 만들어 보세요.'}</p>
              <button type="button" className="lx-workspace-button lx-workspace-primary" disabled={loading} onClick={() => void onOpenFolder()}>사진 폴더 열기</button>
            </div>
          ) : visible.length === 0 ? (
            <div className="lx-library-empty"><h2>조건에 맞는 사진이 없습니다.</h2><button type="button" className="lx-workspace-button" onClick={resetFilters}>필터 초기화</button></div>
          ) : (
            <div className="lx-library-grid" style={{ '--lx-thumb-size': `${thumbSize}px` } as CSSProperties}>
              {visible.map((photo) => (
                <div key={photo.filePath} className="lx-photo-tile" data-active={selectedPath === photo.filePath}
                  onDoubleClick={() => { pickPhoto(photo.filePath, { meta: false, shift: false }); onDevelop() }}>
                  <Thumbnail photo={photo} active={selectedPath === photo.filePath} selected={selection.has(photo.filePath)}
                    onClick={(event) => pickPhoto(photo.filePath, { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey })}
                    className="lx-library-thumbnail" />
                  <div className="lx-photo-caption" title={photo.fileName}>{photo.fileName}</div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="lx-library-selection-bar">
          <span className="lx-selection-hint">{selection.size > 1 ? `${selection.size}장 선택` : '사진을 두 번 클릭하면 현상 화면이 열립니다.'}</span>
          <span className="lx-sync-message" role="status" aria-live="polite">{syncMessage}</span>
          {selection.size > 1 && <>
            <button type="button" className="lx-text-button" onClick={() => useStore.getState().clearSelection()}>선택 해제</button>
            <button type="button" className="lx-workspace-button" disabled={syncing || !selectedPath || !selection.has(selectedPath)} onClick={() => void syncSelection()}>{syncing ? '동기화 중…' : '보정 동기화'}</button>
          </>}
          <button type="button" className="lx-workspace-button" disabled={!selectedPath} onClick={onDevelop}>선택한 사진 현상</button>
        </div>
      </div>
    </section>
  )
}
