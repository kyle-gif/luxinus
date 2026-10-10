import test from 'node:test'
import assert from 'node:assert/strict'
import { defaultEditState } from '../src/shared/edits'
import { codexOutputSchema, codexPrompt, parseCodexOutput } from '../src/shared/agent-provider'
import { AGENT_CONTROLS, agentPrompt, requestedAgentValues } from '../src/shared/local-agent'

const result = (changes: unknown[] = [{ control: 'exposure', value: 25 }]) => ({
  tool: 'proposeEditPatch', photoId: 'opaque-scope', changes, reason: '노출을 0.5 EV 밝게 조정합니다.'
})
test('Codex partial edits use a strict schema and still enforce every local edit bound', () => {
  assert.deepEqual(parseCodexOutput(JSON.stringify(result()), 'opaque-scope').patch, { exposure: 25 })
  const schema = codexOutputSchema('opaque-scope') as any
  assert.deepEqual(schema.required.sort(), Object.keys(schema.properties).sort())
  assert.deepEqual(schema.properties.changes.items.required.sort(), Object.keys(schema.properties.changes.items.properties).sort())
  for (const changes of [
    [{ control: 'exposure', value: 101 }], [{ control: 'grain', value: -1 }],
    [{ control: 'exposure', value: '25' }], [{ control: 'exposure', value: null }],
    [{ control: 'denoise', value: 20 }], [{ control: '__proto__', value: 1 }],
    [{ control: 'exposure', value: 25 }, { control: 'exposure', value: 26 }],
    [{ control: 'exposure', value: 25, command: 'write' }]
  ]) assert.throws(() => parseCodexOutput(JSON.stringify(result(changes)), 'opaque-scope'))
  assert.throws(() => parseCodexOutput(JSON.stringify(result()), 'another-photo'))
  assert.throws(() => parseCodexOutput(JSON.stringify({ ...result(), tool: 'runShell' }), 'opaque-scope'))
  assert.throws(() => parseCodexOutput(JSON.stringify({ ...result(), path: '/photo' }), 'opaque-scope'))
  assert.throws(() => parseCodexOutput('x'.repeat(16_385), 'opaque-scope'))
})
test('unsupported Codex responses never carry edits', () => {
  assert.equal(parseCodexOutput(JSON.stringify({ ...result([]), tool: 'unsupported' }), 'opaque-scope').tool, 'unsupported')
  assert.throws(() => parseCodexOutput(JSON.stringify({ ...result(), tool: 'unsupported' }), 'opaque-scope'))
})
test('Codex prompt contains only an opaque scope, requested text and allowed scalar edits', () => {
  const prompt = codexPrompt('opaque-scope', { ...defaultEditState(), exposure: 10, masks: [] }, '노출을 +0.5EV 올려줘')
  const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1))
  assert.deepEqual(Object.keys(input).sort(), ['current', 'photoId', 'request'])
  assert.equal(input.current.exposure, 10)
  assert.equal(input.current.masks, undefined)
  assert.equal(input.current.crop, undefined)
  assert.equal(input.photoId, 'opaque-scope')
  assert.match(prompt, /exposure 50 = \+1 EV/)
})
test('clear UI labels and familiar old labels both work for the retained local model', () => {
  for (const [key, control] of Object.entries(AGENT_CONTROLS)) {
    assert.deepEqual(requestedAgentValues(`${control.label} 값을 20으로 설정해줘`), { [key]: 20 }, control.label)
  }
  assert.deepEqual(requestedAgentValues('부분 대비를 20으로, 대비를 5로'), { clarity: 20, contrast: 5 })
  const prompt = agentPrompt('opaque-scope', defaultEditState(), '부분 대비를 20으로, 어두운 부분을 15로, 대비를 5로')
  assert.ok(prompt.includes('"request":"명료도를 20으로, 그림자를 15로, 대비를 5로"'))
  const qualitative = '색감은 유지하고 어두운 부분만 조금 살려줘.'
  assert.ok(agentPrompt('opaque-scope', defaultEditState(), qualitative).includes(`"request":"${qualitative}"`))
  assert.deepEqual(requestedAgentValues('어두운 부분을 20으로, 밝은 부분을 -10으로, 질감을 5로'), { highlights: -10, shadows: 20, texture: 5 })
  assert.deepEqual(requestedAgentValues('그림자를 20으로, 하이라이트를 -10으로, 텍스처를 5로'), { highlights: -10, shadows: 20, texture: 5 })
})
