/* Production UI, IPC, image preparation, domain tools, sidecar save and history.
 * Only the Codex service process is a synthetic in-memory JSON-RPC peer.
 * No real account, service request, OAuth or user photo is used. */
const { app, BrowserWindow, dialog, session } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto')
const assert = require('node:assert/strict'), { EventEmitter } = require('node:events'), { PassThrough, Writable } = require('node:stream')
const sharp = require('sharp')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..'), scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-chat-smoke-')))
const userData = path.join(scratch, 'user-data'), photos = path.join(scratch, 'photos'), artifacts = path.join(root, '.omc/artifacts')
for (const dir of [userData, photos, artifacts, path.join(userData, 'codex')]) fs.mkdirSync(dir, { recursive: true })
fs.writeFileSync(path.join(userData, 'codex/connection-state.json'), JSON.stringify({ version: 1, email: 'synthetic@example.test', planType: 'plus' }))
app.setPath('userData', userData)
const photo = path.join(photos, '합성-풍경.png'), reference = path.join(scratch, '참고-이미지.jpg'), sidecar = photo + '.lux.json'
let picker = photos, plan = 'edit', stage = 'startup', win, lastCode
const requests = [], toolReplies = [], screenshotReplies = [], network = [], rendererErrors = [], peers = []
require('./network-observer.cjs').observeNodeNetwork(event => network.push(event))
const observedSessions = new Set()
function observeSession(target) {
  if (observedSessions.has(target)) return
  observedSessions.add(target)
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    if (/^(?:https?|wss?):/.test(details.url)) network.push({ source: 'chromium', protocol: new URL(details.url).protocol })
    callback({ requestHeaders: details.requestHeaders })
  })
}
app.whenReady().then(() => observeSession(session.defaultSession))
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picker] })
class Peer extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); pid = 999999999; killed = false; toolIndex = 0
  constructor() {
    super(); this.stdin = new Writable({ write: (chunk, _encoding, done) => {
      const msg = JSON.parse(String(chunk)); queueMicrotask(() => { if (!this.killed) this.handle(msg) }); done()
    } })
  }
  reply(id, result) { this.stdout.write(JSON.stringify({ id, result }) + '\n') }
  notify(method, params) { this.stdout.write(JSON.stringify({ method, params }) + '\n') }
  kill() { if (!this.killed) { this.killed = true; queueMicrotask(() => { this.emit('exit', 0); this.emit('close', 0) }) } return true }
  tool(tool, args) {
    this.toolIndex++; const callId = `call-${this.toolIndex}`
    this.notify('item/started', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: callId, type: 'dynamicToolCall', tool, arguments: args, status: 'inProgress' } })
    this.stdout.write(JSON.stringify({ id: callId, method: 'item/tool/call', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', callId, tool, arguments: args } }) + '\n')
  }
  finish() {
    this.notify('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: this.plan === 'ask' ? '첨부한 합성 사진을 받았습니다. 변경은 제안하지 않았습니다.' : '요청한 변경을 제안했습니다. 적용 전후를 비교해 주세요.' } })
    this.notify('turn/completed', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } })
  }
  handle(msg) {
    if (msg.method === 'initialize') return this.reply(msg.id, { userAgent: 'codex/0.153.4' })
    if (msg.method === 'account/read') return this.reply(msg.id, { account: { type: 'chatgpt', email: 'synthetic@example.test', planType: 'plus' } })
    if (msg.method === 'model/list') return this.reply(msg.id, { data: [{ id: 'fixture-vision', model: 'fixture-vision', displayName: '검증용 이미지 모델', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'test high' }], defaultReasoningEffort: 'high' }, { id: 'fixture-text', model: 'fixture-text', displayName: '검증용 텍스트 모델', isDefault: false, inputModalities: ['text'], supportedReasoningEfforts: [] }], nextCursor: null })
    if (msg.method === 'thread/start') { this.definitions = msg.params.dynamicTools; return this.reply(msg.id, { thread: { id: 'fixture-thread' }, model: 'fixture-vision' }) }
    if (msg.method === 'turn/start') {
      this.plan = plan; requests.push({ input: msg.params.input, effort: msg.params.effort, model: msg.params.model, definitions: this.definitions })
      this.notify('turn/started', { threadId: 'fixture-thread', turn: { id: 'fixture-turn', items: [{ id: 'user-input', type: 'userMessage', content: msg.params.input }], status: 'inProgress' } })
      this.reply(msg.id, { turn: { id: 'fixture-turn', items: [{ id: 'user-input', type: 'userMessage', content: msg.params.input }] } })
      this.notify('item/completed', { threadId: 'fixture-thread', turnId: 'fixture-turn', item: { id: 'user-input', type: 'userMessage', content: msg.params.input } })
      if (this.plan !== 'slow') setTimeout(() => this.tool('luxinus_read_state', {}), 10)
      return
    }
    if (msg.method === 'turn/interrupt') return this.reply(msg.id, {})
    if (typeof msg.id === 'string' && msg.id.startsWith('call-')) {
      toolReplies.push(msg); assert.equal(msg.result?.success, true)
      if (this.plan === 'edit') {
        if (this.toolIndex === 1) return this.tool('luxinus_stage_edit', { patch: { exposure: 20, crop: { x: .1, y: .1, w: .75, h: .8 }, hsl: { blue: { sat: 12 } } }, reason: '밝기를 높이고 자르기와 파란색 채도를 조정합니다.' })
        if (this.toolIndex === 2) return this.tool('luxinus_create_mask', { name: '중앙 밝기', kind: 'radial', radial: { cx: .5, cy: .5, rx: .3, ry: .3, feather: .4, invert: false }, adjust: { exposure: 12 }, reason: '중앙 부분 보정' })
        if (this.toolIndex === 3) {
          this.maskId = JSON.parse(msg.result.contentItems[0].text).edit.values.masks[0].id
          return this.tool('luxinus_screenshot', { target: 'staged', overlayMaskId: this.maskId })
        }
        if (this.toolIndex === 4 || this.toolIndex === 7) {
          const image = msg.result.contentItems.find(item => item.type === 'inputImage')
          assert.ok(image?.imageUrl.startsWith('data:image/jpeg;base64,'), 'Screenshot must be actual official image content')
          screenshotReplies.push(image.imageUrl)
        }
        if (this.toolIndex === 4) return this.tool('luxinus_update_mask', { maskId: this.maskId, patch: { adjust: { exposure: 6 } }, reason: '미리보기를 확인하고 부분 밝기를 완화합니다.' })
        if (this.toolIndex === 5) return this.tool('luxinus_stage_edit', { patch: { exposure: 25 }, reason: '미리보기 후 전체 밝기를 조정합니다.' })
        if (this.toolIndex === 6) return this.tool('luxinus_screenshot', { target: 'staged' })
      }
      if (this.toolIndex === 1 && this.plan === 'action') return this.tool('luxinus_stage_actions', { actions: [{ kind: 'setBackground', background: 'light' }], reason: '사진 배경을 밝게 바꿉니다.' })
      return this.finish()
    }
    if (msg.method && msg.id !== undefined) throw new Error(`Unexpected protocol request: ${msg.method}`)
  }
}
const cp = require('node:child_process'), spawn = cp.spawn
cp.spawn = (command, ...args) => { if (path.basename(command) === 'codex' || path.basename(command) === 'codex.exe') { const peer = new Peer(); peers.push(peer); return peer } return spawn(command, ...args) }
app.on('web-contents-created', (_event, contents) => {
  observeSession(contents.session)
  contents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message) })
})
const fixture = Promise.all([
  sharp(Buffer.from('<svg width="640" height="400"><rect width="640" height="400" fill="#405f85"/><circle cx="440" cy="130" r="76" fill="#e9b675"/><path d="M0 400L180 90L360 400Z" fill="#274b39"/></svg>')).png().toFile(photo),
  sharp(crypto.randomBytes(1800 * 1200 * 3), { raw: { width: 1800, height: 1200, channels: 3 } }).withMetadata({ exif: { IFD0: { Artist: 'private-fixture-author' } } }).jpeg().toFile(reference)
])
require(path.join(root, 'out/main/index.js'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const deadline = setTimeout(() => { console.error(`Chat deadline: ${stage}`); app.exit(1) }, 90000)
async function run() {
  await app.whenReady(); await fixture
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows().find(w => w.isVisible()); if (win) break; await sleep(100) }
  assert.ok(win)
  // Keep verification renders running while the user focuses another Mac app.
  win.webContents.setBackgroundThrottling(false)
  const originalHash = hash(photo), refHash = hash(reference)
  const js = async code => { lastCode = code; const result = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await(async()=>{${code}})()}}catch(error){return {error:error.stack??String(error)}}})()`); if (result.error) throw Error(`${stage}: ${result.error}`); return result.value }
  const wait = async condition => { for (let i = 0; i < 160; i++) { if (await js(`return (${condition})`)) return; await sleep(50) } throw Error(`${stage} timed out ${condition}\n${await js('return document.body.innerText')}`) }
  const click = label => js(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&x.getClientRects().length);if(!b||b.matches(':disabled'))throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()`)
  const input = text => js(`const e=document.getElementById('agent-chat-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}))`)
  const select = (label, value) => js(`const e=document.querySelector('select[aria-label="${label}"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}))`)
  const mark = value => { stage = value; console.log(`[chat-smoke] ${stage}`) }
  const paint = () => js('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const shot = async name => { await paint(); fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG()) }
  await wait('!!document.querySelector(".lx-agent-panel")')
  assert.equal(peers.length, 0, 'Startup must not launch Codex')
  await click('폴더 열기'); await wait('!!document.querySelector(".lx-thumbnail-image img")')
  await click('사진 편집'); await wait('!!document.querySelector(".lx-stage canvas")')
  await click('GPT Codex'); await wait('!document.querySelector(".lx-agent-options").innerText.includes("ChatGPT 로그인")')
  assert.equal(peers.length, 0, 'Passive Codex state must not launch a service')
  mark('explicit model list and metadata-free attachments')
  await click('목록 불러오기'); await wait('document.querySelectorAll(".lx-agent-model option").length===3')
  await select('Codex 모델 선택', 'fixture-vision')
  await js('document.querySelector(".lx-agent-advanced").open=true')
  await select('Codex 추론 강도', 'high')
  picker = reference; await click('참고 이미지 +'); await wait('document.querySelectorAll(".lx-agent-composer .lx-agent-attachment").length===1')
  assert.equal(await js('return document.querySelector(".lx-agent-current input").checked'), true)
  await wait('document.querySelector(".lx-agent-target img")?.alt === "보낼 현재 사진 · 보정 반영"')
  win.setSize(1024, 768); await sleep(150)
  for (const count of [2, 3]) { await click('참고 이미지 +'); await wait(`document.querySelectorAll(".lx-agent-composer .lx-agent-attachment").length===${count}`) }
  const advancedLayout = await js('const p=document.querySelector(".lx-agent-panel"),c=document.querySelector(".lx-agent-composer"),o=document.querySelector(".lx-agent-options");return {bodyOverflow:document.body.scrollHeight>innerHeight,composerBottom:c.getBoundingClientRect().bottom,panelBottom:p.getBoundingClientRect().bottom,horizontal:p.scrollWidth>p.clientWidth,advancedScrollable:o.scrollHeight>o.clientHeight}')
  assert.equal(advancedLayout.bodyOverflow, false); assert.equal(advancedLayout.horizontal, false); assert.ok(advancedLayout.composerBottom<=advancedLayout.panelBottom+1)
  await shot('electron-chat-advanced-1024.png')
  for (const count of [2, 1]) { await js('[...document.querySelectorAll(".lx-agent-composer .lx-agent-attachment button")].at(-1).click()'); await wait(`document.querySelectorAll(".lx-agent-composer .lx-agent-attachment").length===${count}`) }
  win.setSize(1440, 900); await sleep(150)
  await select('Codex 모델 선택', 'fixture-text'); await input('보정해줘')
  assert.equal(await js('return document.querySelector(".lx-agent-send").disabled'), true)
  await select('Codex 모델 선택', 'fixture-vision'); await select('Codex 추론 강도', 'high')
  await js('document.querySelector(".lx-agent-advanced").open=false')
  await input('밝기를 높이고 가운데를 잘라서 파란색 채도를 조정해줘')
  await click('보내기'); await wait('!!document.querySelector(".lx-agent-apply")')
  assert.equal(fs.existsSync(sidecar), false, 'Proposal cannot write sidecar')
  const sent = requests.at(-1)
  assert.ok(Buffer.byteLength(JSON.stringify(sent.input)) > 1048576, 'Image echo must exercise the old one-MiB boundary')
  assert.equal(sent.input.filter(i => i.type === 'image').length, 2); assert.equal(sent.effort, 'high'); assert.equal(sent.model, 'fixture-vision')
  for (const image of sent.input.filter(i => i.type === 'image')) { const meta = await sharp(Buffer.from(image.url.split(',')[1], 'base64')).metadata(); assert.ok(meta.width <= 1536 && meta.height <= 1536); assert.equal(meta.exif, undefined) }
  assert.ok(!JSON.stringify(sent).includes(photos)); assert.ok(!JSON.stringify(sent).includes('private-fixture-author')); assert.ok(!JSON.stringify(sent).includes('참고-이미지.jpg'))
  assert.equal(screenshotReplies.length, 2, 'One turn must use actual screenshot results then continue editing')
  for (const screenshot of screenshotReplies) { const meta = await sharp(Buffer.from(screenshot.split(',')[1], 'base64')).metadata(); assert.equal(meta.width, 480); assert.equal(meta.height, 320); assert.equal(meta.exif, undefined) }
  assert.notEqual(screenshotReplies[0], screenshotReplies[1])
  const progressImages = await js('return [...document.querySelectorAll(".lx-agent-activity img")].map(image=>({src:image.src,width:image.naturalWidth,height:image.naturalHeight}))')
  assert.equal(progressImages.length, 2); assert.ok(progressImages.every(image=>image.width<=384&&image.height<=384))
  mark('actual preview, approved sidecar, one Undo and redo')
  const histogramBefore = await js('return document.querySelector(".lx-edit-panel .lx-groove svg").innerHTML')
  await click('적용 전'); await wait('!!document.querySelector("[data-agent-comparison=before]")'); await paint()
  const before = await js('return document.querySelector("[data-agent-comparison-layer=before] canvas").toDataURL()')
  await click('적용 후'); await wait('!!document.querySelector("[data-agent-comparison=after]")'); await paint()
  const after = await js('return document.querySelector("[data-agent-comparison-layer=after] canvas").toDataURL()')
  await sleep(250); assert.equal(await js('return document.querySelector(".lx-edit-panel .lx-groove svg").innerHTML'), histogramBefore, 'Snapshot comparison must not replace current edit histogram')
  assert.notEqual(before, after); assert.equal(fs.existsSync(sidecar), false)
  await click('나란히 비교'); await wait('!!document.querySelector("[data-agent-comparison=split]")'); await shot('electron-chat-compare-1440.png')
  await click('제안 적용'); await wait('document.querySelector(".lx-agent-message[data-role=assistant]").innerText.includes("적용 완료")')
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.exposure, 25); assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.hsl.blue.sat, 12)
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.masks[0].adjust.exposure, 6)
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"z",metaKey:true,bubbles:true,cancelable:true}))')
  for (let i = 0; i < 100 && JSON.parse(fs.readFileSync(sidecar)).edits.exposure !== 0; i++) await sleep(50)
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.exposure, 0); assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.crop, null)
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.masks.length, 0)
  await js('document.body.dispatchEvent(new KeyboardEvent("keydown",{key:"z",ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))')
  for (let i = 0; i < 100 && JSON.parse(fs.readFileSync(sidecar)).edits.exposure !== 25; i++) await sleep(50)
  assert.equal(JSON.parse(fs.readFileSync(sidecar)).edits.exposure, 25)
  await click('나란히 비교'); await wait('!!document.querySelector("[data-agent-comparison=split]")')
  win.setSize(1024, 768); await sleep(150); await shot('electron-chat-compare-1024.png')
  const layout = await js('const p=document.querySelector(".lx-agent-panel"),s=document.querySelector(".lx-stage"),r=p.getBoundingClientRect(),t=s.getBoundingClientRect();return {panelOverflow:p.scrollWidth>p.clientWidth,rootOverflow:document.body.scrollWidth>innerWidth,stageWidth:t.width,notOverlapping:r.right<=t.left,composerVisible:document.querySelector(".lx-agent-send").getBoundingClientRect().bottom<innerHeight}')
  assert.equal(layout.panelOverflow, false); assert.equal(layout.rootOverflow, false); assert.equal(layout.notOverlapping, true); assert.equal(layout.composerVisible, true); assert.ok(layout.stageWidth > 600)
  await click('현재 편집으로 돌아가기')
  mark('attachment renderer includes restoration strength and rejects missing restoration')
  const captureBundle = esbuild.buildSync({ stdin: { contents: 'export {renderAgentImage} from "./src/renderer/src/lib/agentImage"; export {defaultEditState} from "./src/shared/edits"', resolveDir: root }, bundle: true, platform: 'browser', format: 'iife', globalName: 'agentImageFixture', write: false }).outputFiles[0].text
  await win.webContents.executeJavaScript(captureBundle)
  const capture = await js(`
    const c=document.createElement('canvas');c.width=32;c.height=24;const ctx=c.getContext('2d');
    ctx.fillStyle='#cc2222';ctx.fillRect(0,0,32,24);const source=c.toDataURL();
    ctx.fillStyle='#2255cc';ctx.fillRect(0,0,32,24);const restored=c.toDataURL();
    const e=agentImageFixture.defaultEditState();
    const base=await agentImageFixture.renderAgentImage(source,e,null);
    const full=await agentImageFixture.renderAgentImage(source,{...e,denoise:100},restored);
    const half=await agentImageFixture.renderAgentImage(source,{...e,denoise:50},restored);
    let missingRejected=false;try{await agentImageFixture.renderAgentImage(source,{...e,denoise:60},null)}catch{missingRejected=true}
    return {base,full,half,missingRejected}
  `)
  const averages = async value => (await sharp(Buffer.from(value.split(',')[1], 'base64')).stats()).channels.slice(0, 3).map(c => c.mean)
  const basePixels = await averages(capture.base), restoredPixels = await averages(capture.full), blendedPixels = await averages(capture.half)
  assert.ok(basePixels[0] > basePixels[2] + 100); assert.ok(restoredPixels[2] > restoredPixels[0] + 100)
  for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(blendedPixels[channel] - (basePixels[channel] + restoredPixels[channel]) / 2) < 5)
  assert.equal(capture.missingRejected, true)
  mark('read-only chat, history, actual app action and cancellation')
  plan = 'ask'; await js('document.querySelector(".lx-agent-advanced").open=true'); await select('AI 작업 방식', 'ask'); await js('document.querySelector(".lx-agent-advanced").open=false')
  await input('어떤 작업을 할 수 있어?'); await click('보내기'); await wait('document.querySelector(".lx-agent-conversation").innerText.includes("변경은 제안하지 않았습니다")')
  const editedImage = requests.at(-1).input.find(i => i.type === 'image')
  assert.ok(editedImage, 'Current photo must be included automatically again in a follow-up')
  const editedMeta = await sharp(Buffer.from(editedImage.url.split(',')[1], 'base64')).metadata()
  assert.equal(editedMeta.width, 480); assert.equal(editedMeta.height, 320, 'Attachment includes saved crop')
  const initialImage = sent.input.find(i => i.type === 'image')
  const initialMeta = await sharp(Buffer.from(initialImage.url.split(',')[1], 'base64')).metadata()
  assert.equal(initialMeta.width, 640); assert.equal(initialMeta.height, 400)
  assert.notEqual(initialImage.url, editedImage.url, 'Follow-up must use the newly edited image')
  assert.match(requests.at(-1).input[0].text, /보정 반영 축소본/)
  assert.ok(requests.at(-1).definitions.some(tool=>tool.name==='luxinus_screenshot'))
  assert.ok(requests.at(-1).definitions.every(tool=>['luxinus_read_state','luxinus_list_photos','luxinus_screenshot','luxinus_analyze_people'].includes(tool.name))); assert.ok(requests.at(-1).input[0].text.includes('밝기를 높이고 가운데'))
  await js('document.querySelector(".lx-agent-current input").click()')
  plan = 'action'; await js('document.querySelector(".lx-agent-advanced").open=true'); await select('AI 작업 방식', 'propose'); await js('document.querySelector(".lx-agent-advanced").open=false')
  await input('사진 배경을 밝게 해줘'); await click('보내기'); await wait('!!document.querySelector(".lx-agent-apply")'); await click('제안 적용')
  await wait('getComputedStyle(document.querySelector(".lx-stage")).backgroundColor === "rgb(170, 170, 170)"')
  assert.equal(requests.at(-1).input.filter(i => i.type === 'image').length, 0, 'Unchecked current photo sends no image')
  assert.equal(requests.at(-1).definitions.some(tool=>/screenshot|analyze/.test(tool.name)), false, 'Opt-out must remove every current-photo disclosure tool')
  plan = 'slow'; await input('취소할 요청'); await click('보내기'); await wait('document.querySelector(".lx-agent-send").textContent==="중단"'); await sleep(100); await click('중단'); await wait('!document.getElementById("agent-chat-prompt").disabled')
  assert.ok(peers.every(peer => peer.killed)); assert.equal(network.length, 0); assert.equal(rendererErrors.length, 0); assert.equal(hash(photo), originalHash); assert.equal(hash(reference), refHash)
  const report = { scratch, service: 'synthetic JSON-RPC peer; no real account or remote inference', production: ['renderer', 'preload', 'Codex client', 'dynamic tool dispatch', 'attachment picker/encoding', 'proposal approval', 'sidecar save', 'undo/redo', 'app actions'], currentAndReferenceImages: 2, automaticCurrentPhoto: true, freshEditedCropOnFollowup: [480, 320], imageOptOutVerified: true, restorationAttachment: { basePixels, restoredPixels, blendedPixels, missingRejected: capture.missingRejected }, maxDimension: 1536, metadataStripped: true, largeImageEcho: true, noSourcePathsInModelInput: true, proposalDoesNotWrite: true, pixelComparison: true, wholeEditUndoRedo: true, readonlyAskTools: true, histogramStableDuringComparison: true, advancedLayout, contextHistory: true, actualBackgroundAction: true, canceled: true, layout, network, rendererErrors, originalsUnchanged: true }
  Object.assign(report, { sameTurnScreenshotIterations: 2, actualScreenshotImageContent: true, scopedVisionTools: true, maskStageAndUpdate: true, toolThumbnailsMaxEdge: 384 })
  fs.writeFileSync(path.join(artifacts, 'electron-chat-smoke.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); clearTimeout(deadline); app.quit()
}
run().catch(async error => { console.error(error.stack); console.error({ stage, lastCode }); if (win) { fs.writeFileSync(path.join(artifacts, 'electron-chat-failure.png'), (await win.webContents.capturePage()).toPNG()); fs.writeFileSync(path.join(artifacts, 'electron-chat-failure.txt'), await win.webContents.executeJavaScript('document.body.innerText').catch(() => 'unavailable')) } clearTimeout(deadline); app.exit(1) })
