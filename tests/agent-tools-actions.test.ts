import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store/useStore'
import { useWorkspaceStore } from '../src/renderer/src/store/useWorkspaceStore'
import { useAgentStore } from '../src/renderer/src/store/useAgentStore'
import { applyAgentActions, buildAgentContext, validateAgentActionSnapshot } from '../src/renderer/src/lib/agentActions'
import { applyAgentEditPatch } from '../src/shared/agent-tools'
import { defaultEditState } from '../src/shared/edits'

const photos = ['a.jpg', 'b.jpg'].map(filePath => ({ filePath, fileName: filePath, ext: '.jpg', isRaw: false, mtimeMs: 1, size: 100, rating: 0, flagged: false, meta: null, thumbUrl: null }))
const metadataWrites: { path: string; rating?: number; flagged?: boolean }[] = []
const saves: unknown[] = []
let allowMetadata = true
Object.assign(globalThis, { window: { innerWidth: 1024, luxinus: {
  edits: { load: async () => defaultEditState(), save: async (_path: string, edit: unknown) => { saves.push(edit); return true } },
  library: {
    requestProxy: async () => ({ webp: new Uint8Array([1]), meta: {} }),
    setRating: async (path: string, rating: number) => { metadataWrites.push({ path, rating }); return allowMetadata },
    setFlag: async (path: string, flagged: boolean) => { metadataWrites.push({ path, flagged }); return allowMetadata }
  }
} } })
async function reset(): Promise<void> {
  await useStore.getState().flushSaves()
  useStore.setState({ photos: structuredClone(photos), selectedPath: null, editLoading: false, previewEdit: null, syncing: false, editGestureActive: false, filter: { text: '', ext: 'all', minRating: 0, flaggedOnly: false } })
  useWorkspaceStore.setState({ workspace: 'library', sort: 'name', panelCollapsed: false, photoOnly: false, editPanelTab: 'adjust', viewRequest: null })
  useStore.getState().selectPhoto('a.jpg')
  await new Promise(resolve => setTimeout(resolve, 0))
}

test('context privacy is current-only by default and selection cannot escape its opaque snapshot', async () => {
  await reset()
  const current = buildAgentContext()
  assert.equal(current.context.photos.length, 1)
  assert.equal(JSON.stringify(current.context).includes('a.jpg'), false)
  assert.equal(current.photoPaths[current.context.currentPhotoId!], 'a.jpg')
  await assert.rejects(applyAgentActions([{ kind: 'selectPhoto', photoId: 'photo-unshared' }], current), /공유된/)
  assert.equal(useStore.getState().selectedPath, 'a.jpg')
  const all = buildAgentContext(true)
  const target = Object.keys(all.photoPaths).find(id => all.photoPaths[id] === 'b.jpg')!
  await applyAgentActions([{ kind: 'selectPhoto', photoId: target }], all)
  assert.equal(useStore.getState().selectedPath, 'b.jpg')
  await new Promise(resolve => setTimeout(resolve, 0))
})

test('invalid later action cannot partially mutate UI and stale metadata plans do not write', async () => {
  await reset()
  const snapshot = buildAgentContext()
  await assert.rejects(applyAgentActions([{ kind: 'setWorkspace', workspace: 'develop' }, { kind: 'arbitraryCode', code: 'run' } as any], snapshot))
  assert.equal(useWorkspaceStore.getState().workspace, 'library')
  useStore.setState(state => ({ photos: state.photos.map(photo => photo.filePath === 'a.jpg' ? { ...photo, rating: 3 } : photo) }))
  const writesBefore = metadataWrites.length
  assert.throws(() => validateAgentActionSnapshot(snapshot, [{ kind: 'setRating', rating: 5 }]), /별점/)
  await assert.rejects(applyAgentActions([{ kind: 'setRating', rating: 5 }], snapshot), /별점/)
  assert.equal(metadataWrites.length, writesBefore)
})

test('metadata approval waits for persistence and reports failure without a false UI update', async () => {
  await reset()
  allowMetadata = false
  await assert.rejects(applyAgentActions([{ kind: 'setRating', rating: 5 }], buildAgentContext()), /별점/)
  assert.equal(useStore.getState().photos[0].rating, 0)
  allowMetadata = true
  await applyAgentActions([{ kind: 'setFlag', flagged: true }], buildAgentContext())
  assert.equal(useStore.getState().photos[0].flagged, true)
  assert.deepEqual(metadataWrites.at(-1), { path: 'a.jpg', flagged: true })
})

test('advanced approved edit is adopted once, and history action restores every field in one step', async () => {
  await reset()
  const before = useStore.getState().edit
  const edit = applyAgentEditPatch(before, { exposure: 25, hsl: { blue: { hue: 10 } }, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, flipH: true })
  const saveCount = saves.length
  assert.equal(useStore.getState().applyAgentEdit({ photoId: 'a.jpg', baseEdit: before, edit, saved: true }), true)
  assert.equal(saves.length, saveCount, 'Already persisted main approval is not saved twice')
  assert.equal(useStore.getState().undoStack.length, 1)
  await applyAgentActions([{ kind: 'history', direction: 'undo' }], buildAgentContext())
  assert.deepEqual(useStore.getState().edit, before)
  await applyAgentActions([{ kind: 'history', direction: 'redo' }], buildAgentContext())
  assert.deepEqual(useStore.getState().edit, edit)
})

test('AI restoration approval starts preview once and late pixels cannot overwrite Undo', async () => {
  await reset()
  const previous = { Image: globalThis.Image, ImageData: globalThis.ImageData, document: globalThis.document }
  const actualRun = useStore.getState().runDenoise
  const luxinus = (window as any).luxinus
  let calls = 0, finish!: (value: unknown) => void, pending: Promise<void> | undefined
  const produced = new Promise<unknown>(resolve => { finish = resolve })
  Object.assign(globalThis, {
    Image: class { naturalWidth = 1; naturalHeight = 1; onload?: () => void; set src(_url: string) { queueMicrotask(() => this.onload?.()) } },
    ImageData: class { constructor(readonly data: Uint8ClampedArray, readonly width: number, readonly height: number) {} },
    document: { createElement: () => ({ width: 1, height: 1, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }), putImageData() {} }), toBlob: (done: (blob: Blob) => void) => done(new Blob(['synthetic'])) }) }
  })
  luxinus.ai = { onProgress: () => () => {}, restorePreview: () => { calls++; return produced }, cancel: async () => true }
  useStore.setState({ proxy: { filePath: 'a.jpg', url: 'synthetic-proxy', status: 'ready', message: null }, runDenoise: () => { pending = actualRun(); return pending } })
  try {
    const base = useStore.getState().edit
    assert.equal(useStore.getState().applyAgentEdit({ photoId: 'a.jpg', baseEdit: base, edit: { ...base, denoise: 35 }, saved: true }), true)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(calls, 1)
    assert.equal(useStore.getState().denoiseProxy.status, 'running')
    useStore.getState().undo()
    assert.equal(useStore.getState().edit.denoise, 0)
    finish({ ok: true, width: 1, height: 1, rgba: new Uint8Array([9, 8, 7, 255]), cache: { status: 'stored' } })
    await pending
    assert.equal(useStore.getState().edit.denoise, 0, 'Completion cannot reseed the undone edit to 60')
    assert.equal(useStore.getState().denoiseProxy.status, 'ready')
    assert.equal(useStore.getState().denoiseProxy.cacheStatus, 'stored')
    useStore.getState().redo()
    assert.equal(useStore.getState().edit.denoise, 35)
    assert.equal(calls, 1, 'Ready restoration pixels are reused by Redo')
    await useStore.getState().flushSaves()
  } finally {
    useStore.getState().clearDenoise()
    useStore.setState({ runDenoise: actualRun, edit: defaultEditState() })
    for (const key of Object.keys(previous) as (keyof typeof previous)[]) {
      if (previous[key] === undefined) delete (globalThis as any)[key]
      else (globalThis as any)[key] = previous[key]
    }
    delete luxinus.ai
  }
})

test('panel and view actions survive workspace mount, and photo-only clears editing overlays', async () => {
  await reset()
  useAgentStore.getState().setOpen(true)
  await applyAgentActions([{ kind: 'openPanel', panel: 'presets' }, { kind: 'setView', zoom: 2 }], buildAgentContext())
  assert.equal(useWorkspaceStore.getState().workspace, 'develop')
  assert.equal(useWorkspaceStore.getState().editPanelTab, 'presets')
  assert.equal(useWorkspaceStore.getState().viewRequest?.zoom, 2)
  assert.equal(useAgentStore.getState().open, false, 'Compact layout reveals the requested right panel')
  useStore.setState({ cropMode: true, maskMode: true, wbPicking: true, colorPicking: true, straightening: true, showBefore: true, splitCompare: true, showClipping: true })
  await applyAgentActions([{ kind: 'setPhotoOnly', enabled: true }], buildAgentContext())
  const state = useStore.getState()
  assert.equal(useWorkspaceStore.getState().photoOnly, true)
  assert.deepEqual([state.cropMode, state.maskMode, state.wbPicking, state.colorPicking, state.straightening, state.showBefore, state.splitCompare, state.showClipping], Array(8).fill(false))
})
