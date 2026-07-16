import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { ApertureMark } from '../ui/ApertureMark'
import { StarRating } from '../ui/StarRating'
import { EditCanvas } from '../ui/EditCanvas'
import { SplitHandle } from '../ui/SplitHandle'
import { CropOverlay } from '../ui/CropOverlay'
import { CropBar } from '../ui/CropBar'
import { MaskOverlay } from '../ui/MaskOverlay'
import { BrushOverlay } from '../ui/BrushOverlay'
import { maskSlotIndex } from '../../lib/editShader'
import type { PhotoMeta } from '../../types'

// Full-bleed image stage. Renders the decoded 2560px proxy through the WebGL
// develop pipeline (EditCanvas) so edits preview in real time; full-res is
// export-only. Supports before/after via spacebar (whole) and a draggable split.
export function Stage(): JSX.Element {
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const proxy = useStore((s) => s.proxy)
  const edit = useStore((s) => s.edit)
  const showBefore = useStore((s) => s.showBefore)
  const splitCompare = useStore((s) => s.splitCompare)
  const splitPos = useStore((s) => s.splitPos)
  const setRating = useStore((s) => s.setRating)
  const setFlag = useStore((s) => s.setFlag)
  const cropMode = useStore((s) => s.cropMode)
  const straightening = useStore((s) => s.straightening)
  const wbPicking = useStore((s) => s.wbPicking)
  const pickWhiteBalance = useStore((s) => s.pickWhiteBalance)
  const selectedMaskId = useStore((s) => s.selectedMaskId)
  const showMaskOverlay = useStore((s) => s.showMaskOverlay)
  const suppressMaskOverlay = useStore((s) => s.suppressMaskOverlay)
  const maskSelected = selectedMaskId !== null

  useStageKeyboard()

  const compareMode: 0 | 1 | 2 = cropMode ? 0 : showBefore ? 1 : splitCompare ? 2 : 0
  const imgAspect = aspectNumber(photo?.meta ?? null)
  // While cropping, show the whole (uncropped) frame; otherwise the display box
  // takes the crop's own aspect so the cropped result isn't stretched.
  const displayAspect =
    cropMode || !edit.crop ? imgAspect : imgAspect * (edit.crop.w / edit.crop.h)
  const shownEdit = cropMode ? { ...edit, crop: null } : edit
  const denoiseUrl = useStore((s) =>
    s.denoiseProxy.status === 'ready' && s.denoiseProxy.filePath === s.selectedPath
      ? s.denoiseProxy.url
      : null
  )
  const maskPreview =
    !cropMode && maskSelected && showMaskOverlay && !suppressMaskOverlay
      ? maskSlotIndex(edit, selectedMaskId)
      : -1

  // ── Zoom & pan (view-only; Fit = 1×). Wheel zooms toward the cursor; drag pans
  // when zoomed in. Overlays (crop/mask) scale with the image so they stay aligned.
  const stageRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  const panRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const filePath = photo?.filePath ?? null
  const interactingOverlay = cropMode || maskSelected
  useEffect(() => setView({ z: 1, x: 0, y: 0 }), [filePath])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const mx = e.clientX - rect.left - rect.width / 2
      const my = e.clientY - rect.top - rect.height / 2
      // Trackpads send small deltas, mouse wheels large ones; scale then clamp
      // per-event so one notch moves meaningfully without lurching.
      const factor = Math.min(2.2, Math.max(0.45, Math.exp(-e.deltaY * 0.006)))
      setView((v) => {
        const z = Math.min(12, Math.max(1, v.z * factor))
        if (z <= 1.001) return { z: 1, x: 0, y: 0 }
        const px = (mx - v.x) / v.z
        const py = (my - v.y) / v.z
        return { z, x: mx - px * z, y: my - py * z }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  async function onWbClick(e: {
    clientX: number
    clientY: number
    currentTarget: HTMLDivElement
  }): Promise<void> {
    if (!wbPicking || !proxy.url) return
    const rect = e.currentTarget.getBoundingClientRect()
    const nx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    const ny = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height))
    const cx = edit.crop ? edit.crop.x + nx * edit.crop.w : nx
    const cy = edit.crop ? edit.crop.y + ny * edit.crop.h : ny
    const img = new Image()
    img.src = proxy.url
    await img.decode().catch(() => {})
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    if (!ctx || !c.width) return
    ctx.drawImage(img, 0, 0)
    const px = Math.round(cx * (c.width - 1))
    const py = Math.round(cy * (c.height - 1))
    const s = 2
    const x0 = Math.max(0, px - s)
    const y0 = Math.max(0, py - s)
    const w = Math.min(c.width, px + s + 1) - x0
    const h = Math.min(c.height, py + s + 1) - y0
    const d = ctx.getImageData(x0, y0, w, h).data
    let r = 0
    let g = 0
    let b = 0
    for (let i = 0; i < d.length; i += 4) {
      r += d[i]
      g += d[i + 1]
      b += d[i + 2]
    }
    const n = d.length / 4
    pickWhiteBalance(r / n, g / n, b / n)
  }

  function onPanDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (wbPicking || view.z <= 1 || interactingOverlay) return
    panRef.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function onPanMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const p = panRef.current
    if (!p) return
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.x), y: p.oy + (e.clientY - p.y) }))
  }
  function onPanUp(e: ReactPointerEvent<HTMLDivElement>): void {
    panRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  const setZoom = (z: number): void => setView(z <= 1 ? { z: 1, x: 0, y: 0 } : (v) => ({ ...v, z }))

  return (
    <div ref={stageRef} className="absolute bottom-24 left-72 right-80 top-12 z-[1] overflow-hidden">
      {/* The ambient background is rendered by the WebGL liquid-glass layer
          beneath; this stage stays transparent so it shows through. */}
      <div className="absolute inset-0 flex items-center justify-center p-10">
        {!photo ? (
          <WelcomeHint />
        ) : (
          <div className="relative flex h-full w-full items-center justify-center">
            {proxy.status === 'ready' && proxy.url ? (
              <div
                onPointerDown={onPanDown}
                onPointerMove={onPanMove}
                onPointerUp={onPanUp}
                onClick={wbPicking ? (e) => void onWbClick(e) : undefined}
                className="relative max-h-full max-w-full overflow-hidden rounded-md shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)]"
                style={{
                  aspectRatio: String(displayAspect),
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                  cursor: wbPicking
                    ? 'crosshair'
                    : view.z > 1 && !interactingOverlay
                      ? panRef.current
                        ? 'grabbing'
                        : 'grab'
                      : 'default'
                }}
              >
                <EditCanvas
                  imageUrl={proxy.url}
                  edit={shownEdit}
                  compareMode={compareMode}
                  splitPos={splitPos}
                  maskPreview={maskPreview}
                  denoiseUrl={denoiseUrl}
                  className="block h-full w-full"
                />
                {cropMode && <CropOverlay imgAspect={imgAspect} />}
                {!cropMode && maskSelected && <MaskOverlay />}
                {!cropMode && maskSelected && <BrushOverlay />}
                {straightening && !cropMode && <StraightenGrid />}
                {!cropMode && compareMode === 2 && <SplitHandle />}
                {!cropMode && (compareMode === 1 || compareMode === 2) && (
                  <div className="lx-num pointer-events-none absolute left-3 top-3 rounded border border-accent/70 bg-black/60 px-2 py-0.5 text-[11px] tracking-wide text-accent-soft">
                    BEFORE
                  </div>
                )}
              </div>
            ) : proxy.status === 'error' ? (
              <DecodeError message={proxy.message} />
            ) : (
              <DecodingSpinner fileName={photo.fileName} />
            )}
          </div>
        )}
      </div>

      {/* Zoom control (bottom-right). Scroll to zoom, drag to pan. */}
      {photo && proxy.status === 'ready' && !cropMode && (
        <div className="lx-glass lx-pop-in absolute bottom-4 right-4 z-10 flex items-center gap-1 rounded-full px-1.5 py-1">
          <ZoomBtn onClick={() => setZoom(Math.max(1, view.z / 1.5))} disabled={view.z <= 1}>
            <path d="M3 8h10" />
          </ZoomBtn>
          <button
            onClick={() => setZoom(view.z > 1 ? 1 : 2)}
            className="lx-num min-w-[46px] text-center text-[11px] text-muted transition-colors hover:text-ink"
            title="Toggle fit / zoom"
          >
            {view.z <= 1 ? 'Fit' : `${view.z.toFixed(1)}×`}
          </button>
          <ZoomBtn onClick={() => setZoom(Math.min(12, view.z * 1.6))} disabled={view.z >= 12}>
            <path d="M8 3v10M3 8h10" />
          </ZoomBtn>
        </div>
      )}

      {/* Crop toolbar replaces the normal toolbar while cropping. */}
      {photo && cropMode && <CropBar imgAspect={imgAspect} />}

      {/* Selected-photo toolbar (rating + flag + compare + meta). */}
      {photo && !cropMode && (
        <div className="lx-glass absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3.5 rounded-full px-4 py-1.5">
          <span className="lx-num text-[11px] text-ink">{photo.fileName}</span>
          <MetaLine meta={photo.meta} />
          <StarRating
            rating={photo.rating}
            interactive
            size={14}
            onChange={(r) => setRating(photo.filePath, r)}
          />
          <button
            onClick={() => setFlag(photo.filePath, !photo.flagged)}
            title="Flag (P)"
            className={`text-[13px] transition-colors ${
              photo.flagged ? 'text-accent-soft' : 'text-muted hover:text-ink'
            }`}
          >
            ⚑
          </button>
          <span className="h-3.5 w-px bg-white/10" />
          <button
            onClick={() => useStore.getState().setSplit(!splitCompare)}
            title="Split compare (\\)"
            className={`text-[11px] transition-colors ${
              splitCompare ? 'text-accent-soft' : 'text-muted hover:text-ink'
            }`}
          >
            ⊟ Compare
          </button>
        </div>
      )}

      {photo && proxy.status === 'ready' && !cropMode && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 whitespace-nowrap text-[11px] text-muted">
          Hold <kbd className="lx-num rounded bg-white/10 px-1">Space</kbd> for before / after ·{' '}
          <kbd className="lx-num rounded bg-white/10 px-1">←</kbd>
          <kbd className="lx-num rounded bg-white/10 px-1">→</kbd> navigate ·{' '}
          <kbd className="lx-num rounded bg-white/10 px-1">1–5</kbd> rate ·{' '}
          <kbd className="lx-num rounded bg-white/10 px-1">P</kbd> flag
        </div>
      )}
    </div>
  )
}

function ZoomBtn({
  onClick,
  disabled,
  children
}: {
  onClick: () => void
  disabled?: boolean
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
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

function MetaLine({ meta }: { meta: PhotoMeta | null }): JSX.Element | null {
  if (!meta) return null
  const parts: string[] = []
  if (meta.width && meta.height) parts.push(`${meta.width}×${meta.height}`)
  if (meta.cameraModel) parts.push(meta.cameraModel)
  if (meta.iso) parts.push(`ISO ${meta.iso}`)
  if (!parts.length) return null
  return <span className="lx-num text-[10px] text-faint">{parts.join(' · ')}</span>
}

function DecodingSpinner({ fileName }: { fileName: string }): JSX.Element {
  return (
    <div className="text-center">
      <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-white/15 border-t-accent" />
      <p className="lx-num text-[12px] text-muted">{fileName}</p>
      <p className="lx-eyebrow mt-1">decoding…</p>
    </div>
  )
}

function DecodeError({ message }: { message: string | null }): JSX.Element {
  return (
    <div className="max-w-xs text-center">
      <p className="text-[13px] text-ink">Couldn’t open this photo</p>
      <p className="mt-1.5 text-[12px] leading-relaxed text-muted">
        {message ?? 'The file may be missing or in an unsupported format.'}
      </p>
    </div>
  )
}

function WelcomeHint(): JSX.Element {
  return (
    <div className="max-w-md text-center">
      <div className="mb-6 flex justify-center opacity-90">
        <ApertureMark size={34} />
      </div>
      <h2 className="lx-display text-[30px] font-semibold leading-[1.04] text-ink">
        Your darkroom,
        <br />
        on this machine.
      </h2>
      <p className="mx-auto mt-3.5 max-w-xs text-[13px] leading-relaxed text-muted">
        RAW develop, AI retouch, export — every pixel stays on-device. Nothing ever leaves.
      </p>
      <div className="lx-num mt-7 flex items-center justify-center gap-2.5 text-[11px] text-faint">
        <span>01 open</span>
        <span className="text-accent">/</span>
        <span>02 enhance</span>
        <span className="text-accent">/</span>
        <span>03 export</span>
      </div>
    </div>
  )
}

// Keyboard: Space = before/after, ←/→ navigate the filtered list, 0–5 set the
// rating on the selected photo, P toggles its flag.
function useStageKeyboard(): void {
  const setShowBefore = useStore((s) => s.setShowBefore)
  useEffect(() => {
    function isTyping(t: EventTarget | null): boolean {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')
    }
    function down(e: KeyboardEvent): void {
      if (isTyping(e.target)) return
      const s = useStore.getState()
      // Undo / redo — Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (or Ctrl+Y) to redo.
      if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        s.redo()
        return
      }
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
      if (e.key === 'Escape' && s.cropMode) {
        s.setCropMode(false)
        return
      }
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        setShowBefore(true)
        return
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const list = selectFilteredPhotos(s)
        if (!list.length) return
        const idx = list.findIndex((p) => p.filePath === s.selectedPath)
        const next = e.key === 'ArrowLeft' ? Math.max(0, idx - 1) : Math.min(list.length - 1, idx + 1)
        if (list[next]) s.selectPhoto(list[next].filePath)
        return
      }
      if (e.key === '\\') {
        s.setSplit(!s.splitCompare)
        return
      }
      if (s.selectedPath) {
        if (/^[0-5]$/.test(e.key)) s.setRating(s.selectedPath, Number(e.key))
        else if (e.key === 'p' || e.key === 'P') {
          const cur = s.photos.find((p) => p.filePath === s.selectedPath)
          if (cur) s.setFlag(cur.filePath, !cur.flagged)
        }
      }
    }
    function up(e: KeyboardEvent): void {
      if (e.code === 'Space') setShowBefore(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [setShowBefore])
}
