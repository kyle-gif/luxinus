import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SaveQueue } from '../src/renderer/src/lib/saveQueue'

test('autosave serializes rapid edits and flush persists the latest value', async () => {
  const writes: number[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const queue = new SaveQueue<number>(async (_path, value) => { writes.push(value); if (value === 1) await gate; return true }, () => {}, 60000)
  queue.schedule('photo', 1)
  const flush = queue.flush()
  await Promise.resolve()
  queue.schedule('photo', 2)
  release()
  assert.equal(await flush, true)
  assert.deepEqual(writes, [1, 2])
  assert.equal(queue.dirty, false)
})

test('failed save retains exact value, reports error, and retries explicitly', async () => {
  let failing = true
  const statuses: string[] = []
  const queue = new SaveQueue<number>(async () => { if (failing) throw new Error('disk full'); return true }, (state, error) => statuses.push(`${state}:${error}`), 60000)
  queue.schedule('사진.jpg', 31)
  assert.equal(await queue.flush(), false)
  assert.equal(queue.get('사진.jpg'), 31)
  assert.equal(queue.dirty, true)
  assert.ok(statuses.some((s) => s.includes('disk full')))
  failing = false
  assert.equal(await queue.flush(), true)
  assert.equal(queue.dirty, false)
})

test('one photo failure does not mark all saves successful or block other photos', async () => {
  const saved: string[] = []
  const queue = new SaveQueue<number>(async (path) => { if (path === 'bad') return false; saved.push(path); return true }, () => {}, 60000)
  queue.schedule('bad', 1)
  queue.schedule('good', 2)
  assert.equal(await queue.flush(), false)
  assert.deepEqual(saved, ['good'])
  assert.equal(queue.get('bad'), 1)
  assert.equal(queue.get('good'), undefined)
})
