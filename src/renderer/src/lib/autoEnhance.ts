import { defaultEditState, type EditState, type PhotoMeta } from '../types'

// One-button Auto Enhance: histogram-based auto tone + ISO-based denoise.
//
// The synchronous entry point derives ISO denoise immediately and returns a
// sensible tone baseline; when an image is available, computeAutoEnhance()
// refines exposure/contrast/blacks/whites/shadows from the real luminance
// histogram. Both preserve the user's geometry (crop/rotate/flip).

function isoDenoise(meta: PhotoMeta | null): number {
  const iso = meta?.iso ?? 0
  if (iso <= 0) return 0
  // Gentle ramp: negligible below ISO 800, ~climbing to a firm value by 12800.
  if (iso <= 800) return 0
  const t = Math.min(1, (Math.log2(iso) - Math.log2(800)) / (Math.log2(12800) - Math.log2(800)))
  return Math.round(t * 70)
}

// Synchronous fallback (used when no pixel data is handy): a tasteful default
// auto look plus ISO denoise.
export function autoEnhance(prev: EditState, meta: PhotoMeta | null): EditState {
  const base = defaultEditState()
  return {
    ...base,
    rotate: prev.rotate,
    flipH: prev.flipH,
    flipV: prev.flipV,
    crop: prev.crop,
    exposure: 8,
    contrast: 12,
    highlights: -20,
    shadows: 22,
    whites: 10,
    blacks: -8,
    vibrance: 18,
    denoise: isoDenoise(meta)
  }
}

// Histogram-driven Auto Enhance from the actual (proxy) image. Returns a full
// EditState. Falls back to the synchronous version if the image can't be read.
export async function computeAutoEnhance(
  imageUrl: string,
  prev: EditState,
  meta: PhotoMeta | null
): Promise<EditState> {
  try {
    const hist = await luminanceHistogram(imageUrl)
    const base = defaultEditState()
    const denoise = isoDenoise(meta)

    // Percentile black/white points → normalize the tonal range.
    const black = percentile(hist, 0.005)
    const white = percentile(hist, 0.995)
    const median = percentile(hist, 0.5)

    // Push blacks/whites toward a fuller range, lift/lower exposure to center
    // the median around ~0.45, add mild contrast + vibrance.
    const blacks = clampAdj((-black / 255) * 100 * 1.4)
    const whites = clampAdj(((255 - white) / 255) * 100 * 1.4)
    const exposure = clampAdj((0.46 - median / 255) * 120)
    const shadows = median < 90 ? 20 : 8
    const highlights = white > 245 ? -22 : -8

    return {
      ...base,
      rotate: prev.rotate,
      flipH: prev.flipH,
      flipV: prev.flipV,
      crop: prev.crop,
      exposure,
      contrast: 12,
      highlights,
      shadows,
      whites,
      blacks,
      vibrance: 18,
      denoise
    }
  } catch {
    return autoEnhance(prev, meta)
  }
}

function clampAdj(v: number): number {
  return Math.round(Math.max(-60, Math.min(60, v)))
}

// 256-bin luminance histogram from a downscaled draw of the image.
async function luminanceHistogram(url: string): Promise<Uint32Array> {
  const img = await loadImage(url)
  const w = 160
  const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const hist = new Uint32Array(256)
  for (let i = 0; i < data.length; i += 4) {
    const l = Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])
    hist[l]++
  }
  return hist
}

function percentile(hist: Uint32Array, p: number): number {
  let total = 0
  for (let i = 0; i < 256; i++) total += hist[i]
  const target = total * p
  let acc = 0
  for (let i = 0; i < 256; i++) {
    acc += hist[i]
    if (acc >= target) return i
  }
  return 255
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}
