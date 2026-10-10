import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { RestorationCacheStore } from '../src/main/restoration-cache-store'
import { restoreCachedPreview } from '../src/main/restoration-cache'
import { authorizeLibraryFolder, authorizeLibraryPhotos } from '../src/main/file-policy'
import { contentHash } from '../src/main/safe-file'

const MODEL = 'synthetic-model:' + 'a'.repeat(64) + ':v1'
async function fixture() {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'luxinus-restoration-cache-test-')))
  const source = join(dir, 'original.jpg')
  await fs.writeFile(source, 'synthetic original bytes')
  const root = await authorizeLibraryFolder(dir)
  await authorizeLibraryPhotos(root, [{ filePath: source }])
  const cacheDir = join(dir, 'app-cache')
  const cache = new RestorationCacheStore(cacheDir)
  const stat = await fs.stat(source)
  const input = { requestId: 'request-cache-test', filePath: source, sourceMtimeMs: stat.mtimeMs, sourceSize: stat.size, width: 2, height: 1, rgba: new Uint8Array([1, 2, 3, 255, 4, 5, 6, 255]) }
  const output = new Uint8Array([9, 8, 7, 255, 6, 5, 4, 255])
  let generation = 0, calls = 0
  const runtime = { fingerprint: async () => MODEL, generation: () => generation, infer: async () => { calls++; return { ok: true, rgba: output, width: 2, height: 1, modelFingerprint: MODEL } } }
  return { dir, source, cacheDir, cache, input, output, runtime, cancel: () => { generation++ }, calls: () => calls, cleanup: () => fs.rm(dir, { recursive: true, force: true }) }
}

test('a completed restoration is stored losslessly and a new cache instance reuses it without inference', async () => {
  const f = await fixture()
  try {
    const original = contentHash(await fs.readFile(f.source))
    const first = await restoreCachedPreview(f.cache, f.input, f.runtime)
    assert.equal(first.ok, true); assert.equal(first.cache?.status, 'stored'); assert.equal(f.calls(), 1)
    const second = await restoreCachedPreview(new RestorationCacheStore(f.cacheDir), f.input, f.runtime)
    assert.equal(second.cache?.status, 'hit'); assert.equal(f.calls(), 1)
    assert.deepEqual(second.rgba, f.output)
    assert.equal(contentHash(await fs.readFile(f.source)), original)
    assert.match((await fs.readdir(f.cacheDir))[0], /^[a-f0-9]{64}\.rgba$/)
  } finally { await f.cleanup() }
})

test('model, source identity, input dimensions and input pixels all invalidate cache reuse', async () => {
  const f = await fixture()
  try {
    const ticket = await f.cache.prepare(f.input, MODEL)
    await f.cache.write(ticket, f.output)
    assert.equal(await f.cache.read(await f.cache.prepare(f.input, MODEL.replace(/:v1$/, ':v2'))), null)
    assert.equal(await f.cache.read(await f.cache.prepare({ ...f.input, width: 1, height: 2 }, MODEL)), null)
    assert.equal(await f.cache.read(await f.cache.prepare({ ...f.input, rgba: new Uint8Array([2, 2, 3, 255, 4, 5, 6, 255]) }, MODEL)), null)
    await fs.writeFile(f.source, 'changed source content')
    await assert.rejects(f.cache.read(ticket), /원본 파일이 변경/)
    await assert.rejects(f.cache.prepare(f.input, MODEL), /미리보기를 만든 시점/)
    const stat = await fs.stat(f.source)
    assert.equal(await f.cache.read(await f.cache.prepare({ ...f.input, sourceMtimeMs: stat.mtimeMs, sourceSize: stat.size }, MODEL)), null)
  } finally { await f.cleanup() }
})

test('sub-millisecond source times remain exact and a same-size change within one millisecond is rejected', async () => {
  const f = await fixture()
  try {
    await fs.utimes(f.source, 1700000000.1231, 1700000000.1231)
    const first = await fs.stat(f.source)
    assert.notEqual(first.mtimeMs, Math.round(first.mtimeMs))
    const input = { ...f.input, sourceMtimeMs: first.mtimeMs }
    assert.equal((await restoreCachedPreview(f.cache, input, f.runtime)).cache?.status, 'stored')
    await assert.rejects(f.cache.prepare({ ...input, sourceMtimeMs: Math.round(first.mtimeMs) }, MODEL), /미리보기를 만든 시점/)
    await fs.utimes(f.source, 1700000000.1233, 1700000000.1233)
    const second = await fs.stat(f.source)
    assert.notEqual(second.mtimeMs, first.mtimeMs)
    assert.equal(Math.round(second.mtimeMs), Math.round(first.mtimeMs))
    await assert.rejects(f.cache.prepare(input, MODEL), /미리보기를 만든 시점/)
    assert.equal(await f.cache.read(await f.cache.prepare({ ...input, sourceMtimeMs: second.mtimeMs }, MODEL)), null)
  } finally { await f.cleanup() }
})

test('corrupt cached pixels are detected, recomputed and atomically repaired', async () => {
  const f = await fixture()
  try {
    await restoreCachedPreview(f.cache, f.input, f.runtime)
    const file = join(f.cacheDir, (await fs.readdir(f.cacheDir))[0])
    const corrupted = await fs.readFile(file); corrupted[corrupted.length - 2] ^= 255
    await fs.writeFile(file, corrupted)
    const result = await restoreCachedPreview(f.cache, f.input, f.runtime)
    assert.equal(result.cache?.status, 'stored'); assert.equal(f.calls(), 2)
    assert.match(result.cache?.message ?? '', /새 복원 결과/)
    assert.deepEqual(await f.cache.read(await f.cache.prepare(f.input, MODEL)), f.output)
  } finally { await f.cleanup() }
})

test('cancellation or a changed source during inference never stores or displays stale pixels', async () => {
  for (const reason of ['cancel', 'source'] as const) {
    const f = await fixture()
    try {
      const result = await restoreCachedPreview(f.cache, f.input, { ...f.runtime, infer: async () => {
        if (reason === 'cancel') f.cancel(); else await fs.writeFile(f.source, 'new original bytes')
        return { ok: true, rgba: f.output, width: 2, height: 1, modelFingerprint: MODEL }
      } })
      assert.equal(result.ok, false); assert.equal(result.rgba, undefined)
      assert.equal((await fs.readdir(f.cacheDir)).length, 0)
    } finally { await f.cleanup() }
  }
})

test('cache errors leave computed pixels explicitly unsaved and never follow a cache symlink', async () => {
  const f = await fixture()
  try {
    const foreign = join(f.dir, 'foreign'); await fs.mkdir(foreign)
    await fs.symlink(foreign, f.cacheDir)
    const result = await restoreCachedPreview(f.cache, f.input, f.runtime)
    assert.equal(result.ok, true); assert.equal(result.cache?.status, 'error')
    assert.match(result.cache?.message ?? '', /저장하지 못했습니다/)
    assert.deepEqual(result.rgba, f.output)
    assert.equal((await fs.readdir(foreign)).length, 0)
    const outside = join(f.dir, 'not-authorized.jpg'); await fs.writeFile(outside, 'outside')
    assert.equal((await restoreCachedPreview(f.cache, { ...f.input, filePath: outside }, f.runtime)).ok, false)
  } finally { await f.cleanup() }
})

test('incorrect worker model fingerprints and dimensions cannot be persisted', async () => {
  const f = await fixture()
  try {
    const result = await restoreCachedPreview(f.cache, f.input, { ...f.runtime, infer: async () => ({ ok: true, rgba: f.output, width: 2, height: 1, modelFingerprint: MODEL + '-different' }) })
    assert.equal(result.ok, false); assert.equal((await fs.readdir(f.cacheDir)).length, 0)
    await assert.rejects(f.cache.prepare({ ...f.input, width: 1601 }, MODEL), /1600/)
    await assert.rejects(f.cache.prepare({ ...f.input, filePath: join(f.dir, '..', 'original.jpg') }, MODEL))
  } finally { await f.cleanup() }
})
