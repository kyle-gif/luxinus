import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import { sanitizeAgentCapture } from '../src/main/agent-capture-image'

test('photo screenshots preserve dimensions and pixels while removing private metadata', async () => {
  const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#db521d' } }).jpeg().withMetadata({ exif: { IFD0: { Artist: 'private-fixture-author' } } }).toBuffer()
  const result = await sanitizeAgentCapture({ dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: 64, height: 48 })
  const image = sharp(Buffer.from(result.dataUrl.split(',')[1], 'base64'))
  const meta = await image.metadata(), stats = await image.stats()
  assert.equal(meta.width, 64); assert.equal(meta.height, 48)
  assert.equal(meta.exif, undefined); assert.equal(meta.icc, undefined); assert.equal(meta.xmp, undefined)
  assert.ok(stats.channels[0].mean > 210 && stats.channels[1].mean < 90 && stats.channels[2].mean < 40)
})

test('photo screenshot broker rejects remote input, false dimensions, malformed and oversized images', async () => {
  await assert.rejects(sanitizeAgentCapture({ dataUrl: 'https://example.invalid/a.jpg', width: 64, height: 48 }), /형식/)
  await assert.rejects(sanitizeAgentCapture({ dataUrl: 'data:image/jpeg;base64,Zm9v', width: 2048, height: 48 }), /형식/)
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).jpeg().toBuffer()
  await assert.rejects(sanitizeAgentCapture({ dataUrl: `data:image/jpeg;base64,${bytes.toString('base64')}`, width: 8, height: 9 }), /실제 크기/)
  await assert.rejects(sanitizeAgentCapture({ dataUrl: 'data:image/jpeg;base64,AAAA', width: 1, height: 1 }))
})
