import { useId, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent } from 'react'

// Named gradient tracks for colour controls — the track itself communicates what
// the slider does (Lightroom-style), which is far more legible than a bare groove.
const GRADIENTS: Record<string, string> = {
  temp: 'linear-gradient(90deg, #3d7fd6 0%, #6b7a86 46%, #e7a53a 100%)',
  tint: 'linear-gradient(90deg, #4fb86a 0%, #7a8280 46%, #d24fb0 100%)',
  sat: 'linear-gradient(90deg, #6b6b72 0%, #b6b6be 46%, #ff4f8f 100%)',
  hue: 'linear-gradient(90deg, #e5484d, #e8873a, #e6c22e, #3fb46a, #2fb8c0, #3b74e0, #7b52d6, #c94db0, #e5484d)'
}

interface SliderProps {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  size?: 'md' | 'lg'
  /** Named gradient track ('temp' | 'tint' | 'sat' | 'hue') for colour controls. */
  gradient?: keyof typeof GRADIENTS
  onChange: (value: number) => void
  /** Fires when a drag begins (true) / ends (false) — e.g. to show a guide overlay. */
  onDragChange?: (dragging: boolean) => void
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

// Custom liquid slider (not a native range): a recessed glass groove, a liquid
// pink fill, and a precise flat marker that squishes while you drag it. Pointer-
// driven for a real-time, tactile feel; fully keyboard-accessible. Colour controls
// carry a gradient track so their function reads at a glance.
export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  size = 'md',
  gradient,
  onChange,
  onDragChange
}: SliderProps): JSX.Element {
  const id = useId()
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)

  const pct = ((value - min) / (max - min)) * 100
  // Bipolar sliders fill from the center; unipolar from the left.
  const originPct = min < 0 ? ((0 - min) / (max - min)) * 100 : 0
  const fillLeft = Math.min(pct, originPct)
  const fillWidth = Math.abs(pct - originPct)
  const big = size === 'lg'
  const active = value !== 0

  function valueFromClientX(clientX: number): number {
    const el = trackRef.current
    if (!el) return value
    const rect = el.getBoundingClientRect()
    const t = clamp((clientX - rect.left) / rect.width, 0, 1)
    const raw = min + t * (max - min)
    return clamp(Math.round(raw / step) * step, min, max)
  }

  function onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    onDragChange?.(true)
    onChange(valueFromClientX(e.clientX))
  }
  function onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (dragging) onChange(valueFromClientX(e.clientX))
  }
  function onPointerUp(e: ReactPointerEvent<HTMLDivElement>): void {
    setDragging(false)
    onDragChange?.(false)
    e.currentTarget.releasePointerCapture?.(e.pointerId)
  }
  function onDoubleClick(): void {
    // Double-click resets to the neutral origin — a standard develop affordance.
    onChange(min < 0 ? 0 : min)
  }
  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    let next = value
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = value - step
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = value + step
    else if (e.key === 'PageDown') next = value - step * 10
    else if (e.key === 'PageUp') next = value + step * 10
    else if (e.key === 'Home') next = min
    else if (e.key === 'End') next = max
    else return
    e.preventDefault()
    onChange(clamp(next, min, max))
  }

  const disp = value > 0 ? `+${value}` : String(value)

  return (
    <div className="w-full">
      <div className="mb-1.5 flex items-baseline justify-between">
        <label
          htmlFor={id}
          className={big ? 'text-[13px] text-ink' : 'text-[11.5px] font-medium tracking-wide text-muted'}
        >
          {label}
        </label>
        <span
          className={`lx-num tabular-nums transition-colors ${big ? 'text-[13px]' : 'text-[11px]'} ${
            active ? 'text-accent-soft' : 'text-faint'
          }`}
        >
          {disp}
        </span>
      </div>

      <div
        ref={trackRef}
        id={id}
        role="slider"
        tabIndex={0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={label}
        data-drag={dragging}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
        className="lx-slider group relative flex cursor-pointer touch-none items-center"
        style={{ height: big ? 24 : 20 }}
      >
        {/* value bubble */}
        <div
          className="lx-bubble lx-num pointer-events-none absolute -top-7 z-20 rounded-md border border-accent/40 bg-black/85 px-1.5 py-0.5 text-[10px] text-accent-soft shadow-[0_2px_8px_rgba(0,0,0,0.5)]"
          style={{ left: `${pct}%` }}
        >
          {disp}
        </div>

        {gradient ? (
          /* Colour control: the track is a muted gradient that says what it does. */
          <div
            className={`absolute inset-x-0 overflow-hidden rounded-full ${big ? 'h-[6px]' : 'h-[5px]'}`}
            style={{
              backgroundImage: GRADIENTS[gradient],
              boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.35), inset 0 1px 2px rgba(0,0,0,0.4)',
              opacity: 0.82
            }}
          />
        ) : (
          <>
            {/* groove */}
            <div className={`lx-groove absolute inset-x-0 rounded-full ${big ? 'h-[4px]' : 'h-[3px]'}`} />
            {/* solid pink fill */}
            <div
              className={`lx-fill absolute rounded-full ${big ? 'h-[4px]' : 'h-[3px]'}`}
              style={{ left: `${fillLeft}%`, width: `${fillWidth}%` }}
            />
          </>
        )}

        {/* center detent for bipolar sliders */}
        {min < 0 && (
          <div
            className="pointer-events-none absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-white/25"
            style={{ left: `${originPct}%` }}
          />
        )}

        {/* precise flat marker handle */}
        <div className="lx-thumb pointer-events-none absolute top-1/2" style={{ left: `${pct}%` }}>
          {gradient ? (
            <div className="lx-thumb-knob" style={{ width: big ? 15 : 13, height: big ? 15 : 13 }} />
          ) : (
            <div className="lx-thumb-bead" style={{ width: 3, height: big ? 20 : 16 }} />
          )}
        </div>
      </div>
    </div>
  )
}
