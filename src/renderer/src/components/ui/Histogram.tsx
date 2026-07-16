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
  const channels = hist
    ? [
        { key: 'r', color: '#ff5a7a', data: hist.r },
        { key: 'g', color: '#5ce0a6', data: hist.g },
        { key: 'b', color: '#6aa8ff', data: hist.b }
      ]
    : []

  // Normalize to the tallest bin, but ignore the pure-black/white end bins which
  // often spike from large flat areas and would flatten everything else.
  let max = 1
  let total = 1
  for (const c of channels) {
    for (let i = 1; i < c.data.length - 1; i++) if (c.data[i] > max) max = c.data[i]
    for (const v of c.data) total += v
  }
  // Clipping: pixels piled in the darkest / brightest bin (per-channel).
  const bins = hist ? hist.r.length : 64
  const clipLow = hist ? (hist.r[0] + hist.g[0] + hist.b[0]) / total : 0
  const clipHigh = hist ? (hist.r[bins - 1] + hist.g[bins - 1] + hist.b[bins - 1]) / total : 0
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
          <path key={c.key} d={areaPath(c.data, max)} fill={c.color} fillOpacity={0.3} />
        ))}
        {channels.map((c) => (
          <path
            key={c.key + 's'}
            d={areaPath(c.data, max)}
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
      <span className="lx-eyebrow absolute bottom-1 left-2">rgb</span>
      {/* clipping indicators — shadows (top-left) / highlights (top-right) */}
      <span
        title="Shadow clipping"
        className={`absolute left-1.5 top-1.5 h-0 w-0 border-y-[3px] border-r-4 border-y-transparent transition-colors ${clipColor(clipLow)}`}
        style={{ borderRightColor: 'currentColor' }}
      />
      <span
        title="Highlight clipping"
        className={`absolute right-1.5 top-1.5 h-0 w-0 border-y-[3px] border-l-4 border-y-transparent transition-colors ${clipColor(clipHigh)}`}
        style={{ borderLeftColor: 'currentColor' }}
      />
      {!hist && (
        <span className="lx-num absolute inset-0 flex items-center justify-center text-[9px] text-faint">
          waiting for image…
        </span>
      )}
    </div>
  )
}
