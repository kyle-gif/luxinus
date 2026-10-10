/* Explicit service diagnostic: generated two-color pixels only. Uses production
 * Codex protocol/session and photo shader; no library or sidecar is opened.
 * Native application IPC is independently tested by electron-chat-smoke.cjs. */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto'), sharp = require('sharp'), esbuild = require('esbuild')
const root = path.resolve(__dirname, '..'), codexHome = process.argv[2], model = process.argv[3] || 'gpt-6-astra'
if (!codexHome || !path.isAbsolute(codexHome)) throw Error('Pass the Luxinus-only Codex home explicitly.')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-codex-vision-')))
app.setPath('userData', path.join(scratch, 'electron'))
const bundle = path.join(scratch, 'client.cjs')
esbuild.buildSync({ stdin: { contents: "module.exports={...require('./src/main/codex-client'),...require('./src/main/agent-chat-session'),...require('./src/shared/agent-tools'),...require('./src/shared/edits')}", resolveDir: root }, outfile: bundle, bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
const { CodexClient, AgentChatSession, agentChatPrompt, agentToolDefinitions, defaultEditState } = require(bundle)
const client = new CodexClient(codexHome)
let win, timeout
async function run() {
  await app.whenReady()
  win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await win.loadURL('data:text/html,<html><body>Generated photo renderer</body></html>')
  const renderer = esbuild.buildSync({ stdin: { contents: 'export {renderAgentImage} from "./src/renderer/src/lib/agentImage"', resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', globalName: 'photoRenderer', write: false }).outputFiles[0].text
  await win.webContents.executeJavaScript(renderer)
  const source = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120"><rect width="80" height="120" fill="#1456d4"/><rect x="80" width="80" height="120" fill="#eb8a22"/></svg>')).jpeg({ quality: 95 }).toBuffer()
  const sourceUrl = `data:image/jpeg;base64,${source.toString('base64')}`
  const context = { currentPhotoId: 'photo-synthetic-1234', photos: [{ id: 'photo-synthetic-1234', index: 1, rating: 0, flagged: false, current: true }], libraryIncluded: false, workspace: 'develop', editorMode: 'expert', filter: { text: '', ext: 'all', minRating: 0, flaggedOnly: false }, sort: 'name', canUndo: false, canRedo: false }
  const base = defaultEditState(), calls = [], captures = [], capabilities = { vision: true, portrait: false }
  let alive = true
  const session = new AgentChatSession('propose', context, base, {
    capabilities, assertCurrent: async () => { if (!alive) throw Error('Diagnostic canceled') }, analyze: async () => { throw Error('No portrait tool is advertised for this generated fixture') },
    screenshot: async (target, edit, overlayMaskId) => {
      const dataUrl = await win.webContents.executeJavaScript(`photoRenderer.renderAgentImage(${JSON.stringify(sourceUrl)},${JSON.stringify(edit)},null,1536,${JSON.stringify({ overlayMaskId })})`)
      const meta = await sharp(Buffer.from(dataUrl.split(',')[1], 'base64')).metadata()
      captures.push({ target, width: meta.width, height: meta.height, overlay: !!overlayMaskId, bytes: Buffer.from(dataUrl.split(',')[1], 'base64').length })
      return { dataUrl, width: meta.width, height: meta.height }
    }
  })
  timeout = setTimeout(() => { alive = false; void client.shutdown() }, 200_000)
  const prompt = '이 테스트 사진에는 두 가지 넓은 색 영역이 있다. luxinus_screenshot으로 현재 사진을 실제로 보고 두 색을 식별해줘. 이어 중앙의 원형 부분 밝기를 높이는 radial 마스크를 만들고, 사진의 바깥쪽 10%를 제외하는 자르기를 제안해줘. luxinus_screenshot의 staged 결과를 다시 본 뒤 마스크 밝기를 조금 완화하는 수정도 등록해줘. 마지막에는 네가 실제로 본 두 색과 변경 사항을 짧게 말해줘. 저장은 하지 않고 적용 대기 제안만 남겨줘.'
  const result = await client.infer(agentChatPrompt(context, base, [], prompt, false, 'propose', capabilities), null, randomUUID(), () => !alive, model, {
    dynamicTools: agentToolDefinitions('propose', capabilities), allowImageResults: true,
    onToolCall: async (name, args) => { const output = await session.callAsync(name, args); calls.push({ name, argumentKeys: Object.keys(args || {}), hasImage: !!output.contentItems?.some(item => item.type === 'inputImage'), masks: session.edit?.masks.length ?? 0, crop: session.edit?.crop ?? null }); return output }
  })
  alive = false
  const firstShot = calls.findIndex(call => call.hasImage), lastShot = calls.findLastIndex(call => call.hasImage)
  assert.ok(captures.length >= 2, 'Official service must request and receive multiple actual image tool outputs')
  assert.ok(firstShot < lastShot && calls.slice(firstShot + 1, lastShot).some(call => /mask|crop|stage_edit/.test(call.name)), 'Service must continue editing after seeing the image')
  assert.ok(calls.slice(lastShot + 1).some(call => /update_mask|stage_edit/.test(call.name)), 'Service must refine after staged screenshot')
  assert.ok(session.edit?.crop && session.edit.masks.some(mask => mask.kind === 'radial'))
  assert.equal(base.crop, null); assert.equal(base.masks.length, 0)
  const report = { source: 'official authenticated Codex service; generated 160x120 two-color image; production shader/session/client', model: result.model || model, durationMs: result.durationMs, initialImageCount: 0, captures, calls, response: result.text, actualInputImageToolContent: true, sameTurnIteration: true, originalFilesRead: false, saved: false, testedAt: new Date().toISOString() }
  fs.mkdirSync(path.join(root, '.omc/artifacts'), { recursive: true }); fs.writeFileSync(path.join(root, '.omc/artifacts/codex-vision-real.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
}
run().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1 }).finally(async () => { clearTimeout(timeout); await client.shutdown(); win?.destroy(); fs.rmSync(scratch, { recursive: true, force: true }); app.exit(process.exitCode || 0) })
