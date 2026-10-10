import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { PortraitService } from '../src/main/portrait-service'
import { authorizeLibraryFolder, authorizeLibraryPhotos } from '../src/main/file-policy'
import { contentHash } from '../src/main/safe-file'
import type { PortraitInferenceResult } from '../src/shared/portrait'

const MODEL = 'portrait-test:' + 'a'.repeat(64)
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'luxinus-portrait-service-'))), source = join(dir, 'original.jpg')
  await fs.writeFile(source, 'synthetic original')
  const folder = await authorizeLibraryFolder(dir); await authorizeLibraryPhotos(folder, [{ filePath: source }])
  const stat = await fs.stat(source)
  const input = { requestId: 'portrait-test-request', filePath: source, sourceMtimeMs: stat.mtimeMs, sourceSize: stat.size, rgba: new Uint8Array(4 * 3 * 4).fill(120), width: 4, height: 3 }
  const result: PortraitInferenceResult = { ok: true, width: 4, height: 3, modelFingerprint: MODEL, facesDetected: 1, warnings: [], regions: [{ region: 'face', coverage: new Uint8Array(12).fill(255), bounds: { x: 0, y: 0, width: 1, height: 1 } }] }
  let calls = 0, cancellations = 0, generation = 0
  const runtime = { fingerprint: async () => MODEL, generation: () => generation, infer: async () => { calls++; return result }, cancel: () => { cancellations++; generation++ } }
  return { dir, source, input, result, runtime, calls: () => calls, cancellations: () => cancellations, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('authorized analysis wraps lossless source coverage without writing original or sidecar', async () => {
  const f = await fixture()
  try {
    const original = contentHash(await fs.readFile(f.source)), service = new PortraitService(f.runtime)
    const result = await service.analyze(7, f.input)
    assert.equal(result.ok, true); assert.equal(result.facesDetected, 1); assert.equal(result.regions?.[0].label, '얼굴')
    assert.equal(result.regions?.[0].coverageFraction, 1)
    assert.equal(result.regions?.[0].semantic.source.pathHash, contentHash(f.source))
    assert.equal(result.regions?.[0].semantic.inputHash, contentHash(Buffer.from(f.input.rgba)))
    assert.equal(contentHash(await fs.readFile(f.source)), original)
    assert.deepEqual(await fs.readdir(f.dir), ['original.jpg'])
    const jpeg = await sharp({ create: { width: 4, height: 3, channels: 3, background: '#778899' } }).jpeg().toBuffer()
    const { rgba: _rgba, width: _width, height: _height, ...identity } = f.input
    assert.equal((await service.analyze(7, { ...identity, dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` })).ok, true)
  } finally { await f.cleanup() }
})

test('owner-scoped cancellation during fingerprint preparation prevents model dispatch and allows a later job', async () => {
  const f = await fixture()
  try {
    let release!: () => void, entered!: () => void
    const waiting = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
    let block = true
    const service = new PortraitService({ ...f.runtime, fingerprint: async () => { if (block) { entered(); await waiting }; return MODEL } })
    const pending = service.analyze(7, f.input); await started
    assert.equal(await service.cancel(8, f.input.requestId), false)
    assert.equal(await service.cancel(7, 'wrong-request-id'), false)
    assert.equal((await service.analyze(7, { ...f.input, requestId: 'second-request-id' })).ok, false)
    assert.equal(await service.cancel(7, f.input.requestId), true)
    release(); assert.match((await pending).message ?? '', /취소/)
    assert.equal(f.calls(), 0); assert.equal(f.cancellations(), 1); assert.equal(service.isBusy(), false)
    block = false
    assert.equal((await service.analyze(7, f.input)).ok, true); assert.equal(f.calls(), 1)
  } finally { await f.cleanup() }
})

test('source changes, invalid output and unavailable regions never produce invented masks', async () => {
  const f = await fixture()
  try {
    for (const result of [{ ...f.result, modelFingerprint: 'wrong' }, { ...f.result, width: 513 }, { ...f.result, regions: [f.result.regions![0], f.result.regions![0]] }, { ...f.result, regions: [{ ...f.result.regions![0], coverage: new Uint8Array(1) }] }]) {
      assert.equal((await new PortraitService({ ...f.runtime, infer: async () => result }).analyze(7, f.input)).ok, false)
    }
    const empty = await new PortraitService({ ...f.runtime, infer: async () => ({ ...f.result, regions: [{ ...f.result.regions![0], coverage: new Uint8Array(12) }], facesDetected: 0 }) }).analyze(7, f.input)
    assert.equal(empty.ok, true); assert.deepEqual(empty.regions, []); assert.equal(empty.facesDetected, 0)
    assert.equal((await new PortraitService(f.runtime).analyze(7, { ...f.input, regions: ['eyes'] })).ok, false)
    const changed = await new PortraitService({ ...f.runtime, infer: async () => { await fs.writeFile(f.source, 'source changed'); return f.result } }).analyze(7, f.input)
    assert.equal(changed.ok, false); assert.equal(changed.regions, undefined); assert.match(changed.message ?? '', /원본 사진이 변경/)
  } finally { await f.cleanup() }
})
