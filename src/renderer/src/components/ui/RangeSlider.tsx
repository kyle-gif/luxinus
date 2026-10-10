import { useEditGesture } from '../../lib/useEditGesture'
import { useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react'

// Dual-handle range slider (lo..hi within 0..100) in the house slider style:
// recessed groove, thin pink fill between the handles, flat playhead markers.
// For the luminance-range mask the track is a black→white ramp so the control
// itself reads as "which tones" at a glance.

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export function RangeSlider({
  label,
  lo,
  hi,
  onChange,
  track = 'plain'
}: {
  label: string
  lo: number // 0..100
  hi: number // 0..100
  onChange: (lo: number, hi: number) => void
  track?: 'plain' | 'lum'
}): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  // Which handle a drag (or keyboard focus) is steering.
  const [active, setActive] = useState<'lo' | 'hi' | null>(null)
  const gesture = useEditGesture()

  function valueAt(clientX: number): number {
    const el = trackRef.current
    if (!el) return 0
    const r = el.getBoundingClientRect()
    return clamp(Math.round(((clientX - r.left) / r.width) * 100), 0, 100)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    if (!gesture.begin()) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const v = valueAt(e.clientX)
    // Grab whichever handle is nearer (ties go to lo when below both).
    const which = Math.abs(v - lo) <= Math.abs(v - hi) ? 'lo' : 'hi'
    setActive(which)
    apply(which, v)
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (active && gesture.isActive()) apply(active, valueAt(e.clientX))
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    gesture.end()
    setActive(null)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
  }
  function apply(which: 'lo' | 'hi', v: number): void {
    if (which === 'lo') onChange(Math.min(v, hi), hi)
    else onChange(lo, Math.max(v, lo))
  }
  function keyFor(which: 'lo' | 'hi') {
    return (e: KeyboardEvent<HTMLDivElement>): void => {
      const cur = which === 'lo' ? lo : hi
      let next = cur
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - 1
      else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = 100
      else return
      e.preventDefault()
      e.stopPropagation()
      apply(which, clamp(next, 0, 100))
    }
  }

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between">
        <span className="text-[12px] font-medium tracking-wide text-muted">{label}</span>
        <span className="lx-num text-[12px] text-accent-soft">
          {lo}–{hi}
        </span>
      </div>
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onLostPointerCapture={onPointerUp}
        className="relative flex h-5 cursor-pointer touch-none items-center"
      >
        {track === 'lum' ? (
          <div
            className="absolute inset-x-0 h-[6px] rounded-full"
            style={{
              background: 'linear-gradient(90deg, #000 0%, #7d7d7d 50%, #fff 100%)',
              boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.14), inset 0 1px 2px rgba(0,0,0,0.4)'
            }}
          />
        ) : (
          <div className="lx-groove absolute inset-x-0 h-[3px] rounded-full" />
        )}
        {/* selected span — the pink signal */}
        <div
          className="absolute h-[2px] rounded-full bg-accent"
          style={{ left: `${lo}%`, width: `${hi - lo}%`, bottom: 2 }}
        />
        {(['lo', 'hi'] as const).map((which) => {
          const v = which === 'lo' ? lo : hi
          return (
            <div
              key={which}
              role="slider"
              tabIndex={0}
              aria-label={`${label} ${which === 'lo' ? '하한' : '상한'}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={v}
              onKeyDown={keyFor(which)}
              className="lx-thumb absolute top-1/2 outline-none"
              style={{ left: `${v}%` }}
            >
              <div
                className="lx-thumb-bead"
                style={{
                  width: 3,
                  height: 16,
                  transform: active === which ? 'scaleY(1.22)' : undefined
                }}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
