import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { sortPhotos, useWorkspaceStore } from '../../store/useWorkspaceStore'
import { Button } from '../ui/Button'
import { Thumbnail } from '../ui/Thumbnail'
import { StarRating } from '../ui/StarRating'
import { useDialogFocus } from '../ui/useDialogFocus'
import { DEFAULT_FILTER } from '../../types'

/** The library is a full workspace; virtualization bounds thumbnail DOM to visible rows. */
export function FileDrawer(): JSX.Element {
  const folderPath = useStore((s) => s.folderPath)
  const photos = useStore((s) => s.photos)
  const selectedPath = useStore((s) => s.selectedPath)
  const selection = useStore((s) => s.selection)
  const loading = useStore((s) => s.loadingLibrary)
  const error = useStore((s) => s.libraryError)
  const filter = useStore((s) => s.filter)
  const filtered = useStore(selectFilteredPhotos)
  const ui = useWorkspaceStore()
  const setFilter = useStore((s) => s.setFilter)
  const openFolder = useStore((s) => s.openFolder)
  const visible = useMemo(() => sortPhotos(filtered, ui.sort), [filtered, ui.sort])
  const order = useMemo(() => visible.map((p) => p.filePath), [visible])
  const extensions = useMemo(() => Array.from(new Set(photos.map((p) => p.ext))).sort(), [photos])
  const keyboardPath = useRef(selectedPath)
  useLayoutEffect(() => { keyboardPath.current = selectedPath }, [selectedPath])
  const viewport = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 700, height: 600 })
  const [scroll, setScroll] = useState(ui.scrollTop)
  const columns = Math.max(1, Math.floor((size.width - 32) / (ui.thumbSize + 12)))
  const cellWidth = (size.width - 32 - 12 * (columns - 1)) / columns
  const rowHeight = cellWidth * 0.75 + 64
  const startRow = Math.max(0, Math.floor(scroll / rowHeight) - 2)
  const endRow = Math.min(Math.ceil(visible.length / columns), Math.ceil((scroll + size.height) / rowHeight) + 2)
  const slice = visible.slice(startRow * columns, endRow * columns)
  useLayoutEffect(() => {
    const el = viewport.current
    if (!el) return
    const observer = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }))
    observer.observe(el)
    el.scrollTop = useWorkspaceStore.getState().scrollTop
    return () => observer.disconnect()
  }, [])
  const previousFolder = useRef(folderPath)
  useLayoutEffect(() => {
    if (previousFolder.current !== folderPath) {
      previousFolder.current = folderPath
      if (viewport.current) viewport.current.scrollTop = 0
      setScroll(0)
      useWorkspaceStore.getState().setScrollTop(0)
    }
  }, [folderPath])
  function keyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if ((event.target as HTMLElement).closest('input, textarea, select, [role="dialog"]')) return
    const i = Math.max(0, order.indexOf(keyboardPath.current ?? selectedPath ?? ''))
    let next = i
    if (event.key === 'ArrowRight') next++
    else if (event.key === 'ArrowLeft') next--
    else if (event.key === 'ArrowDown') next += columns
    else if (event.key === 'ArrowUp') next -= columns
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = order.length - 1
    else if (event.key === 'Enter' && selectedPath) { event.preventDefault(); ui.setWorkspace('develop'); return }
    else if (selectedPath && /^[0-5]$/.test(event.key)) { useStore.getState().setRating(selectedPath, Number(event.key)); return }
    else if (selectedPath && event.key.toLowerCase() === 'p') { const p = photos.find((x) => x.filePath === selectedPath); if (p) useStore.getState().setFlag(p.filePath, !p.flagged); return }
    else return
    event.preventDefault()
    next = Math.max(0, Math.min(order.length - 1, next))
    if (!order[next]) return
    keyboardPath.current = order[next]
    useStore.getState().pickPhoto(order[next], { meta: event.metaKey || event.ctrlKey, shift: event.shiftKey, order })
    const top = Math.floor(next / columns) * rowHeight
    const el = viewport.current
    if (el && (top < el.scrollTop || top + rowHeight > el.scrollTop + el.clientHeight)) el.scrollTop = top
  }
  const hasFilters = filter.text || filter.ext !== 'all' || filter.minRating > 0 || filter.flaggedOnly
  return <main className="lx-library">
    <aside className="lx-library-sidebar" aria-label="폴더와 필터">
      <h2>보관함</h2>
      <Button variant="primary" className="w-full" onClick={() => void openFolder()} disabled={loading}>{loading ? '읽는 중…' : '폴더 열기'}</Button>
      <p className="lx-folder-path" title={folderPath ?? ''}>{folderPath?.split('/').pop() ?? '아직 연 폴더가 없습니다'}</p>
      {folderPath && <p className="lx-small text-muted break-all">{folderPath}</p>}
      <div className="lx-sidebar-section">
        <h3>필터</h3>
        <label className="lx-field-label" htmlFor="filename-filter">파일명 검색</label>
        <input id="filename-filter" value={filter.text} placeholder="파일명 입력" onChange={(e) => setFilter({ text: e.target.value })} />
        <label className="lx-field-label" htmlFor="extension-filter">파일 형식</label>
        <select id="extension-filter" value={filter.ext} onChange={(e) => setFilter({ ext: e.target.value })}><option value="all">모든 형식</option>{extensions.map((ext) => <option key={ext} value={ext}>{ext.slice(1).toUpperCase()}</option>)}</select>
        <label className="lx-field-label">최소 별점</label>
        <div className="flex items-center justify-between"><StarRating rating={filter.minRating} interactive size={19} onChange={(minRating) => setFilter({ minRating })} /><button onClick={() => setFilter({ minRating: 0 })} className="text-muted text-[12px]">해제</button></div>
        <label className="flex gap-2 items-center mt-4"><input type="checkbox" checked={filter.flaggedOnly} onChange={(e) => setFilter({ flaggedOnly: e.target.checked })} />표시한 사진만</label>
      </div>
      <p className="lx-small mt-auto pt-5 text-muted">⌘/Ctrl 클릭 · 다중 선택<br />Shift 클릭 · 범위 선택<br />더블클릭 / Enter · 사진 편집</p>
    </aside>
    <section className="lx-library-main" aria-label="사진 목록">
      <div className="lx-library-toolbar">
        <span className="min-w-0 truncate">{visible.length}장 <span className="text-muted">/ 전체 {photos.length}장</span></span>
        <div className="flex items-center gap-3">
          <select aria-label="사진 정렬" value={ui.sort} onChange={(e) => ui.setSort(e.target.value as typeof ui.sort)}><option value="name">파일명순</option><option value="date">최신 날짜순</option><option value="rating">높은 별점순</option></select>
          <label className="lx-thumb-size">사진 크기 <input aria-label="목록 사진 크기" type="range" min="120" max="280" step="20" value={ui.thumbSize} onChange={(e) => ui.setThumbSize(Number(e.target.value))} /></label>
          <button aria-pressed={ui.infoOpen} onClick={ui.toggleInfo}>정보</button>
          <Button disabled={!selectedPath} onClick={() => ui.setWorkspace('develop')}>사진 편집</Button>
        </div>
      </div>
      {hasFilters && <div className="lx-filter-chips" aria-label="적용된 필터">
        {filter.text && <button onClick={() => setFilter({ text: '' })}>파일명: {filter.text} ×</button>}
        {filter.ext !== 'all' && <button onClick={() => setFilter({ ext: 'all' })}>{filter.ext} ×</button>}
        {filter.minRating > 0 && <button onClick={() => setFilter({ minRating: 0 })}>★ {filter.minRating} 이상 ×</button>}
        {filter.flaggedOnly && <button onClick={() => setFilter({ flaggedOnly: false })}>표시한 사진 ×</button>}
        <button onClick={() => setFilter(DEFAULT_FILTER)}>모두 지우기</button>
      </div>}
      {error && <p role="alert" className="lx-error">{error} <button onClick={() => void openFolder()}>폴더 다시 열기</button></p>}
      <div ref={viewport} tabIndex={0} onKeyDown={keyboard} className="lx-library-viewport" aria-label="사진 선택, 방향키로 이동" onScroll={(e) => { setScroll(e.currentTarget.scrollTop); ui.setScrollTop(e.currentTarget.scrollTop) }}>
        {loading ? <div className="lx-empty" role="status"><h2>사진 목록을 읽고 있습니다</h2><p>작은 사진은 준비되는 순서대로 표시됩니다.</p></div> : photos.length === 0 ? <div className="lx-empty"><h1>{folderPath ? '표시할 사진이 없습니다' : '나의 사진 작업실'}</h1><p>{folderPath ? '지원하는 사진 파일이 들어 있는 폴더를 열어 주세요.' : '폴더를 열고 사진을 고른 뒤, 빛과 색을 다듬어 보세요.'}</p><Button variant="primary" onClick={() => void openFolder()}>폴더 열기</Button></div> : visible.length === 0 ? <div className="lx-empty"><h2>조건에 맞는 사진이 없습니다</h2><Button onClick={() => setFilter(DEFAULT_FILTER)}>필터 지우기</Button></div> : <div style={{ height: Math.ceil(visible.length / columns) * rowHeight, position: 'relative' }}>
          <div className="lx-library-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${rowHeight - 12}px`, transform: `translateY(${startRow * rowHeight}px)` }}>
            {slice.map((photo) => <Thumbnail key={photo.filePath} photo={photo} active={selectedPath === photo.filePath} selected={selection.has(photo.filePath)} showName onClick={(e) => { keyboardPath.current = photo.filePath; useStore.getState().pickPhoto(photo.filePath, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey, order }) }} onDoubleClick={() => { useStore.getState().selectPhoto(photo.filePath); ui.setWorkspace('develop') }} className="lx-grid-thumbnail" />)}
          </div>
        </div>}
      </div>
      <BatchSyncBar />
    </section>
    {ui.infoOpen && <PhotoInfo />}
  </main>
}
function PhotoInfo(): JSX.Element {
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath))
  const meta = photo?.meta
  return <aside className="lx-photo-info"><div className="flex items-center justify-between"><h2>사진 정보</h2><button aria-label="사진 정보 닫기" onClick={() => useWorkspaceStore.getState().toggleInfo()}>×</button></div>{photo ? <>
    <p className="break-all mt-4">{photo.fileName}</p><dl>
      <dt>크기</dt><dd>{meta?.width && meta.height ? `${meta.width} × ${meta.height} px` : '읽는 중 / 정보 없음'}</dd>
      <dt>카메라</dt><dd>{meta?.cameraModel ?? '정보 없음'}</dd>
      <dt>감도</dt><dd>{meta?.iso ? `ISO ${meta.iso}` : '정보 없음'}</dd>
      <dt>조리개</dt><dd>{meta?.aperture ? `f/${meta.aperture}` : '정보 없음'}</dd>
      <dt>초점 거리</dt><dd>{meta?.focalLen ? `${meta.focalLen} mm` : '정보 없음'}</dd>
      <dt>촬영 날짜</dt><dd>{meta?.capturedAt ? new Date(meta.capturedAt).toLocaleString('ko-KR') : '정보 없음'}</dd>
    </dl><StarRating rating={photo.rating} interactive size={20} onChange={(r) => useStore.getState().setRating(photo.filePath, r)} /><button className="lx-btn mt-3" aria-pressed={photo.flagged} onClick={() => useStore.getState().setFlag(photo.filePath, !photo.flagged)}>{photo.flagged ? '⚑ 표시 해제' : '⚑ 사진에 표시'}</button>
  </> : <p className="mt-4 text-muted">사진을 선택하세요.</p>}</aside>
}
function BatchSyncBar(): JSX.Element | null {
  const count = useStore((s) => s.selection.size)
  const syncing = useStore((s) => s.syncing)
  const source = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath)?.fileName)
  const [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const ref = useDialogFocus(confirm, () => { if (!syncing) setConfirm(false) })
  if (count < 2) return null
  async function sync(): Promise<void> {
    const targets = count - 1
    try { const n = await useStore.getState().syncEditToSelection(); setResult(`${n}/${targets}장 저장${n < targets ? ' · 일부 실패' : ' 완료'}`) } catch (error) { setResult(`동기화 실패: ${error instanceof Error ? error.message : String(error)}`) }
    setConfirm(false)
  }
  return <div className="lx-batch-bar"><span>{count}장 선택</span><span role="status" className="text-muted">{result}</span><button onClick={() => useStore.getState().copyEdit()}>보정 복사</button><button onClick={() => setConfirm(true)}>선택 사진에 보정 적용…</button><button onClick={() => useStore.getState().clearSelection()}>선택 해제</button>
    {confirm && <div className="lx-modal-backdrop"><div ref={ref} role="dialog" aria-modal="true" aria-labelledby="sync-title" tabIndex={-1} className="lx-modal p-5 max-w-lg"><h2 id="sync-title">{count - 1}장에 같은 보정 적용</h2><p className="mt-3 break-all">기준 사진: {source}</p><p className="mt-3 text-muted leading-relaxed">밝기·색상·커브·효과·선명도 설정을 복사합니다. 자르기·수평·뒤집기·부분 보정·RGB 복원 강도는 대상 사진의 값을 유지합니다.</p><p className="mt-2 text-muted">대상 사진의 보정 파일에 저장됩니다.</p><div className="flex justify-end gap-3 mt-5"><Button disabled={syncing} onClick={() => setConfirm(false)}>취소</Button><Button disabled={syncing} variant="primary" onClick={() => void sync()}>{syncing ? '저장 중…' : `${count - 1}장에 적용`}</Button></div></div></div>}
  </div>
}
