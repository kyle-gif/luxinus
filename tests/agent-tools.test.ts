import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultEditState, zeroMaskAdjust } from '../src/shared/edits'
import { agentChatPrompt, agentEditContext, agentToolDefinitions, applyAgentEditPatch, validateAgentActions, validateAgentContext, validateAgentToolCall, type AgentAppContext } from '../src/shared/agent-tools'

const context: AgentAppContext = { currentPhotoId: 'photo-synthetic-1', photos: [{ id: 'photo-synthetic-1', index: 1, rating: 0, flagged: false, current: true }], libraryIncluded: false, workspace: 'develop', editorMode: 'expert', filter: { text: '', ext: 'all', minRating: 0, flaggedOnly: false }, sort: 'name', canUndo: true, canRedo: false }

test('advanced edit patch merges untouched values and stages one complete validated state', () => {
  const base = defaultEditState()
  base.hsl.blue.hue = 17
  const result = applyAgentEditPatch(base, {
    exposure: 25, rotate: 90, flipH: true, crop: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
    curves: { rgb: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] },
    hsl: { red: { sat: -12 } }, colorGrade: { shadows: { hue: 220, sat: 10 } }, denoise: 30,
    masks: [{ id: 'mask-one', name: '어두운 부분', kind: 'lumRange', enabled: true, adjust: { shadows: 20 }, lum: { lo: 0, hi: 0.2, featherLo: 0.1, featherHi: 0.1 } }]
  })
  assert.equal(result.hsl.blue.hue, 17)
  assert.equal(result.hsl.red.sat, -12)
  assert.equal(result.colorGrade.shadows.hue, 220)
  assert.equal(result.colorGrade.blending, 50)
  assert.deepEqual(result.masks[0].adjust, { ...zeroMaskAdjust(), shadows: 20 })
  assert.equal(result.denoise, 30)
  assert.equal(base.exposure, 0)
  assert.equal(base.crop, null)
  assert.deepEqual(base.masks, [])
})

test('advanced tool rejects unknown keys, executable payloads, invalid curves, geometry and duplicate masks', () => {
  const base = defaultEditState()
  for (const patch of [{ filePath: '/tmp/photo' }, { crop: { x: 0.5, y: 0, w: 0.9, h: 1 } }, { curves: { rgb: [{ x: 0.5, y: 0 }, { x: 0.1, y: 1 }] } }, { hsl: { red: { shell: 'rm' } } }, { denoise: 101 }, { rotate: Infinity }, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.throws(() => applyAgentEditPatch(base, patch))
  }
  const mask = { id: 'same', name: 'mask', kind: 'radial', enabled: true, adjust: {}, radial: { cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.2, feather: 0.5, invert: false } }
  assert.throws(() => applyAgentEditPatch(base, { masks: [mask, mask] }), /중복/)
  assert.throws(() => applyAgentEditPatch(base, { masks: [{ ...mask, radial: undefined }] }))
})

test('tool whitelist separates conversation-only reads from every staged mutation', () => {
  assert.deepEqual(agentToolDefinitions('ask').map(tool => tool.name), ['luxinus_read_state', 'luxinus_list_photos'])
  assert.throws(() => validateAgentToolCall('ask', 'luxinus_stage_edit', { patch: { exposure: 20 }, reason: '조정' }))
  assert.throws(() => validateAgentToolCall('propose', 'shell', { command: 'whoami' }))
  assert.throws(() => validateAgentToolCall('ask', 'luxinus_read_state', { path: '/tmp' }))
  validateAgentToolCall('propose', 'luxinus_stage_edit', { patch: { exposure: 20 }, reason: '조정' })
})

test('action plans reject foreign photos and mixed selection/history/metadata before any dispatch', () => {
  assert.throws(() => validateAgentActions([{ kind: 'selectPhoto', photoId: 'photo-unshared' }], context), /공유된/)
  assert.throws(() => validateAgentActions([{ kind: 'history', direction: 'undo' }], context, true), /별도로/)
  assert.throws(() => validateAgentActions([{ kind: 'setRating', rating: 5 }, { kind: 'setWorkspace', workspace: 'library' }], context), /별도로/)
  assert.throws(() => validateAgentActions([{ kind: 'setFlag', flagged: true, filePath: '/private/photo' }], context))
  assert.throws(() => validateAgentActions([{ kind: 'history', direction: 'redo' }], context), /편집 기록/)
  assert.throws(() => validateAgentActions([{ kind: 'setRating', rating: 1.5 }], context))
  assert.deepEqual(validateAgentActions([{ kind: 'setFilter', filter: { ext: '.jpg' } }, { kind: 'setSort', sort: 'rating' }], context), [{ kind: 'setFilter', filter: { ext: '.jpg' } }, { kind: 'setSort', sort: 'rating' }])
})

test('context contains only opted-in opaque photos and excludes local search/vendor data from prompt', () => {
  assert.throws(() => validateAgentContext({ ...context, photos: [...context.photos, { id: 'photo-synthetic-2', index: 2, rating: 0, flagged: false, current: false }] }), /현재 사진만/)
  assert.throws(() => validateAgentContext({ ...context, photos: [{ ...context.photos[0], id: '/tmp/original.jpg' }] }))
  const base = { ...defaultEditState(), vendorPrivateData: { originalPath: '/private/secret.jpg' } }
  const prompt = agentChatPrompt({ ...context, filter: { ...context.filter, text: 'secret-filename.jpg' } }, base, [], '조언해줘', false, 'ask')
  assert.equal(prompt.includes('secret-filename'), false)
  assert.equal(prompt.includes('/private/secret'), false)
  assert.match(prompt, /사진 픽셀을 받지 않았다/)
  assert.equal((agentEditContext(base) as any).values.vendorPrivateData, undefined)
})
