import { test } from 'node:test'
import assert from 'node:assert/strict'
import { useStore } from '../src/renderer/src/store/useStore'
import { defaultEditState } from '../src/shared/edits'
import { runEditHistory } from '../src/renderer/src/lib/editShortcuts'
const writes: { path: string; edit: unknown }[] = []
const photos = ['a.jpg', 'b.jpg', 'c.jpg'].map((filePath) => ({ filePath, fileName: filePath, ext: '.jpg', isRaw: false, mtimeMs: 1, size: 100, rating: 0, flagged: false, meta: null, thumbUrl: null }))
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
let loads: (path: string) => Promise<unknown> = async () => defaultEditState()
Object.assign(globalThis, { window: { luxinus: { edits: { load: (path: string) => loads(path), save: async (path: string, edit: unknown) => { writes.push({ path, edit }); return true } }, library: { requestProxy: async () => ({ webp: new Uint8Array([1]), meta: {} }) } } } })

async function select(path: string): Promise<void> {
  useStore.setState({ photos, proxy: { filePath: null, url: null, status: 'idle', message: null } })
  useStore.getState().selectPhoto(path)
  await tick()
}

test('continuous gesture is one Undo even if paused more than debounce', async () => {
  await select('a.jpg')
  const s = useStore.getState()
  s.beginEditGesture()
  s.setEdit({ exposure: 10 })
  await new Promise((resolve) => setTimeout(resolve, 500))
  s.setEdit({ exposure: 30 })
  s.endEditGesture()
  assert.equal(useStore.getState().undoStack.length, 1)
  s.undo()
  assert.equal(useStore.getState().edit.exposure, 0)
  await s.flushSaves()
})

test('crop gesture survives a long pause as one undo and blocks global history while dragging', async () => {
  await select('c.jpg')
  const previousDocument = globalThis.document
  Object.assign(globalThis, { document: { querySelector: () => null } })
  const s = useStore.getState()
  const crop = { x: 0.2, y: 0.2, w: 0.6, h: 0.6 }
  try {
    s.beginEditGesture()
    s.setEdit({ crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 } })
    assert.equal(useStore.getState().editGestureActive, true)
    assert.equal(runEditHistory('undo'), false)
    await new Promise(resolve => setTimeout(resolve, 500))
    s.setEdit({ crop })
    assert.equal(useStore.getState().undoStack.length, 0)
    assert.equal(runEditHistory('redo'), false)
    s.endEditGesture()
    assert.equal(useStore.getState().editGestureActive, false)
    assert.equal(useStore.getState().undoStack.length, 1)
    assert.equal(runEditHistory('undo'), true)
    assert.equal(useStore.getState().edit.crop, null)
    assert.equal(runEditHistory('redo'), true)
    assert.deepEqual(useStore.getState().edit.crop, crop)
    await s.flushSaves()
  } finally {
    s.endEditGesture()
    if (previousDocument) Object.assign(globalThis, { document: previousDocument })
    else delete (globalThis as any).document
  }
})

test('proposal preview does not touch sidecar or history; saved approval is one undo', async () => {
  await select('b.jpg')
  const s = useStore.getState()
  const base = s.edit
  const before = writes.length
  s.setPreviewEdit({ ...base, contrast: 35 })
  assert.equal(useStore.getState().edit.contrast, 0)
  s.setPreviewEdit(null)
  assert.equal(writes.length, before)
  assert.equal(useStore.getState().undoStack.length, 0)
  assert.equal(s.applyAgentEdit({ photoId: 'a.jpg', baseEdit: base, edit: { ...base, contrast: 35 }, saved: true }), false)
  assert.equal(s.applyAgentEdit({ photoId: 'b.jpg', baseEdit: base, edit: { ...base, contrast: 35 }, saved: true }), true)
  assert.equal(writes.length, before)
  s.undo()
  await s.flushSaves()
  assert.equal(useStore.getState().edit.contrast, 0)
  assert.equal(writes.length, before + 1)
})

test('stale A→B→A sidecar response cannot overwrite latest selection', async () => {
  const resolvers: ((value: unknown) => void)[] = []
  loads = async () => new Promise((resolve) => resolvers.push(resolve))
  await select('a.jpg')
  await select('b.jpg')
  await select('a.jpg')
  assert.equal(resolvers.length, 3)
  resolvers[2]({ ...defaultEditState(), exposure: 40 })
  await tick()
  resolvers[0]({ ...defaultEditState(), exposure: 5 })
  resolvers[1]({ ...defaultEditState(), exposure: 10 })
  await tick()
  assert.equal(useStore.getState().edit.exposure, 40)
  loads = async () => defaultEditState()
})

test('Shift selection follows displayed sort and plain active click clears multi-selection', async () => {
  await select('a.jpg')
  useStore.getState().pickPhoto('b.jpg', { meta: false, shift: true, order: ['a.jpg', 'c.jpg', 'b.jpg'] })
  assert.deepEqual([...useStore.getState().selection], ['a.jpg', 'c.jpg', 'b.jpg'])
  useStore.getState().pickPhoto('a.jpg', { meta: false, shift: false })
  assert.deepEqual([...useStore.getState().selection], ['a.jpg'])
})

test('cancel restoration while image is loading prevents dispatch of inference', async () => {
  await select('b.jpg')
  let resolveImage!: () => void
  let inferenceCalls = 0
  Object.assign(globalThis, { Image: class {
    onload: (() => void) | null = null
    set src(_value: string) { resolveImage = () => this.onload?.() }
  } })
  ;(globalThis as any).window.luxinus.ai = {
    onProgress: () => () => {}, cancel: async () => true,
    restorePreview: async () => { inferenceCalls++; return { ok: false } }
  }
  useStore.setState({ proxy: { filePath: 'b.jpg', url: 'blob:fixture', status: 'ready', message: null } })
  const running = useStore.getState().runDenoise()
  useStore.getState().clearDenoise()
  resolveImage()
  await running
  assert.equal(inferenceCalls, 0)
  assert.equal(useStore.getState().denoiseProxy.message, '복원을 취소했습니다.')
})

test('opening an empty folder cancels old restoration and rejects its delayed result', async () => {
  const previousImage = globalThis.Image, previousDocument = globalThis.document
  const api = (globalThis as any).window.luxinus
  const previousLibrary = api.library, previousAi = api.ai, previousEditedList = api.edits.editedList
  let cancelCalls = 0, finish!: (result: unknown) => void
  Object.assign(globalThis, {
    Image: class { naturalWidth = 1; naturalHeight = 1; onload?: () => void; set src(_url: string) { queueMicrotask(() => this.onload?.()) } },
    document: { createElement: () => ({ width: 1, height: 1, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) }) }) }
  })
  api.library = { openFolder: async () => ({ canceled: false, folderPath: '/synthetic/empty', photos: [] }) }
  api.edits.editedList = async () => []
  api.ai = { onProgress: () => () => {}, cancel: async () => { cancelCalls++; return true }, restorePreview: () => new Promise(resolve => { finish = resolve }) }
  useStore.setState({ photos, selectedPath: 'a.jpg', edit: defaultEditState(), editLoading: false,
    proxy: { filePath: 'a.jpg', status: 'ready', url: 'blob:synthetic', message: null } })
  try {
    const pending = useStore.getState().runDenoise()
    await tick()
    await useStore.getState().openFolder()
    finish({ ok: true, rgba: new Uint8Array([3, 2, 1, 255]), width: 1, height: 1, cache: { status: 'stored' } })
    await pending
    const state = useStore.getState()
    assert.equal(cancelCalls, 1)
    assert.equal(state.selectedPath, null)
    assert.equal(state.denoiseProxy.status, 'idle')
    assert.equal(state.denoiseProxy.filePath, null)
    assert.equal(state.editLoading, false)
    assert.equal(state.undoStack.length, 0)
  } finally {
    api.library = previousLibrary; api.ai = previousAi; api.edits.editedList = previousEditedList
    if (previousImage) Object.assign(globalThis, { Image: previousImage }); else delete (globalThis as any).Image
    if (previousDocument) Object.assign(globalThis, { document: previousDocument }); else delete (globalThis as any).document
  }
})
