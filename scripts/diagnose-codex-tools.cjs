// Explicit, user-authorized service diagnostic. Synthetic pixels/state only;
// use the app's managed login without reading or printing its credential file.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const sharp = require('sharp')
const esbuild = require('esbuild')
const { randomUUID } = require('node:crypto')
const { spawn } = require('node:child_process')
const root = path.resolve(__dirname, '..')
const codexHome = process.argv[2]
if (!codexHome || !path.isAbsolute(codexHome)) throw new Error('Pass the Luxinus-only Codex home explicitly.')
const model = process.argv[3] || 'gpt-6-astra'
const variant = process.argv[4] || 'production'
if (!['baseline', 'host-only', 'code-mode', 'production'].includes(variant)) throw new Error('Unsupported diagnostic variant')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-codex-tools-')))
const bundle = path.join(scratch, 'client.cjs')
esbuild.buildSync({ stdin: { contents: "module.exports = { ...require('./src/main/codex-client'), ...require('./src/main/agent-chat-session'), ...require('./src/shared/agent-tools'), ...require('./src/shared/edits') }", resolveDir: root }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
const { CodexClient, CODEX_TEXT_CONFIG, AgentChatSession, agentChatPrompt, agentToolDefinitions, defaultEditState } = require(bundle)
if (variant === 'baseline') CODEX_TEXT_CONFIG['features.code_mode_host'] = false
if (variant === 'host-only' || variant === 'code-mode') CODEX_TEXT_CONFIG['features.code_mode_host'] = true
if (variant === 'code-mode') CODEX_TEXT_CONFIG['features.code_mode'] = true
const events = new Set()
const client = new CodexClient(codexHome, { spawn: (...args) => {
  const child = spawn(...args)
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += chunk.toString()
    let n
    while ((n = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1)
      try { const message = JSON.parse(line); if (typeof message.method === 'string') events.add(message.method + (message.params?.item?.type ? ':' + message.params.item.type : '')) } catch {}
    }
  })
  return child
} })
;(async () => {
  const context = { currentPhotoId: 'photo-synthetic-1234', photos: [{ id: 'photo-synthetic-1234', index: 1, rating: 0, flagged: false, current: true }], libraryIncluded: false, workspace: 'develop', editorMode: 'expert', filter: { text: '', ext: 'all', minRating: 0, flaggedOnly: false }, sort: 'name', canUndo: false, canRedo: false }
  const base = defaultEditState()
  const session = new AgentChatSession('propose', context, base)
  const image = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#ba3829' } }).jpeg().toBuffer()
  const calls = []
  const result = await client.infer(agentChatPrompt(context, base, [], '첨부 이미지는 테스트용 단색 사진이다. 이미지의 주된 색을 확인해서 말하고 luxinus_stage_edit 도구로 노출을 정확히 20으로 바꾸는 제안을 등록해줘. 도구 결과를 확인한 뒤 짧게 답해줘.', true, 'propose'), null,
    randomUUID(), undefined, model, { images: [`data:image/jpeg;base64,${image.toString('base64')}`], dynamicTools: agentToolDefinitions('propose'),
      onToolCall: (name, args) => { const result = session.call(name, args); calls.push({ name, argumentKeys: Object.keys(args || {}), stagedExposure: session.edit?.exposure ?? null }); return result } })
  const report = { source: 'official service with synthetic image/state', variant, events: [...events], model: result.model || model, durationMs: result.durationMs,
    image: { width: 32, height: 32, bytes: image.length }, calls, stagedExposure: session.edit?.exposure ?? null, response: result.text, saved: false }
  const artifacts = path.join(root, '.omc', 'artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  fs.writeFileSync(path.join(artifacts, `codex-tools-real-${variant}.json`), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
})().catch(error => { console.error(JSON.stringify({ error: error.message, variant, events: [...events] })); process.exitCode = 1 }).finally(async () => { await client.shutdown(); fs.rmSync(scratch, { recursive: true, force: true }) })
