import test from 'node:test'
import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store/useStore'
import { usePortraitStore, listenForPortraitSelection } from '../src/renderer/src/store/usePortraitStore'
import { defaultEditState } from '../src/shared/edits'
import { encodeSemanticCoverage, type PortraitRegionResult } from '../src/shared/portrait'
import { editChanges } from '../src/renderer/src/lib/agentPresentation'

const writes: unknown[] = []
const photos = ['a.jpg', 'b.jpg'].map(filePath => ({ filePath, fileName: filePath, ext: '.jpg', isRaw: false, mtimeMs: 1, size: 100, rating: 0, flagged: false, meta: null, thumbUrl: null }))
Object.assign(globalThis, { window: { luxinus: {
  edits: { load: async () => defaultEditState(), save: async (_path: string, edit: unknown) => { writes.push(edit); return true } },
  library: { requestProxy: async () => ({ webp: new Uint8Array([1]), meta: {} }) },
  portrait: { cancel: async () => true }
} } })
function fixture(): PortraitRegionResult {
  return { region: 'skin', label: '피부', coverageFraction: .5, bounds: { x: 0, y: 0, width: .5, height: 1 },
    semantic: { version: 1, space: 'source', encoding: 'gray8-base64', width: 2, height: 2, coverage: encodeSemanticCoverage(new Uint8Array([255, 0, 255, 0])),
      region: 'skin', bounds: { x: 0, y: 0, width: .5, height: 1 }, modelFingerprint: 'fixture-model:0000000000000000', source: { pathHash: 'a'.repeat(64), mtimeMs: 1, size: 100, ctimeMs: 1, dev: 1, ino: 1 }, inputHash: 'b'.repeat(64) } }
}
async function select(path: string): Promise<void> {
  useStore.setState({ photos, syncing: false, proxy: { filePath: null, url: null, status: 'idle', message: null } })
  useStore.getState().selectPhoto(path)
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('automatic masks persist and a batch is exactly one Undo; paste keeps the target photo mask', async () => {
  await select('a.jpg')
  useStore.getState().addSemanticMasks('a.jpg', [fixture(), { ...fixture(), label: '얼굴' }])
  const after = useStore.getState().edit
  assert.equal(after.masks.length, 2); assert.equal(useStore.getState().undoStack.length, 1)
  useStore.getState().undo(); assert.equal(useStore.getState().edit.masks.length, 0)
  useStore.getState().redo(); assert.deepEqual(useStore.getState().edit.masks, after.masks)
  await useStore.getState().flushSaves()
  assert.deepEqual((writes.at(-1) as typeof after).masks, after.masks)
  useStore.getState().copyEdit()
  await select('b.jpg')
  const target = fixture(); target.semantic.source.pathHash = 'c'.repeat(64)
  useStore.getState().addSemanticMasks('b.jpg', [target])
  const targetId = useStore.getState().edit.masks[0].id
  useStore.getState().pasteEdit()
  assert.deepEqual(useStore.getState().edit.masks.map(item => item.id), [targetId])
  await useStore.getState().flushSaves()
})

test('automatic mask selection rejects the previous photo and changed source metadata', async () => {
  await select('a.jpg')
  assert.throws(() => useStore.getState().addSemanticMasks('b.jpg', [fixture()]), /상태가 바뀌/)
  const changed = fixture(); changed.semantic.source.mtimeMs = 2
  assert.throws(() => useStore.getState().addSemanticMasks('a.jpg', [changed]), /파일이 바뀌/)
  assert.equal(useStore.getState().edit.masks.length, 0)
})

test('changing the selected photo cancels portrait analysis before pixel inference dispatch', async () => {
  await select('a.jpg')
  const previousImage = globalThis.Image
  let decode!: () => void, calls = 0
  Object.assign(globalThis, { Image: class { src = ''; decode() { return new Promise<void>(resolve => { decode = resolve }) } } })
  ;(window.luxinus.portrait as any).analyze = async () => { calls++; return { ok: true, regions: [fixture()] } }
  const unsubscribe = listenForPortraitSelection()
  try {
    useStore.setState({ proxy: { filePath: 'a.jpg', url: 'blob:fixture', status: 'ready', message: null } })
    const running = usePortraitStore.getState().analyze()
    useStore.setState({ selectedPath: 'b.jpg' })
    decode(); await running
    assert.equal(calls, 0); assert.equal(usePortraitStore.getState().regions.length, 0)
    assert.equal(usePortraitStore.getState().phase, 'idle')
  } finally { unsubscribe(); Object.assign(globalThis, { Image: previousImage }) }
})

test('same-photo proxy replacement cancels running analysis and never leaves a stale busy state', async () => {
  const previousImage = globalThis.Image, previousDocument = globalThis.document
  try {
    Object.assign(globalThis, {
      Image: class { src = ''; naturalWidth = 4; naturalHeight = 3; async decode() {} },
      document: { createElement: () => ({ width: 4, height: 3, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray(4 * 3 * 4) }) }) }) }
    })
    for (const subscribed of [true, false]) {
      await select('a.jpg'); usePortraitStore.getState().reset()
      useStore.setState({ proxy: { filePath: 'a.jpg', url: 'blob:preview', status: 'ready', message: null } })
      let release!: (value: unknown) => void, started!: () => void, cancellations = 0
      const invoked = new Promise<void>(resolve => { started = resolve })
      ;(window.luxinus.portrait as any).analyze = () => { started(); return new Promise(resolve => { release = resolve }) }
      ;(window.luxinus.portrait as any).cancel = async () => { cancellations++; return true }
      const unsubscribe = subscribed ? listenForPortraitSelection() : () => {}
      try {
        const running = usePortraitStore.getState().analyze(); await invoked
        useStore.setState({ proxy: { ...useStore.getState().proxy, url: 'blob:full-resolution' } })
        if (subscribed) { assert.equal(cancellations, 1); assert.equal(usePortraitStore.getState().phase, 'idle') }
        release({ ok: true, regions: [fixture()] }); await running
        assert.equal(usePortraitStore.getState().phase, 'idle'); assert.deepEqual(usePortraitStore.getState().regions, [])
        ;(window.luxinus.portrait as any).analyze = async () => ({ ok: true, regions: [fixture()] })
        await usePortraitStore.getState().analyze()
        assert.equal(usePortraitStore.getState().phase, 'ready'); assert.equal(usePortraitStore.getState().regions.length, 1)
      } finally { unsubscribe(); usePortraitStore.getState().reset() }
    }
  } finally { Object.assign(globalThis, { Image: previousImage, document: previousDocument }) }
})

test('chat comparison names added regions and their local adjustments without pixel payloads', () => {
  const base = defaultEditState(), after = defaultEditState()
  after.masks = [{ id: 'skin', name: '피부', kind: 'semantic', enabled: true, semantic: fixture().semantic, adjust: { exposure: 12 } as any }]
  const changes = editChanges(base, after)
  assert.ok(changes.some(item => item.label === '부분 보정 · 피부' && item.after === '선택 영역 추가'))
  assert.ok(changes.some(item => item.label === '부분 보정 · 피부 · 노출' && item.after === '12'))
  assert.doesNotMatch(JSON.stringify(changes), /coverage|inputHash|modelFingerprint/)
})
