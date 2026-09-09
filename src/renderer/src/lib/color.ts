// Oklab conversion (CPU side) — used by the color-range mask so "similar color"
// is measured perceptually, not in raw RGB. Mirrors the GLSL srgb2oklab in the
// edit shader; keep the two in sync.

export function srgbToOklab(r255: number, g255: number, b255: number): [number, number, number] {
  // Approximate linearization (gamma 2.2), matching the shader.
  const r = Math.pow(Math.max(r255, 0) / 255, 2.2)
  const g = Math.pow(Math.max(g255, 0) / 255, 2.2)
  const b = Math.pow(Math.max(b255, 0) / 255, 2.2)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}
