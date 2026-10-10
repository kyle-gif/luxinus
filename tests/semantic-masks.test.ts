import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultEditState, zeroMaskAdjust, type Mask } from '../src/shared/edits'
import { validateEditState } from '../src/shared/edit-validation'
import { decodeSemanticCoverage, encodeSemanticCoverage, validateSemanticGeom, type SemanticGeom } from '../src/shared/portrait'
import { applyPreset, captureAsPreset } from '../src/shared/presets'
import { rasterizeSemanticAtlas, semanticAtlasLayout, semanticTextureKey } from '../src/renderer/src/lib/semanticAtlas'
import { maskSlotIndex } from '../src/renderer/src/lib/editShader'
import { authorizeLibraryFolder, authorizeLibraryPhotos } from '../src/main/file-policy'
import { loadEdits, saveEdits, sidecarPath } from '../src/main/sidecar-store'
import { contentHash } from '../src/main/safe-file'

function semantic(width = 4, height = 4, value = 255): SemanticGeom {
  return { version: 1, space: 'source', encoding: 'gray8-base64', width, height, coverage: encodeSemanticCoverage(new Uint8Array(width * height).fill(value)), region: 'face',
    bounds: { x: 0, y: 0, width: 1, height: 1 }, modelFingerprint: 'test-portrait:' + 'a'.repeat(64), inputHash: 'b'.repeat(64),
    source: { pathHash: 'c'.repeat(64), mtimeMs: 1, ctimeMs: 1, size: 1, dev: 1, ino: 1 } }
}
const mask = (id: string, geometry = semantic()): Mask => ({ id, name: id, kind: 'semantic', enabled: true, semantic: geometry, adjust: zeroMaskAdjust() })

test('full 512px coverage and sixteen durable masks validate losslessly without regexp stack overflow', () => {
  const geometry = semantic(512, 512, 173)
  assert.equal(geometry.coverage.length, 349528)
  validateSemanticGeom(geometry)
  assert.deepEqual(decodeSemanticCoverage(geometry), new Uint8Array(512 * 512).fill(173))
  const edits = { ...defaultEditState(), masks: Array.from({ length: 16 }, (_, i) => mask(String(i), geometry)) }
  assert.equal(validateEditState(JSON.parse(JSON.stringify(edits))).masks.length, 16)
  assert.throws(() => validateEditState({ ...edits, masks: [...edits.masks, mask('17')] }), /최대 16/)
  for (const patch of [{ coverage: geometry.coverage.slice(4) }, { coverage: '?'.repeat(geometry.coverage.length) }, { width: 513 }, { space: 'view' }, { encoding: 'url' }, { region: 'unknown' }]) {
    assert.throws(() => validateSemanticGeom({ ...geometry, ...patch }))
  }
  assert.throws(() => decodeSemanticCoverage({ width: 1, height: 1, coverage: '/x==' }), /길이/)
})

test('semantic atlas isolates eight distinct coverage maps alongside an existing brush', () => {
  const masks = Array.from({ length: 8 }, (_, i) => mask(String(i), semantic(4, 3, 20 + i * 20)))
  const brush: Mask = { id: 'brush', name: 'brush', kind: 'brush', enabled: true, adjust: zeroMaskAdjust(), brush: { strokes: [] } }
  const edits = { ...defaultEditState(), masks: [...masks, brush] }
  const atlas = rasterizeSemanticAtlas(edits), layout = semanticAtlasLayout(edits)
  assert.equal(layout.tiles.length, 8); assert.equal(maskSlotIndex(edits, 'brush'), 8)
  for (const [i, tile] of layout.tiles.entries()) {
    assert.equal(maskSlotIndex(edits, tile.mask.id), i)
    assert.equal(atlas.data[tile.y * atlas.width + tile.x], 20 + i * 20)
    assert.equal(atlas.data[tile.y * atlas.width + tile.x - 1], 0)
    assert.equal(atlas.data[(tile.y - 1) * atlas.width + tile.x], 0)
  }
  const key = semanticTextureKey(edits)
  assert.equal(semanticTextureKey({ ...edits, rotate: 40, flipH: true, crop: { x: .2, y: .1, w: .6, h: .7 }, exposure: 10 }), key)
  assert.notEqual(semanticTextureKey({ ...edits, masks: [...masks].reverse() }), key)
  masks[0].semantic = semantic(4, 3, 15)
  assert.notEqual(semanticTextureKey(edits), key)
})

test('preset capture excludes source coverage and application preserves only destination semantic masks', () => {
  const foreign = mask('foreign'), destination = mask('destination')
  const presetEdit = { ...defaultEditState(), exposure: 30, masks: [foreign] }
  assert.deepEqual(captureAsPreset(presetEdit).masks, [])
  const next = applyPreset({ ...defaultEditState(), masks: [destination] }, { id: 'preset', name: 'look', edits: presetEdit, origin: 'native', createdAt: '' })
  assert.equal(next.exposure, 30); assert.deepEqual(next.masks, [destination])
})

test('semantic sidecar survives reload without a model and rejects another or replaced source', async () => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'luxinus-semantic-sidecar-')))
  try {
    const first = join(dir, 'one.jpg'), other = join(dir, 'two.jpg')
    await fs.writeFile(first, 'synthetic original'); await fs.writeFile(other, 'synthetic original')
    const root = await authorizeLibraryFolder(dir); await authorizeLibraryPhotos(root, [{ filePath: first }, { filePath: other }])
    const stat = await fs.stat(first), geometry = semantic(512, 512, 147)
    geometry.source = { pathHash: contentHash(first), mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, dev: stat.dev, ino: stat.ino }
    const edits = { ...defaultEditState(), masks: Array.from({ length: 16 }, (_, i) => mask(String(i), geometry)) }
    const original = contentHash(await fs.readFile(first))
    await saveEdits(first, edits, null)
    assert.ok((await fs.stat(sidecarPath(first))).size > 5 * 1024 * 1024)
    const loaded = await loadEdits(first)
    assert.deepEqual(loaded?.masks, edits.masks.map(value => ({ ...value, refine: [] })))
    await assert.rejects(saveEdits(other, edits, null), /원본 사진/)
    assert.equal(await fs.stat(sidecarPath(other)).then(() => true, () => false), false)
    assert.equal(contentHash(await fs.readFile(first)), original)
    // Replacing same-size bytes and restoring mtime still changes inode/ctime.
    const replacement = join(dir, 'replacement'); await fs.writeFile(replacement, 'DIFFERENT ORIGINAL')
    assert.equal((await fs.stat(replacement)).size, stat.size)
    await fs.utimes(replacement, stat.atime, stat.mtime); await fs.rename(replacement, first)
    await authorizeLibraryPhotos(root, [{ filePath: first }, { filePath: other }])
    await assert.rejects(loadEdits(first), /원본 사진/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
