import test from 'node:test'
import assert from 'node:assert/strict'
import { workerReadiness } from '../src/main/worker-readiness'

test('canceling startup rejects immediately and its old timeout cannot terminate a new launch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let firstKilled = 0, secondKilled = 0
  const first = workerReadiness(15_000, () => { firstKilled++ })
  const failure = assert.rejects(first.ready, /취소/)
  first.settle(new Error('취소'))
  await failure
  const second = workerReadiness(15_000, () => { secondKilled++ })
  second.settle()
  await second.ready
  t.mock.timers.tick(30_000)
  assert.equal(firstKilled, 0)
  assert.equal(secondKilled, 0)
})

test('startup timeout rejects the waiting request and kills only its captured process once', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let killed = 0
  const startup = workerReadiness(15_000, () => { killed++ })
  const failure = assert.rejects(startup.ready, /제한 시간/)
  t.mock.timers.tick(15_000)
  await failure
  startup.settle()
  t.mock.timers.tick(30_000)
  assert.equal(killed, 1)
})

test('a ready process or early exit clears the startup timer and ignores duplicate messages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let killed = 0
  const success = workerReadiness(15_000, () => { killed++ })
  success.settle(); success.settle(new Error('late exit'))
  await success.ready
  const exited = workerReadiness(15_000, () => { killed++ })
  const failure = assert.rejects(exited.ready, /early exit/)
  exited.settle(new Error('early exit')); exited.settle()
  await failure
  t.mock.timers.tick(30_000)
  assert.equal(killed, 0)
})
