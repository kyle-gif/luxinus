import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'
import { useEditGesture } from '../../lib/useEditGesture'

// Interactive geometry for the selected radial/linear mask, laid over the image.
// Coordinates are normalized 0..1 in the displayed (post-crop) view space — the
// same space the shader samples masks in — so the handles map 1:1 to coverage.
// (Brush masks paint directly and have no drag-handles here.)

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function MaskOverlay(): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useStore((s) => s.selectedMaskId)
  const mask = useStore((s) => s.edit.masks.find((m) => m.id === id) ?? null)
  const updateMask = useStore((s) => s.updateMask)
  const drag = useRef<{ kind: string; sx: number; sy: number; g: unknown } | null>(null)
  const { begin: beginGesture, end: endGesture, isActive } = useEditGesture()
  useEffect(() => () => { drag.current = null; endGesture() }, [id, endGesture])

  if (!mask || (mask.kind !== 'radial' && mask.kind !== 'linear')) return null

  function toNorm(e: ReactPointerEvent): [number, number] {
    const r = rootRef.current!.getBoundingClientRect()
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)]
  }
  function begin(kind: string) {
    return (e: ReactPointerEvent<HTMLDivElement>): void => {
      if (!beginGesture()) return
      e.stopPropagation()
      const [sx, sy] = toNorm(e)
      drag.current = { kind, sx, sy, g: mask!.kind === 'radial' ? mask!.radial : mask!.linear }
      rootRef.current?.setPointerCapture(e.pointerId)
    }
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const d = drag.current
    if (!d || !mask || !isActive()) return
    const [nx, ny] = toNorm(e)

    if (mask.kind === 'radial' && mask.radial) {
      const g = d.g as typeof mask.radial
      if (d.kind === 'move') {
        updateMask(mask.id, { radial: { ...mask.radial, cx: g.cx + (nx - d.sx), cy: g.cy + (ny - d.sy) } })
      } else if (d.kind === 'e' || d.kind === 'w') {
        updateMask(mask.id, { radial: { ...mask.radial, rx: Math.max(0.02, Math.abs(nx - g.cx)) } })
      } else {
        updateMask(mask.id, { radial: { ...mask.radial, ry: Math.max(0.02, Math.abs(ny - g.cy)) } })
      }
      return
    }
    if (mask.kind === 'linear' && mask.linear) {
      const g = d.g as typeof mask.linear
      if (d.kind === 'p1') updateMask(mask.id, { linear: { ...mask.linear, x1: nx, y1: ny } })
      else if (d.kind === 'p2') updateMask(mask.id, { linear: { ...mask.linear, x2: nx, y2: ny } })
      else {
        const dx = nx - d.sx
        const dy = ny - d.sy
        updateMask(mask.id, {
          linear: { x1: g.x1 + dx, y1: g.y1 + dy, x2: g.x2 + dx, y2: g.y2 + dy }
        })
      }
    }
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>): void {
    drag.current = null
    endGesture()
    if (rootRef.current?.hasPointerCapture(e.pointerId)) rootRef.current.releasePointerCapture(e.pointerId)
  }

  const pc = (v: number): string => `${v * 100}%`

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-10 touch-none select-none"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
    >
      {mask.kind === 'radial' && mask.radial && (
        <RadialGizmo r={mask.radial} pc={pc} begin={begin} />
      )}
      {mask.kind === 'linear' && mask.linear && (
        <LinearGizmo l={mask.linear} pc={pc} begin={begin} />
      )}
    </div>
  )
}

function Handle({
  x,
  y,
  onDown,
  cursor,
  big
}: {
  x: string
  y: string
  onDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  cursor: string
  big?: boolean
}): JSX.Element {
  const s = big ? 16 : 12
  return (
    <div
      onPointerDown={onDown}
      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-black/50 shadow-[0_0_6px_rgba(0,0,0,0.6)]"
      style={{ left: x, top: y, width: s, height: s, cursor }}
    />
  )
}

function RadialGizmo({
  r,
  pc,
  begin
}: {
  r: { cx: number; cy: number; rx: number; ry: number }
  pc: (v: number) => string
  begin: (k: string) => (e: ReactPointerEvent<HTMLDivElement>) => void
}): JSX.Element {
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        <ellipse
          cx={r.cx * 100}
          cy={r.cy * 100}
          rx={r.rx * 100}
          ry={r.ry * 100}
          fill="rgba(255,45,120,0.10)"
          stroke="#fff"
          strokeOpacity="0.85"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {/* draggable ellipse interior (move) */}
      <div
        onPointerDown={begin('move')}
        className="absolute -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full"
        style={{ left: pc(r.cx), top: pc(r.cy), width: pc(r.rx * 2), height: pc(r.ry * 2) }}
      />
      <Handle x={pc(r.cx)} y={pc(r.cy)} onDown={begin('move')} cursor="move" />
      <Handle x={pc(r.cx + r.rx)} y={pc(r.cy)} onDown={begin('e')} cursor="ew-resize" big />
      <Handle x={pc(r.cx - r.rx)} y={pc(r.cy)} onDown={begin('w')} cursor="ew-resize" big />
      <Handle x={pc(r.cx)} y={pc(r.cy - r.ry)} onDown={begin('n')} cursor="ns-resize" big />
      <Handle x={pc(r.cx)} y={pc(r.cy + r.ry)} onDown={begin('s')} cursor="ns-resize" big />
    </>
  )
}

function LinearGizmo({
  l,
  pc,
  begin
}: {
  l: { x1: number; y1: number; x2: number; y2: number }
  pc: (v: number) => string
  begin: (k: string) => (e: ReactPointerEvent<HTMLDivElement>) => void
}): JSX.Element {
  // Guide lines perpendicular to the gradient direction, through p1 and p2.
  const dx = l.x2 - l.x1
  const dy = l.y2 - l.y1
  const len = Math.hypot(dx, dy) || 1
  const px = -dy / len
  const py = dx / len
  const G = 0.5 // guide half-length in view units
  const line = (ax: number, ay: number, bx: number, by: number, op: number): JSX.Element => (
    <line x1={ax * 100} y1={ay * 100} x2={bx * 100} y2={by * 100} stroke="#fff" strokeOpacity={op} strokeWidth="1" vectorEffect="non-scaling-stroke" />
  )
  const mx = (l.x1 + l.x2) / 2
  const my = (l.y1 + l.y2) / 2
  return (
    <>
      <svg className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
        {line(l.x1 - px * G, l.y1 - py * G, l.x1 + px * G, l.y1 + py * G, 0.85)}
        {line(l.x2 - px * G, l.y2 - py * G, l.x2 + px * G, l.y2 + py * G, 0.45)}
        {line(l.x1, l.y1, l.x2, l.y2, 0.55)}
      </svg>
      <div
        onPointerDown={begin('move')}
        className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full"
        style={{ left: pc(mx), top: pc(my) }}
      />
      <Handle x={pc(l.x1)} y={pc(l.y1)} onDown={begin('p1')} cursor="move" big />
      <Handle x={pc(l.x2)} y={pc(l.y2)} onDown={begin('p2')} cursor="move" big />
    </>
  )
}
