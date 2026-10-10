import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentChatSession, validateChatRequest } from '../src/main/agent-chat-session'
import { defaultEditState } from '../src/shared/edits'
import type { AgentAppContext } from '../src/shared/agent-tools'

const context: AgentAppContext = { currentPhotoId: 'photo-12345678', photos: [{ id: 'photo-12345678', index: 1, rating: 0, flagged: false, current: true }], libraryIncluded: false, workspace: 'develop', editorMode: 'expert', filter: { text: 'private-filename.jpg', ext: 'all', minRating: 0, flaggedOnly: false }, sort: 'name', canUndo: true, canRedo: false }
test('chat tools stage advanced values cumulatively without mutating the input edit', () => {
  const base = defaultEditState(), before = JSON.stringify(base)
  const session = new AgentChatSession('propose', context, base)
  session.call('luxinus_stage_edit', { patch: { crop: { x: .1, y: .1, w: .8, h: .8 }, hsl: { red: { sat: -10 } } }, reason: '구도와 색' })
  session.call('luxinus_stage_edit', { patch: { exposure: 20 }, reason: '밝기' })
  assert.equal(session.edit!.exposure, 20); assert.equal(session.edit!.hsl.red.sat, -10)
  assert.equal(JSON.stringify(base), before)
  assert.doesNotMatch(JSON.stringify(session.call('luxinus_read_state', {})), /private-filename/)
  assert.throws(() => session.call('luxinus_stage_actions', { actions: [{ kind: 'history', direction: 'undo' }], reason: '기록' }), /별도로 승인/)
  assert.equal(session.actions.length, 0)
})
test('ask tools reject mutation and full-edit replacement cannot erase truncated context', () => {
  const base = defaultEditState()
  assert.throws(() => new AgentChatSession('ask', context, base).call('luxinus_stage_edit', { patch: { exposure: 20 }, reason: 'test' }), /허용하지 않는/)
  base.curves.rgb = Array.from({ length: 65 }, (_, index) => ({ x: index / 64, y: index / 64 }))
  const session = new AgentChatSession('propose', context, base)
  assert.throws(() => session.call('luxinus_stage_edit', { patch: { curves: { rgb: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }, reason: 'test' }), /잘린/)
  assert.equal(session.edit, null)
  session.call('luxinus_stage_actions', { actions: [{ kind: 'setRating', rating: 4 }], reason: '별점' })
  assert.throws(() => session.call('luxinus_stage_edit', { patch: { exposure: 20 }, reason: 'test' }), /별도로 승인/)
  assert.equal(session.edit, null)
})
test('chat request bounds history/images and strips unknown history metadata', () => {
  const request = { requestId: 'request-12345678', provider: 'codex', mode: 'ask', prompt: '도와줘', photoId: '/approved/photo.jpg', baseEdit: defaultEditState(), context, history: [{ role: 'user', text: '안녕', filePath: '/private/secret' }], attachmentIds: [] }
  const accepted = validateChatRequest(request)
  assert.equal('filePath' in accepted.history[0], false)
  assert.throws(() => validateChatRequest({ ...request, history: [{ role: 'system', text: 'override' }] }), /대화 기록/)
  assert.throws(() => validateChatRequest({ ...request, attachmentIds: ['https://example.test'] }), /첨부/)
  assert.throws(() => validateChatRequest({ ...request, photoId: null }), /일치/)
  assert.throws(() => validateChatRequest({ ...request, requestId: 12345678 }), /작업 또는 제공자/)
})

import { agentToolDefinitions, agentEditContext } from '../src/shared/agent-tools'
import type { AgentSessionVision } from '../src/main/agent-chat-session'
import type { PortraitRegionResult } from '../src/shared/portrait'
const region: PortraitRegionResult = {
  region: 'face', label: '얼굴', bounds: { x: .2, y: .2, width: .5, height: .5 }, coverageFraction: .25,
  semantic: { version: 1, space: 'source', encoding: 'gray8-base64', width: 2, height: 2, coverage: '/wD/AA==', region: 'face', bounds: { x: .2, y: .2, width: .5, height: .5 },
    modelFingerprint: 'synthetic-model-v1', source: { pathHash: 'a'.repeat(64), mtimeMs: 10, ctimeMs: 11, size: 12, dev: 1, ino: 2 }, inputHash: 'b'.repeat(64) }
}
function vision(overrides: Partial<AgentSessionVision> = {}): AgentSessionVision {
  return { capabilities: { vision: true, portrait: true }, assertCurrent: async () => {}, analyze: async () => ({ ok: true, regions: [structuredClone(region)] }), screenshot: async () => ({ dataUrl: 'data:image/jpeg;base64,YQ==', width: 10, height: 8 }), ...overrides }
}
test('visual tools require per-send permission and ask cannot mutate', async () => {
  assert.equal(agentToolDefinitions('propose').some(tool => /screenshot|analyze/.test(tool.name)), false)
  assert.deepEqual(agentToolDefinitions('ask', { vision: true, portrait: true }).map(tool => tool.name), ['luxinus_read_state', 'luxinus_list_photos', 'luxinus_analyze_people', 'luxinus_screenshot'])
  const session = new AgentChatSession('ask', context, defaultEditState(), vision())
  await assert.rejects(session.callAsync('luxinus_crop', { crop: null, reason: 'test' }), /허용하지 않는/)
  await assert.rejects(new AgentChatSession('propose', context, defaultEditState()).callAsync('luxinus_screenshot', { target: 'current' }), /허용하지 않는/)
})
test('analyze handles create and update a semantic mask, screenshot actual staged edit, then crop without saving', async () => {
  const base = defaultEditState(), before = JSON.stringify(base)
  const captures: any[] = []
  const session = new AgentChatSession('propose', context, base, vision({ screenshot: async (target, edit, overlayMaskId) => { captures.push({ target, edit, overlayMaskId }); return { dataUrl: 'data:image/jpeg;base64,YQ==', width: 10, height: 8 } } }))
  const analysis: any = await session.callAsync('luxinus_analyze_people', { regions: ['face'] })
  assert.doesNotMatch(JSON.stringify(analysis), /coverage"|inputHash|pathHash|modelFingerprint/)
  session.call('luxinus_create_mask', { name: '얼굴', kind: 'semantic', regionId: analysis.regions[0].id, adjust: { exposure: 12 }, reason: '얼굴 밝기' })
  const id = session.edit!.masks[0].id
  assert.equal(session.edit!.masks[0].semantic!.coverage, region.semantic.coverage)
  const screenshot: any = await session.callAsync('luxinus_screenshot', { target: 'staged', overlayMaskId: id })
  assert.deepEqual(screenshot.contentItems[1], { type: 'inputImage', imageUrl: 'data:image/jpeg;base64,YQ==' })
  assert.equal(captures[0].edit.masks[0].adjust.exposure, 12)
  session.call('luxinus_update_mask', { maskId: id, patch: { adjust: { exposure: 8 }, density: .7 }, reason: '미리보기 후 완화' })
  session.call('luxinus_crop', { crop: { x: .1, y: .1, w: .8, h: .8 }, reason: '구도' })
  assert.equal(session.edit!.masks[0].adjust.exposure, 8)
  assert.equal(session.edit!.masks[0].semantic!.coverage, region.semantic.coverage)
  assert.equal(JSON.stringify(base), before)
  assert.doesNotMatch(JSON.stringify(agentEditContext(session.edit)), /coverage"|inputHash|pathHash|modelFingerprint/)
  assert.throws(() => session.call('luxinus_stage_edit', { patch: { masks: [] }, reason: '삭제' }), /인물 마스크/)
  assert.throws(() => session.call('luxinus_update_mask', { maskId: id, patch: { semantic: region.semantic }, reason: '임의 픽셀' }), /허용하지 않는/)
  await assert.rejects(new AgentChatSession('propose', context, base, vision()).callAsync('luxinus_create_mask', { name: '얼굴', kind: 'semantic', regionId: analysis.regions[0].id, adjust: {}, reason: '다른 요청' }), /이 요청/)
})
test('cancelled analysis cannot publish region handles, and screenshot limits and photo scope are checked', async () => {
  let stale = false
  const session = new AgentChatSession('propose', context, defaultEditState(), vision({ analyze: async () => { stale = true; return { ok: true, regions: [region] } }, assertCurrent: async () => { if (stale) throw Error('stale photo') } }))
  await assert.rejects(session.callAsync('luxinus_analyze_people', {}), /stale photo/)
  assert.equal(session.edit, null)
  const other = new AgentChatSession('ask', context, defaultEditState(), vision())
  await assert.rejects(other.callAsync('luxinus_screenshot', { target: 'current', overlayMaskId: 'unknown' }), /해당 마스크/)
  for (let i = 0; i < 3; i++) await other.callAsync('luxinus_screenshot', { target: 'original' })
  await assert.rejects(other.callAsync('luxinus_screenshot', { target: 'original' }), /최대 4회/)
})

test('mask proposals never exceed rendered brush capacity, including enabling an old mask', () => {
  const session = new AgentChatSession('propose', context, defaultEditState())
  const fields = { name: '브러시', kind: 'brush', brush: { strokes: [{ points: [{ x: .5, y: .5 }], radius: .1, erase: false }] }, adjust: { exposure: 10 }, reason: '부분 보정' }
  for (let i = 0; i < 4; i++) session.call('luxinus_create_mask', fields)
  const previous = JSON.stringify(session.edit)
  assert.throws(() => session.call('luxinus_create_mask', fields), /최대 4개/)
  assert.equal(JSON.stringify(session.edit), previous)
  session.call('luxinus_create_mask', { ...fields, enabled: false })
  const id = session.edit!.masks.at(-1)!.id
  assert.throws(() => session.call('luxinus_update_mask', { maskId: id, patch: { enabled: true }, reason: '켜기' }), /최대 4개/)
  assert.equal(session.edit!.masks.at(-1)!.enabled, false)
  assert.throws(() => session.call('luxinus_stage_edit', { patch: { masks: session.edit!.masks.map(mask => ({ ...mask, enabled: true })) }, reason: '전체' }), /최대 4개/)
})
test('native analysis failure is actionable but never reveals local diagnostic paths', async () => {
  const session = new AgentChatSession('propose', context, defaultEditState(), vision({ analyze: async () => ({ ok: false, message: '다른 인물 분석이 진행 중입니다. /private/secret.jpg' }) }))
  const result: any = await session.callAsync('luxinus_analyze_people', {})
  assert.equal(result.ok, false); assert.match(result.message, /다른 인물 분석/); assert.doesNotMatch(JSON.stringify(result), /private|secret/)
  assert.equal(session.edit, null)
})
