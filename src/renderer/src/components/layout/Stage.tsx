import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { ApertureMark } from '../ui/ApertureMark'
import { StarRating } from '../ui/StarRating'
import { EditCanvas } from '../ui/EditCanvas'
import { SplitHandle } from '../ui/SplitHandle'
import { CropOverlay } from '../ui/CropOverlay'
import { MaskOverlay } from '../ui/MaskOverlay'
import { BrushOverlay } from '../ui/BrushOverlay'
import { maskSlotIndex } from '../../lib/editShader'
import { viewToSource, type PhotoPoint } from '../../lib/photoCoordinates'
import type { PhotoMeta } from '../../types'
import { useWorkspaceStore, sortPhotos } from '../../store/useWorkspaceStore'
import { useAgentStore, type AgentComparison } from '../../store/useAgentStore'
import { useViewport } from '../../lib/useViewport'
import { containPhoto, MAX_ZOOM, MIN_ZOOM } from '../../lib/viewport'
import type { EditState } from '../../../../shared/edits'

// Full-bleed image stage. Renders the decoded 2560px proxy through the WebGL
// develop pipeline (EditCanvas) so edits preview in real time; full-res is
// export-only. B holds the original; Space temporarily enables the hand tool.
export function Stage({ photoOnly = false }: { photoOnly?: boolean }): JSX.Element {
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const proxy = useStore((s) => s.proxy)
  const edit = useStore((s) => s.previewEdit ?? s.edit)
  const background = useWorkspaceStore((s) => s.background)
  const comparison = useAgentStore((s) => s.comparison?.photoId === photo?.filePath ? s.comparison : null)
  const [frame, setFrame] = useState({ width: 800, height: 600 })
  const viewport = useViewport(photo?.filePath ?? null)
  const { areaRef: photoAreaRef, view } = viewport
  useEffect(() => {
    const el = photoAreaRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setFrame({ width: Math.max(1, el.clientWidth - 48), height: Math.max(1, el.clientHeight - 48) }))
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const showBefore = useStore((s) => s.showBefore)
  const splitCompare = useStore((s) => s.splitCompare)
  const splitPos = useStore((s) => s.splitPos)
  const setRating = useStore((s) => s.setRating)
  const setFlag = useStore((s) => s.setFlag)
  const cropMode = useStore((s) => s.cropMode)
  const straightening = useStore((s) => s.straightening)
  const wbPicking = useStore((s) => s.wbPicking)
  const colorPicking = useStore((s) => s.colorPicking)
  const selectedMaskId = useStore((s) => s.selectedMaskId)
  const showMaskOverlay = useStore((s) => s.showMaskOverlay)
  const maskOverlayMode = useStore((s) => s.maskOverlayMode)
  const showClipping = useStore((s) => s.showClipping)
  const suppressMaskOverlay = useStore((s) => s.suppressMaskOverlay)
  const maskSelected = selectedMaskId !== null
  const restoration = useStore((s) => s.denoiseProxy)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const pickerRequest = useRef(0)
  useEffect(() => {
    const off = useStore.subscribe((next, previous) => {
      if (next.selectedPath !== previous.selectedPath || next.proxy.url !== previous.proxy.url ||
          next.wbPicking !== previous.wbPicking || next.colorPicking !== previous.colorPicking ||
          next.selectedMaskId !== previous.selectedMaskId || next.selectedRefineId !== previous.selectedRefineId ||
          next.edit !== previous.edit || next.previewEdit !== previous.previewEdit || next.cropMode !== previous.cropMode ||
          next.denoiseProxy.url !== previous.denoiseProxy.url) pickerRequest.current++
    })
    return () => { off(); pickerRequest.current++ }
  }, [])

  useStageKeyboard()

  const compareMode: 0 | 1 | 2 = cropMode || comparison ? 0 : showBefore ? 1 : splitCompare ? 2 : 0
  const imgAspect = aspectNumber(photo?.meta ?? null)
  // While cropping, show the whole (uncropped) frame; otherwise the display box
  // takes the crop's own aspect so the cropped result isn't stretched.
  const displayAspect =
    cropMode || !edit.crop ? imgAspect : imgAspect * (edit.crop.w / edit.crop.h)
  const shownEdit = useMemo(() => cropMode ? { ...edit, crop: null } : edit, [cropMode, edit])
  const denoiseUrl = useStore((s) =>
    s.denoiseProxy.status === 'ready' && s.denoiseProxy.filePath === s.selectedPath
      ? s.denoiseProxy.url
      : null
  )
  const comparisonDenoiseUnavailable = !!comparison && !denoiseUrl &&
    ((comparison.mode !== 'after' && comparison.before.denoise > 0) ||
      (comparison.mode !== 'before' && comparison.after.denoise > 0))
  const maskPreview =
    !cropMode && maskSelected && showMaskOverlay && !suppressMaskOverlay
      ? maskSlotIndex(edit, selectedMaskId)
      : -1

  async function onWbClick(e: {
    clientX: number
    clientY: number
    currentTarget: HTMLDivElement
  }): Promise<void> {
    const current = useStore.getState()
    if (useAgentStore.getState().comparison || (!current.wbPicking && !current.colorPicking) || !current.proxy.url || current.editLoading) return
    const request = ++pickerRequest.current
    const path = current.selectedPath
    const url = current.proxy.url
    const rect = e.currentTarget.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const point = { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) }
    const preview = current.previewEdit ?? current.edit
    const geometry = current.cropMode ? { ...preview, crop: null } : preview
    const restoredUrl = current.denoiseProxy.status === 'ready' && current.denoiseProxy.filePath === path ? current.denoiseProxy.url : null
    setPickerError(null)
    try {
      const original = new Image()
      original.src = url
      await original.decode()
      if (request !== pickerRequest.current || useAgentStore.getState().comparison) return
      const source = viewToSource(point, geometry, original.naturalWidth / original.naturalHeight)
      let [r, g, b] = samplePatch(original, source)
      if (restoredUrl && preview.denoise > 0) {
        const restored = new Image()
        restored.src = restoredUrl
        await restored.decode()
        if (request !== pickerRequest.current) return
        const rgb = samplePatch(restored, source)
        const amount = Math.min(1, Math.max(0, preview.denoise / 100))
        r += (rgb[0] - r) * amount; g += (rgb[1] - g) * amount; b += (rgb[2] - b) * amount
      }
      if (request !== pickerRequest.current || useAgentStore.getState().comparison) return
      // The subscription invalidates pending reads on photo, tool, selected mask,
      // geometry, edit or restored-source changes, including A -> B -> A.
      if (current.colorPicking) useStore.getState().pickMaskColor(r, g, b)
      else useStore.getState().pickWhiteBalance(r, g, b)
    } catch (error) {
      if (request === pickerRequest.current) setPickerError(`색상 샘플을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const imageWidth = Math.max(1, Math.min(frame.width, frame.height * displayAspect))
  const navigationHelp = '두 손가락·휠: 이동 · Shift+휠: 가로 이동 · 핀치·Ctrl/⌘+휠: 확대/축소 · Space+드래그·가운데 버튼: 이동 · Shift+1: 화면 맞춤 · B 누르기: 원본 보기'
  return (
    <section className="lx-stage" aria-label="사진 편집 미리보기" style={{ background: { dark: '#151515', gray: '#555555', light: '#AAAAAA' }[background] }}>
      {!photoOnly && pickerError && <p role="alert" className="bg-surface px-3 py-2 text-[12px] text-red-300">{pickerError}</p>}
      {!photoOnly && edit.denoise > 0 && !denoiseUrl && <p role="status" className="bg-surface px-3 py-2 text-[12px] text-muted">{restoration.status === 'running' ? `노이즈 제거 미리보기 생성 중 · ${Math.round(restoration.progress * 100)}%` : restoration.status === 'error' ? `노이즈 제거 미리보기 없음 · ${restoration.message ?? '다시 실행해 주세요.'}` : '노이즈 제거 미리보기를 준비하고 있습니다.'} 현재 사진은 복원이 적용되지 않은 상태로 표시됩니다. 내보내기는 원본 해상도에서 복원을 별도로 계산합니다.</p>}
      {comparison && <div data-agent-comparison={comparison.mode} className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-surface px-3 py-2 text-[12px]"><span className="min-w-0 truncate" title={comparison.label}>AI 보정 비교 · {comparison.label}</span><button onClick={() => useAgentStore.getState().setComparison(null)} className="shrink-0 text-accent">현재 편집으로 돌아가기</button></div>}
      {comparisonDenoiseUnavailable && <p role="status" className="bg-surface px-3 py-2 text-[12px] text-muted">노이즈 제거 미리보기가 없어 이 비교에는 복원이 아직 반영되지 않았습니다. 나머지 보정만 표시하며, 적용 후 복원 결과를 확인할 수 있습니다.</p>}
      <div ref={photoAreaRef} {...viewport.handlers} tabIndex={-1} className="lx-photo-area outline-none" aria-label="사진 화면 이동 및 확대" style={{ touchAction: 'none', cursor: viewport.panning ? 'grabbing' : viewport.spaceHeld ? 'grab' : undefined }}>
        {!photo ? <WelcomeHint /> : proxy.status === 'ready' && proxy.url ? (
          <div data-viewport-image data-zoom={view.z} data-pan-x={view.x} data-pan-y={view.y}
            onClick={!comparison && (wbPicking || colorPicking) ? (e) => void onWbClick(e) : undefined}
            className="relative shrink-0 overflow-hidden"
            style={{ width: comparison ? frame.width : imageWidth, height: comparison ? frame.height : imageWidth / displayAspect, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`, cursor: viewport.panning ? 'grabbing' : viewport.spaceHeld ? 'grab' : !comparison && (wbPicking || colorPicking) ? 'crosshair' : undefined }}>
            {comparison ? <AgentCompare comparison={comparison} imageUrl={proxy.url} frame={frame} aspect={imgAspect} splitPos={splitPos} denoiseUrl={denoiseUrl} /> : <>
              <EditCanvas imageUrl={proxy.url} edit={shownEdit} compareMode={compareMode} splitPos={splitPos} maskPreview={maskPreview} overlayMode={maskOverlayMode} showClip={showClipping} denoiseUrl={denoiseUrl} className="block h-full w-full" />
              {cropMode && <CropOverlay imgAspect={imgAspect} />}
              {!cropMode && maskSelected && <MaskOverlay />}
              {!cropMode && maskSelected && <BrushOverlay />}
              {straightening && !cropMode && <StraightenGrid />}
              {!cropMode && compareMode === 2 && <SplitHandle />}
              {!cropMode && compareMode !== 0 && <span className="pointer-events-none absolute left-3 top-3 bg-black/70 px-2 py-1 text-[12px] text-ink">원본</span>}
            </>}
            {(viewport.spaceHeld || viewport.panning) && <div className="absolute inset-0 z-50" style={{ cursor: viewport.panning ? 'grabbing' : 'grab' }} />}
          </div>
        ) : proxy.status === 'error' ? <DecodeError message={proxy.message} /> : <DecodingSpinner fileName={photo.fileName} />}
      </div>
      {!photoOnly && <div className="lx-stage-toolbar">
        <div className="flex min-w-0 items-center gap-3">
          <span title={photo?.fileName} className="truncate text-[12px]">{photo?.fileName ?? '사진을 선택하세요'}</span>
          {photo && <><StarRating rating={photo.rating} interactive size={17} onChange={(r) => setRating(photo.filePath, r)} /><button aria-label="사진에 표시 (P)" aria-pressed={photo.flagged} onClick={() => setFlag(photo.filePath, !photo.flagged)} className={photo.flagged ? 'text-accent' : 'text-muted'}>⚑</button><button aria-pressed={splitCompare} disabled={cropMode || !!comparison} title="원본과 현재 편집 나란히 비교 (\\) · B를 누르는 동안 원본 보기" onClick={() => useStore.getState().setSplit(!splitCompare)}>전후 비교</button></>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <select aria-label="사진 주변 배경" value={background} onChange={(e) => useWorkspaceStore.getState().setBackground(e.target.value as typeof background)}><option value="dark">어두운 배경</option><option value="gray">중간 회색</option><option value="light">밝은 회색</option></select>
          <ZoomBtn label="미리보기 축소" onClick={() => viewport.zoom(1 / 1.5)} disabled={!photo || view.z <= MIN_ZOOM}><path d="M3 8h10" /></ZoomBtn>
          <button aria-label="사진 화면 맞춤" aria-keyshortcuts="Shift+1" disabled={!photo} title={`화면 맞춤으로 위치와 확대 배율 초기화 (Shift+1). 표시 배율은 맞춤 기준입니다.\n${navigationHelp}`} onClick={viewport.fit} className="lx-num text-[12px] min-w-[64px]">맞춤 · {view.z.toFixed(1)}×</button>
          <ZoomBtn label="미리보기 확대" onClick={() => viewport.zoom(1.6)} disabled={!photo || view.z >= MAX_ZOOM}><path d="M8 3v10M3 8h10" /></ZoomBtn>
        </div>
      </div>}
    </section>
  )
}

function AgentCompare({ comparison, imageUrl, frame, aspect, splitPos, denoiseUrl }: {
  comparison: AgentComparison; imageUrl: string; frame: { width: number; height: number }
  aspect: number; splitPos: number; denoiseUrl: string | null
}): JSX.Element {
  function layer(edit: EditState, side: 'before' | 'after'): JSX.Element {
    const size = containPhoto(frame, edit.crop ? aspect * edit.crop.w / edit.crop.h : aspect)
    const split = comparison.mode === 'split'
    return <div key={side} data-agent-comparison-layer={side} className="absolute inset-0 flex items-center justify-center" style={{ clipPath: split ? side === 'before' ? `inset(0 ${(1 - splitPos) * 100}% 0 0)` : `inset(0 0 0 ${splitPos * 100}%)` : undefined }}>
      <div className="shrink-0" style={size}><EditCanvas imageUrl={imageUrl} edit={edit} compareMode={0} splitPos={splitPos} denoiseUrl={denoiseUrl} publishHistogram={false} className="block h-full w-full" /></div>
    </div>
  }
  return <>
    {comparison.mode !== 'after' && layer(comparison.before, 'before')}
    {comparison.mode !== 'before' && layer(comparison.after, 'after')}
    {comparison.mode === 'split' && <SplitHandle />}
    {comparison.mode !== 'after' && <span className="pointer-events-none absolute left-3 top-3 bg-black/70 px-2 py-1 text-[12px] text-ink">AI 보정 전</span>}
    {comparison.mode !== 'before' && <span className="pointer-events-none absolute right-3 top-3 bg-black/70 px-2 py-1 text-[12px] text-ink">AI 보정 후</span>}
  </>
}

function ZoomBtn({
  label,
  onClick,
  disabled,
  children
}: {
  label: string
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      disabled={disabled}
      className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-white/5 hover:text-ink disabled:opacity-30"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
        {children}
      </svg>
    </button>
  )
}

// Fine alignment grid shown while dragging Straighten, for lining up horizons
// and verticals. Non-interactive; fades in over the image.
function StraightenGrid(): JSX.Element {
  const cells = 8
  const lines = Array.from({ length: cells - 1 }, (_, i) => ((i + 1) / cells) * 100)
  return (
    <div className="pointer-events-none absolute inset-0 z-10">
      {lines.map((p) => (
        <div key={`v${p}`} className="absolute inset-y-0 w-px bg-white/20" style={{ left: `${p}%` }} />
      ))}
      {lines.map((p) => (
        <div key={`h${p}`} className="absolute inset-x-0 h-px bg-white/20" style={{ top: `${p}%` }} />
      ))}
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-accent/50" />
      <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-accent/50" />
    </div>
  )
}

function aspectNumber(meta: PhotoMeta | null): number {
  if (meta && meta.width && meta.height) return meta.width / meta.height
  return 3 / 2
}

function DecodingSpinner({ fileName }: { fileName: string }): JSX.Element {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
      <p className="lx-num text-[12px] text-muted">{fileName}</p>
      <p className="lx-eyebrow mt-1">편집용 사진을 준비하는 중…</p>
    </div>
  )
}

function DecodeError({ message }: { message: string | null }): JSX.Element {
  return (
    <div className="max-w-xs text-center">
      <p className="text-[13px] text-ink">사진을 열 수 없습니다</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
        {message ?? '원본 파일이 없거나 현재 디코더에서 지원하지 않는 형식입니다.'}
      </p>
    </div>
  )
}

function WelcomeHint(): JSX.Element {
  return <div className="lx-empty"><ApertureMark size={30} /><h2>사진을 선택해 편집을 시작하세요</h2><button className="lx-btn" onClick={() => useWorkspaceStore.getState().setWorkspace('library')}>사진 목록으로</button></div>
}

// Keyboard: hold B = original, ←/→ navigate the filtered list, 0–5 set the
// rating on the selected photo, P toggles its flag.
function useStageKeyboard(): void {
  const setShowBefore = useStore((s) => s.setShowBefore)
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      const el = t instanceof Element ? t : null
      return !!el && !!el.closest('input, select, textarea, [contenteditable="true"], [role="slider"], [role="dialog"], button')
    }
    function down(e: KeyboardEvent): void {
      if (e.defaultPrevented || e.isComposing || isTyping(e.target) || document.querySelector('[role="dialog"]')) return
      const s = useStore.getState()
      if (s.editLoading || s.syncing) return
      if (useAgentStore.getState().comparison && !['ArrowLeft', 'ArrowRight'].includes(e.key)) return
      if (useWorkspaceStore.getState().photoOnly && !['ArrowLeft', 'ArrowRight', 'b', 'B'].includes(e.key)) return
      // Copy / paste develop settings across photos.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C')) {
        e.preventDefault()
        s.copyEdit()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        s.pasteEdit()
        return
      }
      // Crop: 'C' toggles crop mode, Escape leaves it.
      if ((e.key === 'c' || e.key === 'C') && !e.metaKey && !e.ctrlKey) {
        if (s.selectedPath) s.setCropMode(!s.cropMode)
        return
      }
      // Mask overlay: 'O' toggles the coverage overlay, Shift+O cycles its
      // rendering (red / white-on-black / black-on-white). Masking mode only.
      if ((e.key === 'o' || e.key === 'O') && !e.metaKey && !e.ctrlKey && s.maskMode) {
        if (e.shiftKey) s.cycleMaskOverlayMode()
        else s.setShowMaskOverlay(!s.showMaskOverlay)
        return
      }
      if (e.key === 'Escape' && s.cropMode) {
        s.setCropMode(false)
        return
      }
      if (e.code === 'KeyB' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.repeat) {
        e.preventDefault()
        setShowBefore(true)
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const list = sortPhotos(selectFilteredPhotos(s), useWorkspaceStore.getState().sort)
        if (!list.length) return
        const idx = list.findIndex((p) => p.filePath === s.selectedPath)
        const next = e.key === 'ArrowLeft' ? Math.max(0, idx - 1) : Math.min(list.length - 1, idx + 1)
        e.preventDefault()
        if (list[next]) s.pickPhoto(list[next].filePath, { meta: false, shift: e.shiftKey, order: list.map((p) => p.filePath) })
        return
      }
      if (e.key === '\\') {
        s.setSplit(!s.splitCompare)
        return
      }
      // Clipping zebras: red = blown highlights, blue = crushed shadows.
      if ((e.key === 'j' || e.key === 'J') && !e.metaKey && !e.ctrlKey) {
        s.setShowClipping(!s.showClipping)
        return
      }
      if (s.selectedPath && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        if (/^[0-5]$/.test(e.key)) s.setRating(s.selectedPath, Number(e.key))
        else if (e.key === 'p' || e.key === 'P') {
          const cur = s.photos.find((p) => p.filePath === s.selectedPath)
          if (cur) s.setFlag(cur.filePath, !cur.flagged)
        }
      }
    }
    function up(e: KeyboardEvent): void {
      if (e.code === 'KeyB') setShowBefore(false)
    }
    const blur = (): void => setShowBefore(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
      setShowBefore(false)
    }
  }, [setShowBefore])
}

function samplePatch(image: HTMLImageElement, point: PhotoPoint): [number, number, number] {
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d')
  if (!context || !canvas.width || !canvas.height) throw new Error('디코딩된 사진 픽셀이 없습니다.')
  context.drawImage(image, 0, 0)
  const px = Math.round(point.x * (canvas.width - 1)), py = Math.round(point.y * (canvas.height - 1))
  const x = Math.max(0, px - 2), y = Math.max(0, py - 2)
  const w = Math.min(canvas.width, px + 3) - x, h = Math.min(canvas.height, py + 3) - y
  const pixels = context.getImageData(x, y, w, h).data
  const result: [number, number, number] = [0, 0, 0]
  for (let i = 0; i < pixels.length; i += 4) { result[0] += pixels[i]; result[1] += pixels[i + 1]; result[2] += pixels[i + 2] }
  return result.map((channel) => channel / (pixels.length / 4)) as [number, number, number]
}
