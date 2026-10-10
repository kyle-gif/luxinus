import type { PortraitBounds } from '../shared/portrait'

export interface PixelRect { x: number; y: number; width: number; height: number }
export interface FaceBox extends PixelRect { score: number }
export function squareFrame(width: number, height: number): PixelRect {
  const size = Math.max(width, height)
  return { x: (width - size) / 2, y: (height - size) / 2, width: size, height: size }
}
export function faceFrame(face: FaceBox): PixelRect {
  const size = Math.max(face.width, face.height) * 1.6
  return { x: face.x + face.width / 2 - size / 2, y: face.y + face.height / 2 - size / 2, width: size, height: size }
}

/** Pixel-centre bilinear sampling. Outside the source is black, not stretched. */
export function sampleChannel(rgba: Uint8Array, width: number, height: number, x: number, y: number, channel: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), dx = x - x0, dy = y - y0
  const read = (sx: number, sy: number): number => sx < 0 || sx >= width || sy < 0 || sy >= height ? 0 : rgba[(sy * width + sx) * 4 + channel]
  return read(x0, y0) * (1 - dx) * (1 - dy) + read(x0 + 1, y0) * dx * (1 - dy) + read(x0, y0 + 1) * (1 - dx) * dy + read(x0 + 1, y0 + 1) * dx * dy
}
export function portraitTensor(rgba: Uint8Array, width: number, height: number, size: number, frame: PixelRect, channels: readonly number[], mean: readonly number[], std: readonly number[], scale = 1 / 255): Float32Array {
  const result = new Float32Array(size * size * 3)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const sx = frame.x + (x + .5) / size * frame.width - .5
    const sy = frame.y + (y + .5) / size * frame.height - .5
    for (let c = 0; c < 3; c++) result[c * size * size + y * size + x] = (sampleChannel(rgba, width, height, sx, sy, channels[c]) * scale - mean[c]) / std[c]
  }
  return result
}

export function classify(logits: Float32Array, classes: number, width: number, height: number): { labels: Uint8Array; confidence: Uint8Array } {
  const plane = width * height
  if (logits.length !== plane * classes || classes < 2 || classes > 255) throw new Error('인물 모델 출력 크기가 올바르지 않습니다.')
  const labels = new Uint8Array(plane), confidence = new Uint8Array(plane)
  for (let i = 0; i < plane; i++) {
    let best = -Infinity, label = 0
    for (let c = 0; c < classes; c++) {
      const value = logits[c * plane + i]
      if (!Number.isFinite(value)) throw new Error('인물 모델이 유효하지 않은 값을 반환했습니다.')
      if (value > best) { best = value; label = c }
    }
    let sum = 0
    for (let c = 0; c < classes; c++) sum += Math.exp(logits[c * plane + i] - best)
    labels[i] = label; confidence[i] = Math.round(255 / sum)
  }
  return { labels, confidence }
}

export function sourceToModel(x: number, y: number, width: number, height: number, outputWidth: number, outputHeight: number, frame: PixelRect, modelWidth: number, modelHeight: number): number {
  const sx = (x + .5) / outputWidth * width, sy = (y + .5) / outputHeight * height
  const mx = Math.floor((sx - frame.x) / frame.width * modelWidth), my = Math.floor((sy - frame.y) / frame.height * modelHeight)
  return mx < 0 || my < 0 || mx >= modelWidth || my >= modelHeight ? -1 : my * modelWidth + mx
}

function intersectionOverUnion(a: FaceBox, b: FaceBox): number {
  const intersection = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return intersection / (a.width * a.height + b.width * b.height - intersection)
}
/** YuNet's documented grid/stride box decoder; coordinates returned in source pixels. */
export function decodeFaces(outputs: Record<string, Float32Array>, size: number, frame: PixelRect, threshold = .85): FaceBox[] {
  const candidates: FaceBox[] = []
  for (const stride of [8, 16, 32]) {
    const cols = size / stride, cls = outputs[`cls_${stride}`], obj = outputs[`obj_${stride}`], boxes = outputs[`bbox_${stride}`]
    if (!cls || !obj || !boxes || cls.length !== cols * cols || obj.length !== cls.length || boxes.length !== cls.length * 4) throw new Error('얼굴 검출 모델 출력 규격이 올바르지 않습니다.')
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.max(0, Math.min(1, cls[i])) * Math.max(0, Math.min(1, obj[i])))
      if (!Number.isFinite(score) || score < threshold) continue
      const cx = (i % cols + boxes[i * 4]) * stride, cy = (Math.floor(i / cols) + boxes[i * 4 + 1]) * stride
      const width = Math.exp(boxes[i * 4 + 2]) * stride, height = Math.exp(boxes[i * 4 + 3]) * stride
      if (![cx, cy, width, height].every(Number.isFinite) || width <= 0 || height <= 0 || width > size * 2 || height > size * 2) continue
      candidates.push({ x: frame.x + (cx - width / 2) / size * frame.width, y: frame.y + (cy - height / 2) / size * frame.height, width: width / size * frame.width, height: height / size * frame.height, score })
    }
  }
  const selected: FaceBox[] = []
  for (const face of candidates.sort((a, b) => b.score - a.score)) if (selected.every(other => intersectionOverUnion(face, other) < .3)) selected.push(face)
  return selected
}

export function coverageBounds(coverage: Uint8Array, width: number, height: number): PortraitBounds | null {
  let left = width, top = height, right = -1, bottom = -1
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (coverage[y * width + x]) {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y)
  }
  return right < 0 ? null : { x: left / width, y: top / height, width: (right - left + 1) / width, height: (bottom - top + 1) / height }
}
