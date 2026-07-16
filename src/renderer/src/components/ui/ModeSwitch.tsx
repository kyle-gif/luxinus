import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../store/useStore'

const BTN_W = 74
const PAD = 3

// Animated Simple/Expert switch: a neon glass pill slides between the two
// positions and stretches toward its target as it travels (a liquid morph),
// then settles with a springy overshoot.
export function ModeSwitch(): JSX.Element {
  const mode = useStore((s) => s.mode)
  const setMode = useStore((s) => s.setMode)
  const isExpert = mode === 'expert'

  const [stretch, setStretch] = useState(false)
  const prev = useRef(mode)
  useEffect(() => {
    if (prev.current === mode) return
    prev.current = mode
    setStretch(true)
    const t = setTimeout(() => setStretch(false), 280)
    return () => clearTimeout(t)
  }, [mode])

  return (
    <div
      className="lx-no-drag relative inline-flex rounded-full border border-glass bg-black/30"
      style={{ padding: PAD }}
    >
      {/* Sliding neon pill. Stretches from its leading edge while moving. */}
      <div
        className="lx-switch-pill absolute inset-y-[3px]"
        style={{
          left: isExpert ? `calc(50% + ${PAD / 2}px)` : PAD,
          width: `calc(50% - ${PAD * 1.5}px)`,
          transform: stretch ? 'scaleX(1.22)' : 'scaleX(1)',
          transformOrigin: isExpert ? 'left center' : 'right center'
        }}
        data-stretch={stretch}
      />
      {(['simple', 'expert'] as const).map((m) => (
        <button
          key={m}
          onClick={() => setMode(m)}
          aria-pressed={mode === m}
          className={`relative z-10 rounded-full py-1 text-[11px] font-medium capitalize tracking-wide transition-colors duration-300 ${
            mode === m ? 'text-white' : 'text-muted hover:text-ink'
          }`}
          style={{ width: BTN_W }}
        >
          {m}
        </button>
      ))}
    </div>
  )
}
