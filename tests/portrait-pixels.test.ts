import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, coverageBounds, decodeFaces, faceFrame, portraitTensor, sampleChannel, sourceToModel, squareFrame } from '../src/workers/portrait-pixels'

test('portrait preprocessing preserves source aspect and original source UV', () => {
  const landscape = squareFrame(800, 400)
  assert.deepEqual(landscape, { x: 0, y: -200, width: 800, height: 800 })
  assert.equal(sourceToModel(0, 0, 800, 400, 400, 200, landscape, 512, 512), 128 * 512)
  assert.equal(sourceToModel(399, 199, 800, 400, 400, 200, landscape, 512, 512), 383 * 512 + 511)
  const portrait = squareFrame(400, 800)
  assert.equal(sourceToModel(0, 0, 400, 800, 200, 400, portrait, 512, 512), 128)
  assert.equal(sourceToModel(199, 399, 400, 800, 200, 400, portrait, 512, 512), 511 * 512 + 383)
  const crop = faceFrame({ x: 100, y: 200, width: 100, height: 100, score: 1 })
  assert.equal(sourceToModel(149, 249, 400, 400, 400, 400, crop, 512, 512), 254 * 512 + 254)
  assert.equal(sourceToModel(0, 0, 400, 400, 400, 400, crop, 512, 512), -1)
})

test('CNN input samples bilinearly, uses black padding and explicit RGB/BGR channels', () => {
  const rgba = Uint8Array.from([10, 20, 30, 255, 30, 40, 50, 255, 50, 60, 70, 255, 70, 80, 90, 255])
  assert.equal(sampleChannel(rgba, 2, 2, .5, .5, 0), 40)
  assert.equal(sampleChannel(rgba, 2, 2, -1, 0, 0), 0)
  const bgr = portraitTensor(rgba, 2, 2, 2, squareFrame(2, 2), [2, 1, 0], [0, 0, 0], [1, 1, 1], 1)
  assert.deepEqual([...bgr], [30, 50, 70, 90, 20, 40, 60, 80, 10, 30, 50, 70])
  const normalized = portraitTensor(rgba, 2, 2, 1, squareFrame(2, 2), [0, 1, 2], [1, 2, 3], [2, 2, 2], 1)
  assert.deepEqual([...normalized], [19.5, 24, 28.5])
})

test('semantic confidence comes from stable softmax of model logits', () => {
  const result = classify(Float32Array.from([1000, -1000, 999, 1000, 998, -1000]), 3, 2, 1)
  assert.deepEqual([...result.labels], [0, 1])
  assert.deepEqual([...result.confidence], [170, 255])
  assert.throws(() => classify(Float32Array.from([NaN, 0]), 2, 1, 1))
  assert.throws(() => classify(new Float32Array(1), 2, 1, 1))
})

test('YuNet boxes decode in source pixels and NMS suppresses only overlapping detections', () => {
  const outputs: Record<string, Float32Array> = {}
  for (const stride of [8, 16, 32]) {
    const plane = (64 / stride) ** 2
    outputs[`cls_${stride}`] = new Float32Array(plane)
    outputs[`obj_${stride}`] = new Float32Array(plane)
    outputs[`bbox_${stride}`] = new Float32Array(plane * 4)
  }
  function box(stride: number, column: number, row: number, score: number, w: number) {
    const i = row * 64 / stride + column
    outputs[`cls_${stride}`][i] = score; outputs[`obj_${stride}`][i] = score
    outputs[`bbox_${stride}`].set([0, 0, Math.log(w / stride), Math.log(w / stride)], i * 4)
  }
  box(8, 2, 2, .99, 16)
  box(16, 1, 1, .9, 16)
  box(8, 6, 6, .95, 8)
  box(8, 0, 0, .2, 8)
  const faces = decodeFaces(outputs, 64, squareFrame(128, 64))
  assert.equal(faces.length, 2)
  assert.ok(Math.abs(faces[0].x - 16) < 1e-5)
  assert.ok(Math.abs(faces[0].y + 16) < 1e-5)
  assert.ok(Math.abs(faces[0].width - 32) < 1e-5)
  assert.equal(faces[1].x, 88)
  assert.equal(faces[1].y, 56)
})

test('coverage bounds include edge pixels and empty maps have no invented bounds', () => {
  const coverage = new Uint8Array(12)
  assert.equal(coverageBounds(coverage, 4, 3), null)
  coverage[1] = 128; coverage[11] = 255
  assert.deepEqual(coverageBounds(coverage, 4, 3), { x: .25, y: 0, width: .75, height: 1 })
})
