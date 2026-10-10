import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FIT_VIEW, MAX_ZOOM, MIN_ZOOM, containPhoto, wheelDelta, wheelView, zoomAt, type ViewportWheel } from '../src/renderer/src/lib/viewport'

const page = { width: 840, height: 620 }
const event = (patch: Partial<ViewportWheel> = {}): ViewportWheel => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...patch })
function near(actual: number, expected: number): void { assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`) }

test('ordinary two-axis wheel pans without scaling, including at Fit', () => {
  assert.deepEqual(wheelView(FIT_VIEW, event({ deltaX: 31, deltaY: -47 }), { x: 170, y: -85 }, page), { z: 1, x: -31, y: 47 })
  assert.deepEqual(wheelView({ z: 2, x: 30, y: 90 }, event({ deltaX: -5, deltaY: 12 }), { x: 0, y: 0 }, page), { z: 2, x: 35, y: 78 })
})
test('Shift-wheel handles vertical and already-remapped horizontal devices once', () => {
  assert.deepEqual(wheelDelta(event({ shiftKey: true, deltaY: 40 }), page), { x: 40, y: 0 })
  assert.deepEqual(wheelDelta(event({ shiftKey: true, deltaX: 40 }), page), { x: 40, y: 0 })
  assert.deepEqual(wheelDelta(event({ shiftKey: true, deltaX: 40, deltaY: 40 }), page), { x: 40, y: 0 })
})
test('line and page wheel units normalize both dimensions to CSS pixels', () => {
  assert.deepEqual(wheelDelta(event({ deltaMode: 1, deltaX: 2, deltaY: -3 }), page), { x: 32, y: -48 })
  assert.deepEqual(wheelDelta(event({ deltaMode: 2, deltaX: .5, deltaY: -1 }), page), { x: 420, y: -620 })
})
test('macOS Command-wheel and Windows Control-wheel/pinch share the cursor anchor', () => {
  const initial = { z: .8, x: -35, y: 82 }, anchor = { x: 205, y: -143 }
  const mac = wheelView(initial, event({ deltaY: -60, metaKey: true }), anchor, page)
  const windows = wheelView(initial, event({ deltaY: -60, ctrlKey: true }), anchor, page)
  assert.deepEqual(mac, windows)
  assert.ok(mac.z > initial.z)
  near((anchor.x - initial.x) / initial.z, (anchor.x - mac.x) / mac.z)
  near((anchor.y - initial.y) / initial.z, (anchor.y - mac.y) / mac.z)
})
test('zooming below Fit keeps the cursor anchored instead of snapping to the centre', () => {
  const initial = { z: 1.2, x: 45, y: -70 }, anchor = { x: 210, y: 160 }
  const smaller = zoomAt(initial, .4, anchor)
  near((anchor.x - initial.x) / initial.z, (anchor.x - smaller.x) / smaller.z)
  near((anchor.y - initial.y) / initial.z, (anchor.y - smaller.y) / smaller.z)
  assert.notEqual(smaller.x, 0)
})
test('zoom bounds use the clamped scale for anchoring and repeated limit events do not drift', () => {
  const anchor = { x: 131, y: -62 }, start = { z: 2, x: -42, y: 33 }
  for (const requested of [0, 1000]) {
    const clamped = zoomAt(start, requested, anchor)
    assert.equal(clamped.z, requested === 0 ? MIN_ZOOM : MAX_ZOOM)
    near((anchor.x - start.x) / start.z, (anchor.x - clamped.x) / clamped.z)
    assert.deepEqual(zoomAt(clamped, requested, anchor), clamped)
  }
})
test('invalid input cannot poison the viewport transform', () => {
  assert.deepEqual(wheelView(FIT_VIEW, event({ deltaY: NaN }), { x: 0, y: 0 }, page), FIT_VIEW)
  assert.deepEqual(zoomAt(FIT_VIEW, Infinity, { x: 0, y: 0 }), FIT_VIEW)
  assert.deepEqual(zoomAt(FIT_VIEW, 2, { x: NaN, y: 0 }), FIT_VIEW)
})
test('AI comparison contains landscape and cropped portrait without distorting either', () => {
  assert.deepEqual(containPhoto({ width: 800, height: 600 }, 2), { width: 800, height: 400 })
  assert.deepEqual(containPhoto({ width: 800, height: 600 }, .5), { width: 300, height: 600 })
})
