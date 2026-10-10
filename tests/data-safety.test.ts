import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { authorizeLibraryFolder, authorizeLibraryPhotos, assertAuthorizedPhoto, authorizeExportDirectory, assertExportDirectory, validatePresetId, trustRenderer, assertTrustedSender } from '../src/main/file-policy'
import { loadEdits, readEditSnapshot, saveEdits, sidecarPath } from '../src/main/sidecar-store'
import { contentHash, atomicReplace } from '../src/main/safe-file'
import { defaultEditState } from '../src/shared/edits'
import { validateEditState } from '../src/shared/edit-validation'
import { importXmp } from '../src/main/xmp'
import { proposeXmpText, XmpPatchService } from '../src/main/xmp-patch'

async function fixture(t: { after: (callback: () => Promise<void>) => void }): Promise<{ dir: string; photo: string }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'luxinus-safety-')))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const photo = path.join(dir, 'original.dng')
  await fs.writeFile(photo, Buffer.from('fixture-original-bytes\x00\x01\x02'))
  const root = await authorizeLibraryFolder(dir)
  await authorizeLibraryPhotos(root, [{ filePath: photo }])
  return { dir, photo }
}

test('sidecar save, restart-style read, and Undo preserve original hashes and extension fields', async (t) => {
  const { photo } = await fixture(t)
  const original = contentHash(await fs.readFile(photo))
  const target = sidecarPath(photo)
  await fs.writeFile(target, JSON.stringify({ app: 'luxinus', version: 1, vendor: { keep: ['a', 'b'] }, edits: { exposure: 5, curves: { rgb: [{ x: 0, y: 0, vendor: true }, { x: 1, y: 1 }] }, extension: { preserve: true } } }))
  const before = await readEditSnapshot(photo)
  const changed = { ...before.edits!, exposure: 23 }
  assert.equal(await saveEdits(photo, changed, before.hash), true)
  const document = JSON.parse(await fs.readFile(target, 'utf8'))
  assert.deepEqual(document.vendor, { keep: ['a', 'b'] })
  assert.deepEqual(document.edits.extension, { preserve: true })
  assert.equal(document.edits.curves.rgb[0].vendor, true)
  assert.equal(document.version, 3)
  const reloaded = await readEditSnapshot(photo)
  assert.equal(reloaded.edits!.exposure, 23)
  await saveEdits(photo, before.edits!, reloaded.hash)
  assert.equal((await loadEdits(photo))!.exposure, 5)
  assert.equal(contentHash(await fs.readFile(photo)), original)
})

test('concurrent proposals and native autosave reject stale hashes instead of overwriting', async (t) => {
  const { photo } = await fixture(t)
  await loadEdits(photo)
  await saveEdits(photo, defaultEditState())
  const snapshot = await readEditSnapshot(photo)
  const outcomes = await Promise.allSettled([saveEdits(photo, { ...defaultEditState(), exposure: 1 }, snapshot.hash), saveEdits(photo, { ...defaultEditState(), exposure: 2 }, snapshot.hash)])
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1)
  await loadEdits(photo)
  const external = JSON.stringify({ app: 'luxinus', version: 2, edits: { exposure: 50 } })
  await fs.writeFile(sidecarPath(photo), external)
  await assert.rejects(saveEdits(photo, defaultEditState()), /충돌/)
  assert.equal(await fs.readFile(sidecarPath(photo), 'utf8'), external)
})

test('malformed and future sidecars remain unchanged and are reported', async (t) => {
  const { photo } = await fixture(t)
  for (const source of ['{broken', JSON.stringify({ app: 'luxinus', version: 99, edits: {} }), JSON.stringify({ app: 'luxinus', version: 2, edits: { exposure: 'bad' } })]) {
    await fs.writeFile(sidecarPath(photo), source)
    await assert.rejects(loadEdits(photo))
    await assert.rejects(saveEdits(photo, defaultEditState()))
    assert.equal(await fs.readFile(sidecarPath(photo), 'utf8'), source)
  }
})

test('agent inspection and export cannot advance the active editor conflict baseline', async (t) => {
  const { photo } = await fixture(t)
  await saveEdits(photo, { ...defaultEditState(), exposure: 10 })
  const active = await loadEdits(photo, true)
  const external = JSON.stringify({ app: 'luxinus', version: 2, edits: { exposure: 80 } })
  await fs.writeFile(sidecarPath(photo), external)
  assert.equal((await readEditSnapshot(photo)).edits!.exposure, 80)
  assert.equal((await loadEdits(photo))!.exposure, 80)
  await assert.rejects(saveEdits(photo, { ...active!, exposure: 11 }), /충돌/)
  assert.equal(await fs.readFile(sidecarPath(photo), 'utf8'), external)
})

test('photo and export capabilities reject arbitrary paths, traversal, symlinks, and replacement', async (t) => {
  const { dir, photo } = await fixture(t)
  const stranger = path.join(dir, 'unselected.jpg')
  await fs.writeFile(stranger, 'private')
  await assert.rejects(assertAuthorizedPhoto(stranger), /라이브러리/)
  await assert.rejects(assertAuthorizedPhoto(`${dir}/sub/../original.dng`), /절대 경로/)
  const link = path.join(dir, 'linked.dng')
  await fs.symlink(stranger, link)
  assert.deepEqual(await authorizeLibraryPhotos(dir, [{ filePath: link }]), [])
  await fs.symlink(stranger, sidecarPath(photo))
  await assert.rejects(loadEdits(photo))
  await assert.rejects(saveEdits(photo, defaultEditState()))
  assert.equal(await fs.readFile(stranger, 'utf8'), 'private')
  await fs.rename(photo, photo + '.old')
  await fs.writeFile(photo, 'replacement')
  await assert.rejects(assertAuthorizedPhoto(photo), /변경/)
  await assert.rejects(assertExportDirectory(dir), /저장 위치/)
  assert.equal(await authorizeExportDirectory(dir), dir)
  assert.equal(await assertExportDirectory(dir), dir)
  for (const id of ['../../victim', '/tmp/victim', 'a/b', '..', 'x\0y']) assert.throws(() => validatePresetId(id))
})

test('atomic create refuses external file creation and does not leave staging files', async (t) => {
  const { dir } = await fixture(t)
  const target = path.join(dir, 'write.lux.json')
  await fs.writeFile(target, 'external')
  await assert.rejects(atomicReplace(target, 'new', null, async () => {}), /충돌/)
  assert.equal(await fs.readFile(target, 'utf8'), 'external')
  assert.ok(!(await fs.readdir(dir)).some((name) => name.endsWith('.tmp')))
})

test('IPC trusts only the registered app document and rejects navigation or child frames', () => {
  const mainFrame = { url: 'file:///app/renderer/index.html' }
  const sender = { mainFrame, isDestroyed: () => false }
  const event = { sender, senderFrame: mainFrame }
  assert.throws(() => assertTrustedSender(event as never), /허용되지/)
  trustRenderer(sender as never, mainFrame.url)
  assert.doesNotThrow(() => assertTrustedSender(event as never))
  assert.throws(() => assertTrustedSender({ ...event, senderFrame: { ...mainFrame } } as never), /허용되지/)
  mainFrame.url = 'file:///Users/anyone/untrusted.html'
  assert.throws(() => assertTrustedSender(event as never), /앱 화면/)
})

const xml = '\uFEFF<?xml version="1.0" encoding="UTF-8"?>\r\n' +
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\r\n' +
  '<!-- crs:Shadows2012="999" preserve this comment -->\r\n' +
  '<rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:vendor="urn:vendor" crs:Shadows2012="10" vendor:unknown="&amp;keep">' +
  '<vendor:list><rdf:Seq><rdf:li>keep</rdf:li></rdf:Seq></vendor:list><crs:UnknownAdjustment>72</crs:UnknownAdjustment></rdf:Description></rdf:RDF></x:xmpmeta>'

test('XMP rejects malformed XML, DTD/entities, invalid ranges and unknown edits', () => {
  assert.throws(() => importXmp('<rdf:RDF><rdf:Description></rdf:RDF>', 'bad'), /문법/)
  for (const declaration of ['<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]>', '<!ENTITY attack "expand">']) assert.throws(() => importXmp(declaration + xml, 'bad'), /DTD/)
  assert.throws(() => proposeXmpText(xml, { Shadows2012: 101 }), /범위/)
  assert.throws(() => proposeXmpText(xml, { UnknownAdjustment: 20 }), /지원/)
  assert.throws(() => validateEditState({ ...defaultEditState(), exposure: Infinity }))
  assert.throws(() => validateEditState({ ...defaultEditState(), crop: { x: 0.9, y: 0, w: 0.5, h: 1 } }))
  for (const invalid of [{ masks: 'bad' }, { masks: null }, { masks: [null] }, { curves: null }, { hsl: [] }, { colorGrade: 'bad' }, { crop: [] }, { masks: [{ adjust: null }] }, { masks: [{ refine: 'bad' }] }]) {
    assert.throws(() => validateEditState(invalid))
  }
})

test('XMP patch changes only targeted attribute bytes, preserving comments BOM RDF namespaces CRLF', () => {
  const proposal = proposeXmpText(xml, { Shadows2012: 24 })
  assert.equal(proposal.text, xml.replace('crs:Shadows2012="10"', 'crs:Shadows2012="24"'))
  assert.deepEqual(proposal.changes, [{ key: 'Shadows2012', before: 10, after: 24 }])
  assert.ok(importXmp(proposal.text, 'fixture').ignored.includes('UnknownAdjustment'))
  assert.ok(importXmp(xml.replace('crs:Shadows2012="10"', 'crs:Shadows2012="10" crs:CameraProfile="Adobe Portrait"'), 'fixture').ignored.includes('CameraProfile'))
  const custom = xml.replaceAll('crs:', 'camera:').replace('xmlns:crs=', 'xmlns:camera=')
  assert.equal(importXmp(custom, 'fixture').edits.shadows, 10)
  assert.equal(importXmp(xml.replace('http://ns.adobe.com/camera-raw-settings/1.0/', 'urn:unrelated-vendor'), 'fixture').edits.shadows, 0)
})

test('XMP approval, conflict detection, persistent journal, and Undo protect the adjacent original', async (t) => {
  const { dir, photo } = await fixture(t)
  const original = contentHash(await fs.readFile(photo))
  const source = path.join(dir, 'original.xmp')
  await fs.writeFile(source, xml)
  const service = new XmpPatchService(path.join(dir, 'history'))
  const review = await service.open(source)
  const proposal = await service.propose(review.documentId, { Shadows2012: 30 })
  assert.equal(await fs.readFile(source, 'utf8'), xml)
  const applied = await service.apply(proposal.proposalId)
  assert.equal((await fs.readFile(source, 'utf8')), proposal.after)
  await assert.rejects(service.apply(proposal.proposalId), /만료|처리/)
  await service.undo(applied.operationId)
  assert.equal(await fs.readFile(source, 'utf8'), xml)
  const journal = JSON.parse(await fs.readFile(path.join(dir, 'history', `${applied.operationId}.json`), 'utf8'))
  assert.equal(journal.status, 'undone')
  assert.equal(journal.before, xml)
  const reselected = await service.open(source)
  const stale = await service.propose(reselected.documentId, { Shadows2012: 40 })
  await fs.writeFile(source, xml + '\r\n')
  await assert.rejects(service.apply(stale.proposalId), /충돌/)
  assert.equal(await fs.readFile(source, 'utf8'), xml + '\r\n')
  assert.equal(contentHash(await fs.readFile(photo)), original)
})
