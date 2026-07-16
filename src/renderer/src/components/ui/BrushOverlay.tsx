import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'

// Painting surface for the selected brush mask. Captures pointer strokes into
// normalized 0..1 view-space points (throttled by distance); the shader bakes
// them into the coverage texture live. Shows the painted coverage tinted plus a
// brush-size cursor.

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function BrushOverlay(): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const id = useStore((s) => s.selectedMaskId)
  const mask = useStore((s) => s.edit.masks.find((m) => m.id === id) ?? null)
  const start = useStore((s) => s.startBrushStroke)
  const extend = useStore((s) => s.extendBrushStroke)
  const radius = useStore((s) => s.brushRadius)
  const erase = useStore((s) => s.brushErase)

  const [size, setSize] = useState({ w: 1, h: 1 })
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const painting = useRef(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize({ w: r.width, h: r.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!mask || mask.kind !== 'brush' || !mask.brush) return null
  const maskId = mask.id

  function toNorm(e: ReactPointerEvent): { x: number; y: number } {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: clamp((e.clientX - r.left) / r.width, 0, 1), y: clamp((e.clientY - r.top) / r.height, 0, 1) }
  }
  function onDown(e: ReactPointerEvent<HTMLDivElement>): void {
    painting.current = true
    rootRef.current?.setPointerCapture(e.pointerId)
    const p = toNorm(e)
    start(maskId, p)
    last.current = p
    setCursor(p)
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>): void {
    const p = toNorm(e)
    setCursor(p)
    if (!painting.current) return
    const l = last.current
    if (l && Math.hypot(p.x - l.x, p.y - l.y) < radius * 0.28) return
    extend(maskId, p)
    last.current = p
  }
  function onUp(e: ReactPointerEvent<HTMLDivElement>): void {
    painting.current = false
    rootRef.current?.releasePointerCapture?.(e.pointerId)
  }

  const tint = erase ? 'rgba(90,170,255,0.55)' : 'rgba(255,45,120,0.5)'

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 z-10 cursor-none touch-none select-none"
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerLeave={() => setCursor(null)}
    >
      {/* painted coverage visualization */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {mask.brush.strokes.map((s, i) => (
          <polyline
            key={i}
            points={s.points.map((p) => `${p.x * size.w},${p.y * size.h}`).join(' ')}
            fill="none"
            stroke={s.erase ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0.14)'}
            strokeWidth={s.radius * size.w * 2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
      {/* brush-size cursor */}
      {cursor && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border"
          style={{
            left: cursor.x * size.w,
            top: cursor.y * size.h,
            width: radius * size.w * 2,
            height: radius * size.w * 2,
            borderColor: tint,
            background: `${tint.replace(/[\d.]+\)$/, '0.12)')}`
          }}
        />
      )}
    </div>
  )
}
