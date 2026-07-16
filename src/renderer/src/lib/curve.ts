import type { CurvePoint, ToneCurves } from '../../../shared/edits'

// Monotone cubic (Fritsch–Carlson) interpolation through the sorted control
// points — a smooth tone curve that never overshoots into inversions.
function monotoneSampler(points: CurvePoint[]): (x: number) => number {
  const pts = [...points].sort((a, b) => a.x - b.x)
  const n = pts.length
  if (n < 2) return (x) => x
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)

  const dx: number[] = []
  const dy: number[] = []
  const slope: number[] = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i]
    dy[i] = ys[i + 1] - ys[i]
    slope[i] = dx[i] === 0 ? 0 : dy[i] / dx[i]
  }
  const m: number[] = new Array(n)
  m[0] = slope[0]
  m[n - 1] = slope[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0
    else m[i] = (slope[i - 1] + slope[i]) / 2
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
    } else {
      const a = m[i] / slope[i]
      const b = m[i + 1] / slope[i]
      const h = Math.hypot(a, b)
      if (h > 3) {
        const t = 3 / h
        m[i] = t * a * slope[i]
        m[i + 1] = t * b * slope[i]
      }
    }
  }

  return (x: number): number => {
    if (x <= xs[0]) return clamp01(ys[0] + m[0] * (x - xs[0]))
    if (x >= xs[n - 1]) return clamp01(ys[n - 1] + m[n - 1] * (x - xs[n - 1]))
    let i = 0
    while (i < n - 1 && x > xs[i + 1]) i++
    const h = dx[i]
    const t = (x - xs[i]) / h
    const t2 = t * t
    const t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1
    const h10 = t3 - 2 * t2 + t
    const h01 = -2 * t3 + 3 * t2
    const h11 = t3 - t2
    return clamp01(h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1])
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// Build a 256×1 RGBA LUT: R = composite (rgb) curve, G = red, B = green, A = blue.
// Sampled in the shader to apply the tone curves.
export function buildCurveLut(curves: ToneCurves): Uint8Array {
  const rgb = monotoneSampler(curves.rgb)
  const r = monotoneSampler(curves.r)
  const g = monotoneSampler(curves.g)
  const b = monotoneSampler(curves.b)
  const data = new Uint8Array(256 * 4)
  for (let i = 0; i < 256; i++) {
    const x = i / 255
    data[i * 4] = Math.round(rgb(x) * 255)
    data[i * 4 + 1] = Math.round(r(x) * 255)
    data[i * 4 + 2] = Math.round(g(x) * 255)
    data[i * 4 + 3] = Math.round(b(x) * 255)
  }
  return data
}

// Is a curve non-identity? (skip LUT work when all four are straight)
export function curvesAreIdentity(c: ToneCurves): boolean {
  const flat = (p: CurvePoint[]): boolean =>
    p.length === 2 && p[0].x === 0 && p[0].y === 0 && p[1].x === 1 && p[1].y === 1
  return flat(c.rgb) && flat(c.r) && flat(c.g) && flat(c.b)
}
