import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'
import type { CropRect } from '../../types'

// Interactive crop rectangle, laid over the (uncropped) image while crop mode is
// active. The rect is stored normalized 0..1 in the straightened-image space —
// exactly what the shader's uCrop consumes — so what you frame is what renders.

const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }
const MIN = 0.06 // smallest normalized crop edge
type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'move'

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

interface Props {
  /** Image pixel aspect (w/h) — needed to honour a locked crop ratio in the
      normalized (squished) coordinate space. */
  imgAspect: number
}

export function CropOverlay({ imgAspect }: Props): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const crop = useStore((s) => s.edit.crop) ?? FULL
  const setEdit = useStore((s) => s.setEdit)
  const cropAspect = useStore((s) => s.cropAspect)
  const drag = useRef<{ handle: Handle; sx: number; sy: number; rect: CropRect } | null>(null)

  // Locked ratio expressed in normalized space (the frame is squished by imgAspect).
  const normAspect = cropAspect ? cropAspect / imgAspect : null

  function toNorm(e: ReactPointerEvent): [number, number] {
    const r = rootRef.current!.getBoundingClientRect()
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]
  }

  function begin(handle: Handle) {
    return (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.stopPropagation()
      const [sx, sy] = toNorm(e)
      drag.current = { handle, sx, sy, rect: crop }
      rootRef.current?.setPointerCapture(e.pointerId)
    }
  }

  function onMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current
    if (!d) return
    const [nx, ny] = toNorm(e)
    const { handle, sx, sy, rect } = d

    if (handle === 'move') {
      const x = clamp(rect.x + (nx - sx), 0, 1 - rect.w)
      const y = clamp(rect.y + (ny - sy), 0, 1 - rect.h)
      setEdit({ crop: { x, y, w: rect.w, h: rect.h } })
      return
    }

    let left = rect.x
    let right = rect.x + rect.w
    let top = rect.y
    let bottom = rect.y + rect.h
    if (handle.includes('w')) left = nx
    if (handle.includes('e')) right = nx
    if (handle.includes('n')) top = ny
    if (handle.includes('s')) bottom = ny

    // Anchor = the edge(s) NOT being dragged, so resizing grows from the far side.
    const anchorX = handle.includes('w') ? rect.x + rect.w : rect.x
    const anchorY = handle.includes('n') ? rect.y + rect.h : rect.y

    let w = Math.max(MIN, Math.abs(right - left))
    let h = Math.max(MIN, Math.abs(bottom - top))

    if (normAspect) {
      const isCorner = handle.length === 2
      if (isCorner) {
        // Drive height from width, keep the dragged corner heading the right way.
        h = w / normAspect
      } else if (handle === 'e' || handle === 'w') {
        h = w / normAspect
      } else {
        w = h * normAspect
      }
    }

    // Rebuild the rect origin from the fixed anchor edge(s).
    let x = handle.includes('w') ? anchorX - w : handle.includes('e') ? anchorX : rect.x
    let y = handle.includes('n') ? anchorY - h : handle.includes('s') ? anchorY : rect.y
    // Edge handles whose perpendicular size changed (aspect lock) stay centred.
    if (normAspect && (handle === 'e' || handle === 'w')) y = rect.y + rect.h / 2 - h / 2
    if (normAspect && (handle === 'n' || handle === 's')) x = rect.x + rect.w / 2 - w / 2

    // Clamp into the frame; if we overflow, shrink to fit while keeping ratio.
    if (x < 0) {
      w += x
      if (normAspect) h = w / normAspect
      x = 0
    }
    if (y < 0) {
      h += y
      if (normAspect) w = h * normAspect
      y = 0
    }
    if (x + w > 1) {
      w = 1 - x
      if (normAspect) h = w / normAspect
    }
    if (y + h > 1) {
      h = 1 - y
      if (normAspect) w = h * normAspect
    }
    w = clamp(w, MIN, 1)
    h = clamp(h, MIN, 1)
    x = clamp(x, 0, 1 - w)
    y = clamp(y, 0, 1 - h)
    setEdit({ crop: { x, y, w, h } })
  }

  function onUp(e: ReactPointerEvent<HTMLDivElement>): void {
    drag.current = null
    rootRef.current?.releasePointerCapture?.(e.pointerId)
  }

  const pct = (v: number): string => `${v * 100}%`
  const box = {
    left: pct(crop.x),
    top: pct(crop.y),
    width: pct(crop.w),
    height: pct(crop.h)
  }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-10 touch-none select-none"
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {/* Scrim over everything outside the crop (four bands). */}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute bg-black/55" style={{ left: 0, top: 0, right: 0, height: pct(crop.y) }} />
        <div className="absolute bg-black/55" style={{ left: 0, bottom: 0, right: 0, height: pct(1 - crop.y - crop.h) }} />
        <div className="absolute bg-black/55" style={{ left: 0, top: box.top, width: pct(crop.x), height: box.height }} />
        <div className="absolute bg-black/55" style={{ right: 0, top: box.top, width: pct(1 - crop.x - crop.w), height: box.height }} />
      </div>

      {/* Crop window. */}
      <div className="absolute cursor-move" style={box} onPointerDown={begin('move')}>
        {/* border + rule-of-thirds grid */}
        <div className="pointer-events-none absolute inset-0 border border-white/80 shadow-[0_0_0_1px_rgba(0,0,0,0.4)]">
          <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
          <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
          <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
          <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
        </div>

        {/* corner + edge handles */}
        {CORNERS.map(({ h, cls, cursor }) => (
          <div
            key={h}
            onPointerDown={begin(h)}
            className={`absolute h-4 w-4 ${cls}`}
            style={{ cursor }}
          >
            <div className="absolute h-3.5 w-3.5 rounded-[3px] border-2 border-accent bg-black/40" style={cornerBead(h)} />
          </div>
        ))}
        {EDGES.map(({ h, cls, cursor }) => (
          <div key={h} onPointerDown={begin(h)} className={`absolute ${cls}`} style={{ cursor }} />
        ))}
      </div>
    </div>
  )
}

// Corner hit-targets (16px) anchored to each corner.
const CORNERS: { h: Handle; cls: string; cursor: string }[] = [
  { h: 'nw', cls: '-left-2 -top-2', cursor: 'nwse-resize' },
  { h: 'ne', cls: '-right-2 -top-2', cursor: 'nesw-resize' },
  { h: 'se', cls: '-right-2 -bottom-2', cursor: 'nwse-resize' },
  { h: 'sw', cls: '-left-2 -bottom-2', cursor: 'nesw-resize' }
]
// Place the visible bead inside each corner.
function cornerBead(h: Handle): React.CSSProperties {
  return {
    left: h.includes('w') ? 1 : undefined,
    right: h.includes('e') ? 1 : undefined,
    top: h.includes('n') ? 1 : undefined,
    bottom: h.includes('s') ? 1 : undefined
  }
}
// Edge hit-targets: thin strips centred on each edge.
const EDGES: { h: Handle; cls: string; cursor: string }[] = [
  { h: 'n', cls: 'left-4 right-4 -top-1.5 h-3', cursor: 'ns-resize' },
  { h: 's', cls: 'left-4 right-4 -bottom-1.5 h-3', cursor: 'ns-resize' },
  { h: 'w', cls: 'top-4 bottom-4 -left-1.5 w-3', cursor: 'ew-resize' },
  { h: 'e', cls: 'top-4 bottom-4 -right-1.5 w-3', cursor: 'ew-resize' }
]
