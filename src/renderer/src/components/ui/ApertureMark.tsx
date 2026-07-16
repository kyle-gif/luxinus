// A precise aperture-blade mark drawn as thin strokes — a real optical motif,
// not a gradient blob. Pink is used only as the hairline stroke.
export function ApertureMark({ size = 18 }: { size?: number }): JSX.Element {
  const c = 12
  const r = 9
  // Six blade chords rotated around the circle.
  const blades = Array.from({ length: 6 }, (_, i) => {
    const a0 = (i * 60 * Math.PI) / 180
    const a1 = ((i * 60 + 60) * Math.PI) / 180
    const x0 = c + r * Math.cos(a0)
    const y0 = c + r * Math.sin(a0)
    const x1 = c + r * Math.cos(a1)
    const y1 = c + r * Math.sin(a1)
    return `M ${c} ${c} L ${x0.toFixed(2)} ${y0.toFixed(2)} L ${x1.toFixed(2)} ${y1.toFixed(2)}`
  })
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx={c} cy={c} r={r} stroke="var(--lx-hairline-strong)" strokeWidth="1" />
      {blades.map((d, i) => (
        <path
          key={i}
          d={d}
          stroke={i === 0 ? 'var(--lx-accent)' : 'rgba(255,255,255,0.16)'}
          strokeWidth="0.75"
          strokeLinejoin="round"
        />
      ))}
      <circle cx={c} cy={c} r="2.4" stroke="var(--lx-accent)" strokeWidth="1" />
    </svg>
  )
}
