import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'
import { COLOR_GRADE_REGIONS, type ColorGradeRegionKey } from '../../types'
import { Slider } from './Slider'

// 3-way color grading — a Lightroom-style wheel per tonal region (shadows,
// midtones, highlights) plus a global wheel. Drag the puck: angle = hue,
// distance from center = saturation. A luminance slider and the Blending /
// Balance controls sit below. Hot pink stays a signal (the active tab, the ring
// hairline) — the wheel's own hues carry the color.

const REGION_LABEL: Record<ColorGradeRegionKey, string> = {
  shadows: '어두운 부분',
  midtones: '중간 밝기',
  highlights: '밝은 부분',
  global: '전체'
}

// hue (0..360) + sat (0..1) → a display swatch color.
function swatch(hue: number, sat: number): string {
  return `hsl(${hue}, ${Math.round(sat * 90)}%, 55%)`
}

export function ColorGradePanel(): JSX.Element {
  const [region, setRegion] = useState<ColorGradeRegionKey>('midtones')
  const grade = useStore((s) => s.edit.colorGrade)
  const setColorGrade = useStore((s) => s.setColorGrade)
  const setParam = useStore((s) => s.setColorGradeParam)
  const r = grade[region]

  return (
    <div className="space-y-3.5">
      {/* Region tabs — active tab wears the pink hairline. */}
      <div className="grid grid-cols-4 gap-1">
        {COLOR_GRADE_REGIONS.map((k) => {
          const g = grade[k]
          const active = k === region
          return (
            <button
              key={k}
              onClick={() => setRegion(k)}
              className={`relative flex flex-col items-center gap-1 rounded-control border py-1.5 text-[12px] transition-colors ${
                active ? 'border-accent/60 bg-accent/[0.07] text-accent-soft' : 'border-glass text-muted hover:text-ink'
              }`}
            >
              <span
                className="h-2.5 w-2.5 rounded-full border border-white/25"
                style={{ background: g.sat > 0.5 ? swatch(g.hue, g.sat / 100) : 'transparent' }}
              />
              {REGION_LABEL[k]}
            </button>
          )
        })}
      </div>

      <div className="flex items-center gap-3">
        <ColorWheel
          hue={r.hue}
          sat={r.sat}
          onChange={(hue, sat) => setColorGrade(region, { hue, sat })}
        />
        <div className="flex-1 space-y-2">
          <div className="flex items-center justify-between">
            <span className="lx-eyebrow">{REGION_LABEL[region]}</span>
            {(r.sat !== 0 || r.lum !== 0) && (
              <button
                onClick={() => setColorGrade(region, { hue: 0, sat: 0, lum: 0 })}
                className="text-[12px] text-faint transition-colors hover:text-accent-soft"
              >
                초기화
              </button>
            )}
          </div>
          <div className="lx-num flex justify-between text-[12px] text-muted">
            <span>H {Math.round(r.hue)}°</span>
            <span>S {Math.round(r.sat)}</span>
          </div>
          <Slider label="밝기" value={r.lum} onChange={(v) => setColorGrade(region, { lum: v })} />
        </div>
      </div>

      <div className="space-y-3 border-t border-glass pt-3">
        <Slider label="혼합" min={0} max={100} value={grade.blending} onChange={(v) => setParam({ blending: v })} />
        <Slider label="균형" value={grade.balance} onChange={(v) => setParam({ balance: v })} />
      </div>
    </div>
  )
}

const WHEEL = 96 // px

function ColorWheel({
  hue,
  sat,
  onChange
}: {
  hue: number
  sat: number
  onChange: (hue: number, sat: number) => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  function fromEvent(clientX: number, clientY: number): void {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = clientX - cx
    const dy = clientY - cy
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI
    if (deg < 0) deg += 360
    const dist = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2))
    onChange(Math.round(deg), Math.round(dist * 100))
  }
  function down(e: ReactPointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    useStore.getState().setSuppressMaskOverlay(true)
    fromEvent(e.clientX, e.clientY)
  }
  function move(e: ReactPointerEvent<HTMLDivElement>): void {
    if (dragging) fromEvent(e.clientX, e.clientY)
  }
  function up(e: ReactPointerEvent<HTMLDivElement>): void {
    setDragging(false)
    useStore.getState().setSuppressMaskOverlay(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }

  // Puck position from hue/sat, in the wheel's local px space.
  const rad = (hue * Math.PI) / 180
  const dist = (sat / 100) * (WHEEL / 2)
  const px = WHEEL / 2 + Math.cos(rad) * dist
  const py = WHEEL / 2 + Math.sin(rad) * dist

  return (
    <div
      ref={ref}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onDoubleClick={() => onChange(0, 0)}
      className="relative shrink-0 cursor-pointer touch-none rounded-full"
      style={{
        width: WHEEL,
        height: WHEEL,
        background:
          'radial-gradient(circle at center, #fff 0%, rgba(255,255,255,0.15) 32%, transparent 58%), conic-gradient(from 90deg, hsl(0,85%,55%), hsl(60,85%,55%), hsl(120,85%,55%), hsl(180,85%,55%), hsl(240,85%,55%), hsl(300,85%,55%), hsl(360,85%,55%))',
        boxShadow: 'inset 0 0 0 1px var(--lx-hairline-strong), inset 0 2px 8px rgba(0,0,0,0.5)'
      }}
    >
      {/* center detent */}
      <span className="pointer-events-none absolute left-1/2 top-1/2 h-1 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/40" />
      {/* puck */}
      <span
        className="pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_1px_5px_rgba(0,0,0,0.7)]"
        style={{
          left: px,
          top: py,
          background: sat > 2 ? swatch(hue, sat / 100) : 'rgba(255,255,255,0.85)',
          transform: `translate(-50%,-50%) scale(${dragging ? 1.25 : 1})`,
          transition: dragging ? 'none' : 'transform 0.25s var(--lx-spring)'
        }}
      />
    </div>
  )
}
