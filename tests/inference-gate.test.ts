import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireHeavyInference } from '../src/main/inference-gate'

test('heavy CNN jobs exclude one another in either start order', () => {
  for (const first of ['portrait', 'restoration'] as const) {
    const release = acquireHeavyInference(first)
    assert.ok(release)
    assert.equal(acquireHeavyInference('portrait'), null)
    assert.equal(acquireHeavyInference('restoration'), null)
    release()
  }
})

test('stale and repeated release never unlocks a later inference', () => {
  const old = acquireHeavyInference('portrait')!
  old()
  const next = acquireHeavyInference('restoration')!
  old(); old()
  assert.equal(acquireHeavyInference('portrait'), null)
  next()
  const final = acquireHeavyInference('portrait')
  assert.ok(final); final()
})

test('finally releases the gate after asynchronous failure and permits retry', async () => {
  const release = acquireHeavyInference('restoration')!
  await assert.rejects((async () => {
    try { await Promise.resolve(); throw new Error('Canceled') }
    finally { release() }
  })())
  const next = acquireHeavyInference('portrait')
  assert.ok(next); next()
})
