// Pure, reusable tiled inference for the NAFNet restoration model. Kept free of
// onnxruntime imports so it can be unit-tested and shared: the caller passes a
// `run(tileFloat, size) => Promise<Float32Array>` that executes one square tile.
//
// The model was exported with a channel-attention pooling that only accepts
// spatial sizes ≥ 384 (256/128 fail), so tiles are a FIXED square size from a
// safe ladder; edge tiles are reflect-padded up to the full tile and cropped
// back. Tiles overlap and blend with a raised-cosine window to hide seams.

export interface TileRunner {
  (input: Float32Array, size: number): Promise<Float32Array> // NCHW RGB in/out, [1,3,size,size]
}

export interface TiledOptions {
  tile: number // square tile size (must be a size the model accepts)
  overlap?: number // px of overlap between tiles (blended)
  onProgress?: (fraction: number) => void
}

// Reflect an index into [0, n).
function reflect(i: number, n: number): number {
  if (n === 1) return 0
  const period = 2 * n - 2
  let m = ((i % period) + period) % period
  if (m >= n) m = period - m
  return m
}

// Raised-cosine weight over an `overlap`-wide band at each edge, 1.0 in the core.
function edgeWeight(pos: number, size: number, overlap: number): number {
  if (overlap <= 0) return 1
  const d = Math.min(pos, size - 1 - pos)
  if (d >= overlap) return 1
  return 0.5 - 0.5 * Math.cos((Math.PI * (d + 0.5)) / overlap)
}

// Tile origins covering [0, total) with the given stride; the last origin is
// clamped so a full tile still fits (or 0 when the image is smaller than a tile).
function origins(total: number, tile: number, stride: number): number[] {
  if (total <= tile) return [0]
  const out: number[] = []
  for (let p = 0; p + tile < total; p += stride) out.push(p)
  out.push(total - tile) // ensure the far edge is covered
  return out
}

// Run the full image through the model tile-by-tile. `src` is planar RGB float
// in [0,1], length W*H*3 (channel-major: [R plane][G plane][B plane]). Returns
// the restored planar RGB float, same layout.
export async function runTiled(
  src: Float32Array,
  W: number,
  H: number,
  runner: TileRunner,
  opts: TiledOptions
): Promise<Float32Array> {
  const tile = opts.tile
  const overlap = opts.overlap ?? 32
  const stride = Math.max(1, tile - overlap)
  const xs = origins(W, tile, stride)
  const ys = origins(H, tile, stride)

  const out = new Float32Array(W * H * 3)
  const acc = new Float32Array(W * H) // summed blend weights per pixel
  const plane = W * H
  const tileBuf = new Float32Array(3 * tile * tile)
  const total = xs.length * ys.length
  let done = 0

  for (const y0 of ys) {
    for (const x0 of xs) {
      // Gather a reflect-padded tile from the source.
      for (let ty = 0; ty < tile; ty++) {
        const sy = reflect(y0 + ty, H)
        for (let tx = 0; tx < tile; tx++) {
          const sx = reflect(x0 + tx, W)
          const sIdx = sy * W + sx
          const tIdx = ty * tile + tx
          tileBuf[tIdx] = src[sIdx]
          tileBuf[tile * tile + tIdx] = src[plane + sIdx]
          tileBuf[2 * tile * tile + tIdx] = src[2 * plane + sIdx]
        }
      }

      const res = await runner(tileBuf, tile)

      // Accumulate only the in-bounds region, weighted by the feather window.
      const yMax = Math.min(tile, H - y0)
      const xMax = Math.min(tile, W - x0)
      for (let ty = 0; ty < yMax; ty++) {
        const gy = y0 + ty
        const wy = edgeWeight(ty, tile, overlap)
        for (let tx = 0; tx < xMax; tx++) {
          const gx = x0 + tx
          const w = wy * edgeWeight(tx, tile, overlap)
          const g = gy * W + gx
          const t = ty * tile + tx
          out[g] += res[t] * w
          out[plane + g] += res[tile * tile + t] * w
          out[2 * plane + g] += res[2 * tile * tile + t] * w
          acc[g] += w
        }
      }
      done++
      opts.onProgress?.(done / total)
    }
  }

  // Normalize by accumulated weight.
  for (let i = 0; i < plane; i++) {
    const w = acc[i] || 1
    out[i] /= w
    out[plane + i] /= w
    out[2 * plane + i] /= w
  }
  return out
}

// RGBA bytes → planar RGB float [0,1] (drops alpha).
export function rgbaToPlanar(rgba: Uint8Array, W: number, H: number): Float32Array {
  const plane = W * H
  const out = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4] / 255
    out[plane + i] = rgba[i * 4 + 1] / 255
    out[2 * plane + i] = rgba[i * 4 + 2] / 255
  }
  return out
}

// Planar RGB float → RGBA bytes, blending toward the original by `amount` (0..1)
// so the strength slider mixes restored vs original. `origRgba` supplies alpha
// and the un-restored pixels.
export function planarToRgba(
  planar: Float32Array,
  origRgba: Uint8Array,
  W: number,
  H: number,
  amount: number
): Uint8Array {
  const plane = W * H
  const out = new Uint8Array(plane * 4)
  const a = Math.min(1, Math.max(0, amount))
  for (let i = 0; i < plane; i++) {
    for (let c = 0; c < 3; c++) {
      const restored = Math.min(255, Math.max(0, planar[c * plane + i] * 255))
      const orig = origRgba[i * 4 + c]
      out[i * 4 + c] = Math.round(orig * (1 - a) + restored * a)
    }
    out[i * 4 + 3] = origRgba[i * 4 + 3]
  }
  return out
}
