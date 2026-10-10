import test from 'node:test'
import assert from 'node:assert/strict'
import { runTiled, rgbaToPlanar, planarToRgba } from '../src/workers/lib/tiledInference'
import { RESTORATION_MODEL, RESTORATION_MODEL_FINGERPRINT, RESTORATION_SESSION_OPTIONS } from '../src/shared/ai'

test('reflect padding and overlapping last tiles preserve pixels across seams', async () => {
  for (const [width, height] of [[1, 1], [3, 2], [13, 11], [19, 5]]) {
    const input = Float32Array.from({ length: width * height * 3 }, (_, i) => Math.sin(i * .23) * .3 + .5)
    const progress: number[] = []
    const output = await runTiled(input, width, height, async (tile) => new Float32Array(tile), { tile: 8, overlap: 3, onProgress: p => progress.push(p) })
    for (let i = 0; i < input.length; i++) assert.ok(Math.abs(input[i] - output[i]) < 2e-7, `pixel ${i}`)
    assert.equal(progress.at(-1), 1)
    assert.ok(progress.every((p, i) => i === 0 || p > progress[i - 1]))
  }
})

test('blend strength preserves original alpha and clamps out-of-range model pixels', () => {
  const input = new Uint8Array([10, 20, 30, 43, 150, 160, 170, 222])
  assert.deepEqual(planarToRgba(rgbaToPlanar(input, 2, 1), input, 2, 1, 1), input)
  const prediction = new Float32Array([-2, 2, 0, 0, 1, 1])
  assert.deepEqual(planarToRgba(prediction, input, 2, 1, 0), input)
  assert.deepEqual(planarToRgba(prediction, input, 2, 1, .6), new Uint8Array([4, 8, 165, 43, 213, 64, 221, 222]))
})

test('invalid dimensions, overlap and truncated model output fail explicitly', async () => {
  await assert.rejects(runTiled(new Float32Array(3), 0, 1, async a => a, { tile: 8, overlap: 2 }), /dimensions/)
  await assert.rejects(runTiled(new Float32Array(3), 1, 1, async a => a, { tile: 8, overlap: 8 }), /overlap/)
  await assert.rejects(runTiled(new Float32Array(3), 1, 1, async () => new Float32Array(1), { tile: 8, overlap: 2 }), /output dimensions/)
})

test('official SIDD runner has the required static input and distinct cache identity', () => {
  assert.equal(RESTORATION_MODEL.tile, 768)
  assert.equal(RESTORATION_MODEL.input, 'input')
  assert.match(RESTORATION_MODEL_FINGERPRINT, /^nafnet-sidd-width32:[a-f0-9]{64}:rgb-reflect-cosine32-v1$/)
  // Enabling either pool regressed first/second inference in the Electron probe.
  assert.equal(RESTORATION_SESSION_OPTIONS.enableCpuMemArena, false)
  assert.equal(RESTORATION_SESSION_OPTIONS.enableMemPattern, false)
})
