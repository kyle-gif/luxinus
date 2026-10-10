import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'
import { IDENTITY_CURVE, type CurveChannel, type CurvePoint } from '../../../../shared/edits'
import { useEditGesture } from '../../lib/useEditGesture'

const SIZE = 200
const CHANNELS: { key: CurveChannel; label: string; color: string }[] = [
  { key: 'rgb', label: 'RGB', color: '#f2eef4' },
  { key: 'r', label: 'R', color: '#ff5a7a' },
  { key: 'g', label: 'G', color: '#5ce0a6' },
  { key: 'b', label: 'B', color: '#6aa8ff' }
]

// Draggable tone-curve editor. Click the curve to add a point, drag points to
// shape it, drag a point far off the panel to delete it. Endpoints move only
// vertically. Writes to the store; the WebGL renderer rebuilds its LUT live.
export function ToneCurve(): JSX.Element {
  const [channel, setChannel] = useState<CurveChannel>('rgb')
  const curve = useStore((s) => s.edit.curves[channel])
  const setCurve = useStore((s) => s.setCurve)
  const svgRef = useRef<SVGSVGElement>(null)
  const dragIdx = useRef<number | null>(null)
  const gesture = useEditGesture()

  const active = CHANNELS.find((c) => c.key === channel)!
  const pts = [...curve].sort((a, b) => a.x - b.x)

  function toLocal(e: { clientX: number; clientY: number }): CurvePoint {
    const r = svgRef.current!.getBoundingClientRect()
    return {
      x: clamp01((e.clientX - r.left) / r.width),
      y: clamp01(1 - (e.clientY - r.top) / r.height)
    }
  }

  function commit(next: CurvePoint[]): void {
    setCurve(channel, next.sort((a, b) => a.x - b.x))
  }

  function onBgDown(e: ReactPointerEvent<SVGSVGElement>): void {
    const p = toLocal(e)
    // Add a point where clicked (unless very close to an existing one).
    if (pts.some((q) => Math.abs(q.x - p.x) < 0.03)) return
    if (!gesture.begin()) return
    const next = [...pts, p]
    commit(next)
    dragIdx.current = next.sort((a, b) => a.x - b.x).findIndex((q) => q.x === p.x && q.y === p.y)
    ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
  }

  function onPointDown(i: number, e: ReactPointerEvent): void {
    e.stopPropagation()
    if (!gesture.begin()) return
    dragIdx.current = i
    ;(e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  }

  function onMove(e: ReactPointerEvent): void {
    const i = dragIdx.current
    if (i === null || !gesture.isActive()) return
    const p = toLocal(e)
    const isEnd = i === 0 || i === pts.length - 1
    const r = svgRef.current!.getBoundingClientRect()
    const outside = e.clientY < r.top - 40 || e.clientY > r.bottom + 40
    if (!isEnd && outside && pts.length > 2) {
      commit(pts.filter((_, idx) => idx !== i))
      dragIdx.current = null
      gesture.end()
      return
    }
    const next = pts.map((q, idx) => {
      if (idx !== i) return q
      // Endpoints keep their x (0 or 1); inner points clamp between neighbors.
      if (isEnd) return { x: q.x, y: p.y }
      const lo = pts[idx - 1].x + 0.02
      const hi = pts[idx + 1].x - 0.02
      return { x: Math.min(hi, Math.max(lo, p.x)), y: p.y }
    })
    commit(next)
  }

  function onUp(): void {
    dragIdx.current = null
    gesture.end()
  }

  // Sampled polyline for the drawn curve (monotone via the shared LUT math).
  const path = curvePath(pts)
  const edited = pts.length !== 2 || pts[0].y !== 0 || pts[1].y !== 1

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          {CHANNELS.map((c) => (
            <button
              key={c.key}
              onClick={() => setChannel(c.key)}
              className={`h-5 w-6 rounded text-[12px] font-medium transition-colors ${
                channel === c.key ? 'bg-white/10' : 'text-muted hover:text-ink'
              }`}
              style={{ color: channel === c.key ? c.color : undefined }}
            >
              {c.label}
            </button>
          ))}
        </div>
        {edited && (
          <button
            onClick={() => commit([...IDENTITY_CURVE])}
            className="text-[12px] text-muted hover:text-accent-soft"
          >
            초기화
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="lx-groove aspect-square w-full touch-none rounded-[7px]"
        onPointerDown={onBgDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onLostPointerCapture={onUp}
        aria-label="톤 커브, 클릭해 제어점 추가"
      >
        {/* grid */}
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1">
            <line x1={g * SIZE} y1="0" x2={g * SIZE} y2={SIZE} />
            <line x1="0" y1={g * SIZE} x2={SIZE} y2={g * SIZE} />
          </g>
        ))}
        <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
        {/* curve */}
        <path d={path} fill="none" stroke={active.color} strokeWidth="1.6" />
        {/* points */}
        {pts.map((p, i) => (
          <circle
            key={i}
            cx={p.x * SIZE}
            cy={(1 - p.y) * SIZE}
            r="4.5"
            fill="#0b0b0e"
            stroke={active.color}
            strokeWidth="1.6"
            className="cursor-grab"
            onPointerDown={(e) => onPointDown(i, e)}
            tabIndex={0} role="slider" aria-label={`${active.label} 커브 제어점 ${i + 1}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(p.y * 100)}
            onKeyDown={(e) => {
              if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'].includes(e.key)) return
              e.preventDefault(); e.stopPropagation()
              if (e.key === 'Delete' || e.key === 'Backspace') { if (i > 0 && i < pts.length - 1) commit(pts.filter((_, n) => n !== i)); return }
              const amount = e.shiftKey ? .001 : .01
              const x = i === 0 || i === pts.length - 1 ? p.x : Math.min(pts[i + 1].x - .02, Math.max(pts[i - 1].x + .02, p.x + (e.key === 'ArrowRight' ? amount : e.key === 'ArrowLeft' ? -amount : 0)))
              const y = clamp01(p.y + (e.key === 'ArrowUp' ? amount : e.key === 'ArrowDown' ? -amount : 0))
              commit(pts.map((point, n) => n === i ? { x, y } : point))
            }}
          />
        ))}
      </svg>
    </div>
  )
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// A smooth path through the points (sampled from a simple monotone interpolation
// for display; the shader LUT uses the same shared math).
function curvePath(pts: CurvePoint[]): string {
  const sorted = [...pts].sort((a, b) => a.x - b.x)
  const n = 48
  let d = ''
  for (let i = 0; i <= n; i++) {
    const x = i / n
    const y = sampleLinearSmooth(sorted, x)
    d += `${i === 0 ? 'M' : 'L'} ${(x * SIZE).toFixed(1)} ${((1 - y) * SIZE).toFixed(1)}`
  }
  return d
}

// Lightweight Catmull-Rom-ish sampler just for the visual line.
function sampleLinearSmooth(pts: CurvePoint[], x: number): number {
  if (x <= pts[0].x) return pts[0].y
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].y
  let i = 0
  while (i < pts.length - 1 && x > pts[i + 1].x) i++
  const p0 = pts[Math.max(0, i - 1)]
  const p1 = pts[i]
  const p2 = pts[i + 1]
  const p3 = pts[Math.min(pts.length - 1, i + 2)]
  const t = (x - p1.x) / (p2.x - p1.x)
  const t2 = t * t
  const t3 = t2 * t
  const y =
    0.5 *
    (2 * p1.y +
      (-p0.y + p2.y) * t +
      (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
      (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
  return clamp01(y)
}
