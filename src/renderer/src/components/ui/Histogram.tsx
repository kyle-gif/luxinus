import { useMemo } from 'react'
import { useStore } from '../../store/useStore'

// Live RGB histogram scope. EditCanvas renders the edited image into a tiny
// offscreen target ~6×/sec and bins the channels into the store; this draws them.
// Channel colours are semantic (R/G/B), not the pink accent.

const W = 100
const H = 40

// Build a filled area path from histogram bins, normalized to `max`, with a mild
// sqrt compression so low counts stay visible next to tall peaks.
function areaPath(data: number[], max: number): string {
  const n = data.length
  const step = W / (n - 1)
  let d = `M 0 ${H}`
  for (let i = 0; i < n; i++) {
    const v = Math.sqrt(Math.min(1, data[i] / max))
    d += ` L ${(i * step).toFixed(1)} ${(H - v * H * 0.96).toFixed(1)}`
  }
  d += ` L ${W} ${H} Z`
  return d
}

export function Histogram(): JSX.Element {
  const hist = useStore((s) => s.histogram)

  // The scope updates ~6×/sec; recompute the paths only when the bins actually
  // change, and build each path once instead of once per fill and once per stroke.
  const { channels, clipLow, clipHigh } = useMemo(() => {
    if (!hist) return { channels: [], clipLow: 0, clipHigh: 0 }
    const raw = [
      { key: 'r', color: '#ff5a7a', data: hist.r },
      { key: 'g', color: '#5ce0a6', data: hist.g },
      { key: 'b', color: '#6aa8ff', data: hist.b }
    ]
    // Normalize to the tallest bin, but ignore the pure-black/white end bins which
    // often spike from large flat areas and would flatten everything else.
    let max = 1
    let total = 1
    for (const c of raw) {
      for (let i = 1; i < c.data.length - 1; i++) if (c.data[i] > max) max = c.data[i]
      for (const v of c.data) total += v
    }
    // Clipping: pixels piled in the darkest / brightest bin (per-channel).
    const bins = hist.r.length
    return {
      channels: raw.map((c) => ({ ...c, d: areaPath(c.data, max) })),
      clipLow: (hist.r[0] + hist.g[0] + hist.b[0]) / total,
      clipHigh: (hist.r[bins - 1] + hist.g[bins - 1] + hist.b[bins - 1]) / total
    }
  }, [hist])

  const clipColor = (v: number): string =>
    v > 0.02 ? 'text-accent-soft' : v > 0.002 ? 'text-muted' : 'text-faint/40'

  return (
    <div className="lx-groove relative h-24 overflow-hidden rounded-[7px]">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="absolute inset-0 h-full w-full"
        style={{ mixBlendMode: 'screen' }}
      >
        {channels.map((c) => (
          <path key={c.key} d={c.d} fill={c.color} fillOpacity={0.3} />
        ))}
        {channels.map((c) => (
          <path
            key={c.key + 's'}
            d={c.d}
            fill="none"
            stroke={c.color}
            strokeWidth={0.6}
            strokeOpacity={0.8}
          />
        ))}
      </svg>
      {/* quarter-tone gridlines */}
      <div className="pointer-events-none absolute inset-0 flex justify-between">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-full w-px bg-white/[0.04]" />
        ))}
      </div>
      {/* Sits over the plot, so it needs its own ground to stay legible. */}
      <span className="lx-eyebrow absolute bottom-1 left-1.5 rounded bg-black/55 px-1 py-px">
        rgb
      </span>
      {/* clipping indicators — shadows (top-left) / highlights (top-right).
          Click either (or press J) to toggle the stage zebra overlays. */}
      <button
        title="검정 클리핑 표시 켜기 / 끄기 (J)"
        onClick={() => useStore.getState().setShowClipping(!useStore.getState().showClipping)}
        className="absolute left-0 top-0 flex h-6 w-6 items-start justify-start p-1.5"
      >
        <span
          className={`h-0 w-0 border-y-[3px] border-r-4 border-y-transparent transition-colors ${clipColor(clipLow)}`}
          style={{ borderRightColor: 'currentColor' }}
        />
      </button>
      <button
        title="흰색 클리핑 표시 켜기 / 끄기 (J)"
        onClick={() => useStore.getState().setShowClipping(!useStore.getState().showClipping)}
        className="absolute right-0 top-0 flex h-6 w-6 items-start justify-end p-1.5"
      >
        <span
          className={`h-0 w-0 border-y-[3px] border-l-4 border-y-transparent transition-colors ${clipColor(clipHigh)}`}
          style={{ borderLeftColor: 'currentColor' }}
        />
      </button>
      {!hist && (
        <span className="lx-num absolute inset-0 flex items-center justify-center text-[12px] text-faint">
          사진을 기다리는 중…
        </span>
      )}
    </div>
  )
}
