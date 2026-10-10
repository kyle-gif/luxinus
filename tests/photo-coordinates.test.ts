import { test } from 'node:test'
import assert from 'node:assert/strict'
import { viewToSource } from '../src/renderer/src/lib/photoCoordinates'
import { defaultEditState } from '../src/shared/edits'
const neutral = defaultEditState()
function near(actual: { x: number; y: number }, expected: { x: number; y: number }): void {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-10, `x: ${actual.x} vs ${expected.x}`)
  assert.ok(Math.abs(actual.y - expected.y) < 1e-10, `y: ${actual.y} vs ${expected.y}`)
}

test('picker reads original top-left coordinates without vertical inversion', () => {
  near(viewToSource({ x: 0, y: 0 }, neutral, 1.5), { x: 0, y: 0 })
  near(viewToSource({ x: .25, y: .8 }, neutral, 1.5), { x: .25, y: .8 })
})
test('picker crop and both flips map to the same source patch', () => {
  const edit = { ...neutral, crop: { x: .1, y: .2, w: .6, h: .5 }, flipH: true, flipV: true }
  near(viewToSource({ x: .25, y: .8 }, edit, 1.5), { x: .75, y: .4 })
})
test('square source positive and negative quarter turns use inverse sample rotation', () => {
  near(viewToSource({ x: .75, y: .5 }, { ...neutral, rotate: 90 }, 1), { x: .5, y: .25 })
  near(viewToSource({ x: .75, y: .5 }, { ...neutral, rotate: -90 }, 1), { x: .5, y: .75 })
})
test('rotation accounts for source aspect and cover scale', () => {
  near(viewToSource({ x: .625, y: .5 }, { ...neutral, rotate: 90 }, 2), { x: .5, y: 0 })
  near(viewToSource({ x: .5, y: .625 }, { ...neutral, rotate: 90 }, .5), { x: 1, y: .5 })
})
test('crop happens before rotation, flips happen afterwards', () => {
  near(viewToSource({ x: .5, y: .5 }, { ...neutral, crop: { x: .5, y: 0, w: .5, h: 1 }, rotate: 90, flipV: true }, 1), { x: .5, y: .75 })
})
test('source edge sampling clamps and invalid image geometry is rejected', () => {
  near(viewToSource({ x: -1, y: 2 }, neutral, 1), { x: 0, y: 1 })
  assert.throws(() => viewToSource({ x: .5, y: .5 }, neutral, 0))
  assert.throws(() => viewToSource({ x: NaN, y: .5 }, neutral, 1))
})

test('supported 45-degree straighten uses cover scaling on a landscape source', () => {
  near(viewToSource({ x: .75, y: .5 }, { ...neutral, rotate: 45 }, 2), { x: 2 / 3, y: 1 / 6 })
})
