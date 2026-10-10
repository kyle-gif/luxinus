import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { AgentAttachments } from '../src/main/agent-attachments'

test('attachments strip metadata, resize within 1536px, and expose no native paths', async () => {
  const source = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#44aacc' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'synthetic-private-metadata' } } }).toBuffer()
  const store = new AgentAttachments()
  const image = await store.prepare(4, source, '/private/photos/reference.jpg')
  assert.equal(image.width, 1536); assert.equal(image.height, 1152)
  assert.equal(image.name, 'reference.jpg')
  assert.doesNotMatch(JSON.stringify(image), /\/private\/photos/)
  const meta = await sharp(Buffer.from(image.previewDataUrl.split(',')[1], 'base64')).metadata()
  assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined); assert.equal(meta.xmp, undefined)
  assert.deepEqual(store.resolve(4, [image.id]), [image.previewDataUrl])
  assert.throws(() => store.resolve(5, [image.id]), /다른 창/)
  assert.doesNotMatch(store.describe(4, [image.id]), /reference.jpg/)
})
test('attachment IDs expire, release by owner only, and bound source/input formats', async () => {
  let now = 1000
  const store = new AgentAttachments(() => now)
  const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#abcdef' } }).jpeg().toBuffer()
  const first = await store.prepareDataUrl(1, { dataUrl: `data:image/jpeg;base64,${source.toString('base64')}`, name: '현재 사진 · 보정 반영' })
  assert.match(store.describe(1, [first.id]), /현재 편집 사진의 보정 반영 축소본/)
  store.release(2, [first.id]); assert.equal(store.resolve(1, [first.id]).length, 1)
  assert.throws(() => store.resolve(1, [first.id, first.id]), /최대 4개/)
  now += 600_001
  assert.throws(() => store.resolve(1, [first.id]), /만료/)
  const second = await store.prepare(1, source, 'test.jpg')
  store.release(1, [second.id]); assert.throws(() => store.resolve(1, [second.id]))
  await assert.rejects(store.prepare(1, Buffer.alloc(16 * 1024 * 1024 + 1), 'large'), /16MB/)
  await assert.rejects(store.prepareDataUrl(1, { dataUrl: 'https://example.test/image.jpg', name: 'remote' }), /형식/)
  await assert.rejects(store.prepare(1, Buffer.from('<svg width="10" height="10"></svg>'), 'vector.svg'))
  store.clear()
})
