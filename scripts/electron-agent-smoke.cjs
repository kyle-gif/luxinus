/* Actual local language model + Electron UI integration, synthetic files only.
 * First run: electron scripts/electron-agent-smoke.cjs --runtime PATH --model PATH
 * Fresh-process persistence check: electron scripts/electron-agent-smoke.cjs --resume SCRATCH
 * No model mocks, account changes or automatic downloads. */
const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const argument = (name) => process.argv[process.argv.indexOf(name) + 1]
const resume = process.argv.includes('--resume') ? argument('--resume') : null
const runtime = process.argv.includes('--runtime') ? argument('--runtime') : null
const model = process.argv.includes('--model') ? argument('--model') : null
if (!resume && (!runtime || !model)) throw new Error('--runtime and --model are required')
if (resume && !path.basename(resume).startsWith('luxinus-agent-smoke-')) throw new Error('Only a harness scratch directory can be resumed')
const root = path.resolve(__dirname, '..')
const scratch = fs.realpathSync(resume ?? fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-agent-smoke-')))
const photos = path.join(scratch, 'photos'), userData = path.join(scratch, 'user-data')
const photo = path.join(photos, '한국어-보정-검증.png'), sidecar = photo + '.lux.json'
const xmp = path.join(scratch, '검토.xmp')
const originalXml = '\uFEFF<x:xmpmeta xmlns:x="adobe:ns:meta/">\r\n<!--보존할 주석--><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:custom="urn:fixture" crs:Exposure2012="0" custom:keep="untouched"/></rdf:RDF>\r\n</x:xmpmeta>'
for (const directory of [photos, userData]) fs.mkdirSync(directory, { recursive: true })
app.setPath('userData', userData)
const artifacts = path.join(root, '.omc/artifacts')
fs.mkdirSync(artifacts, { recursive: true })
let picker = photos, stage = 'startup'
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picker] })
let saveDelayMs = 0, proposalCalls = 0
const registerHandler = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => registerHandler(channel, async (...args) => {
  if (channel === 'localAgent:propose' || channel === 'localAgent:chat') proposalCalls++
  // Only delay the real save handler to expose the UI's pre-inference race.
  // Its validation and disk write still run; no model response is mocked.
  if (channel === 'edits:save' && saveDelayMs) await new Promise(resolve => setTimeout(resolve, saveDelayMs))
  return listener(...args)
})
const consoleErrors = []
app.on('web-contents-created', (_event, contents) => {
  contents.on('console-message', (_event, level, message) => { if (level >= 3) consoleErrors.push(message) })
})
const fixtureReady = resume ? Promise.resolve() : (async () => {
  await sharp(Buffer.from('<svg width="320" height="200"><rect width="320" height="200" fill="#273547"/><circle cx="220" cy="65" r="38" fill="#cc9b72"/><path d="M0 200L0 120L90 55L175 200Z" fill="#0d2418"/></svg>')).png().toFile(photo)
  fs.writeFileSync(xmp, originalXml)
})()
require(path.join(root, 'out/main/index.js'))
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
async function run() {
  await app.whenReady(); await fixtureReady
  let win
  for (let i = 0; i < 150; i++) { win = BrowserWindow.getAllWindows().find(w => w.isVisible()); if (win) break; await sleep(100) }
  assert.ok(win, 'Visible main window required')
  const js = async (code) => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await(async()=>{${code}})()}}catch(error){return {error:error.stack??String(error)}}})()`)
    if (result.error) throw new Error(`${stage}: ${result.error}`)
    return result.value
  }
  const wait = async (condition, timeout = 15000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) { if (await js(`return (${condition})`)) return; await sleep(100) }
    throw new Error(`${stage}: timed out: ${condition}\n${await js('return document.body.innerText')}`)
  }
  const click = async (text) => js(`const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)}&&x.getClientRects().length);if(!button||button.matches(':disabled'))throw Error('Button absent or disabled: '+${JSON.stringify(text)});button.focus();button.click()`)
  const prompt = async text => js(`const textarea=document.querySelector('#agent-chat-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(text)});textarea.dispatchEvent(new Event('input',{bubbles:true}))`)
  const closeAgent = async () => js(`document.querySelector('[aria-label="AI 채팅 닫기"]')?.click()`)
  const key = async (value, modifiers = {}) => js(`document.body.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(value)},bubbles:true,...${JSON.stringify(modifiers)}}))`)
  const paint = async () => { await js('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await sleep(150) }
  const snapshot = async (name) => { await paint(); fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG()) }
  const photoSample = async () => {
    await paint()
    // EditCanvas keeps its drawing buffer, so this reads actual shader pixels
    // without modal backdrops or screenshot overlays changing the comparison.
    return crypto.createHash('sha256').update(await js('return document.querySelector(".lx-stage canvas").toDataURL()')).digest('hex')
  }
  const mark = (name) => { stage = name; console.log(`[agent-smoke] ${name}`) }
  await wait('!!window.luxinus && !!document.querySelector(".lx-topbar")')
  await closeAgent()
  const originalHash = hash(photo)
  mark('select synthetic photo')
  await click('폴더 열기')
  await wait('!!document.querySelector(".lx-thumbnail-image img")')
  await js(`document.querySelector('.lx-thumbnail').click()`)
  await click('사진 편집')
  await click('전체 보정')
  await wait('!!document.querySelector(`[role=slider][aria-label="어두운 부분"]`)')
  if (resume) {
    mark('fresh process persisted state')
    const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits
    assert.equal(saved.shadows, 20); assert.equal(saved.exposure, 1)
    await wait('document.querySelector(`[role=slider][aria-label="어두운 부분"]`).getAttribute("aria-valuenow")==="20"')
    const status = await js('return window.luxinus.localAgent.status()')
    assert.equal(status.phase, 'untested'); assert.equal(status.lastTest, null)
    assert.ok(status.runtimePath && status.modelPath)
    assert.equal(hash(photo), JSON.parse(fs.readFileSync(path.join(scratch, 'original-hash.json'))).hash)
    await snapshot('electron-agent-restart.png')
    const report = { scratch, freshProcess: true, savedShadows: saved.shadows, savedExposure: saved.exposure, modelRequiresFreshTest: true, originalUnchanged: true }
    fs.writeFileSync(path.join(artifacts, 'electron-agent-restart.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report))
    app.quit(); return
  }
  fs.writeFileSync(path.join(scratch, 'original-hash.json'), JSON.stringify({ hash: originalHash }))
  mark('select verified runtime and model via real IPC')
  picker = runtime; await js('return window.luxinus.localAgent.pickRuntime()')
  picker = model; await js('return window.luxinus.localAgent.pickModel()')
  await click('AI 설정')
  await wait('!!document.querySelector("#models-title")')
  await wait('[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="모델 실행 확인"&&!x.disabled)')
  mark('actual Korean model smoke through UI')
  const smokeStartedAt = Date.now()
  await click('모델 실행 확인')
  await wait('[...document.querySelectorAll("[role=status]")].some(x=>x.textContent.trim()==="사용 가능")', 210000)
  const status = await js('return window.luxinus.localAgent.status()')
  assert.equal(status.phase, 'ready'); assert.equal(status.lastTest.structuredOutput, true)
  assert.ok(Date.parse(status.lastTest.at) >= smokeStartedAt, 'Fresh actual smoke timestamp required')
  await wait('[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="모델 실행 확인"&&!x.disabled)')
  win.setSize(1024, 768)
  await snapshot('electron-model-ready.png')
  assert.equal(await js('const d=document.querySelector("[role=dialog]");return d.scrollWidth>d.clientWidth'), false)
  assert.equal(await js('const c=[...document.querySelectorAll("[role=dialog] button:not(:disabled),[role=dialog] textarea:not(:disabled)")].filter(x=>x.getClientRects().length);c.at(-1).focus();c.at(-1).dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",bubbles:true,cancelable:true}));return document.activeElement===c[0]'), true)
  await js('document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))')
  await wait('!document.querySelector("#models-title")')
  assert.equal(await js('return document.activeElement.textContent.trim()'), 'AI 설정')
  win.setSize(1440, 900)
  mark('unsupported arithmetic is rejected by the real IPC boundary')
  for (const prompt of ['노출을 +0.5EV 올려줘', '그림자를 지금보다 10 더 밝게 해줘']) {
    const error = await js(`try{await window.luxinus.localAgent.propose({requestId:crypto.randomUUID(),photoId:${JSON.stringify(photo)},baseEdit:{},prompt:${JSON.stringify(prompt)}});return null}catch(error){return String(error)}`)
    assert.match(error, /현재 지원 범위 밖의 요청/)
  }
  mark('an absolute numeric request absent from prompt examples')
  const heldOut = await js(`return window.luxinus.localAgent.propose({requestId:crypto.randomUUID(),photoId:${JSON.stringify(photo)},baseEdit:{},prompt:'대비를 17로 설정해줘. 다른 값은 그대로 둬.'})`)
  assert.deepEqual(heldOut.patch, { contrast: 17 })
  assert.equal(fs.existsSync(sidecar), false)
  mark('Korean request and structured proposal')
  await key('k', { metaKey: true })
  await wait('!!document.querySelector("#agent-chat-prompt")?.getClientRects().length')
  const basePixels = await photoSample()
  await prompt('어두운 부분 값을 정확히 20으로 바꿔줘. 다른 항목은 바꾸지 마.')
  await wait('!document.querySelector(".lx-agent-send").disabled')
  await click('보내기')
  await wait('!!document.querySelector(".lx-agent-apply")', 210000)
  assert.equal(await js('return document.querySelector(".lx-agent-plan tbody").innerText.replace(/\\s+/g," ").trim()'), '어두운 부분 0 20')
  assert.equal(fs.existsSync(sidecar), false, 'Proposal must not save a sidecar')
  await snapshot('electron-agent-proposal.png')
  const proposalPixels = await photoSample()
  assert.equal(proposalPixels, basePixels, 'Unapproved proposal does not change the photo')
  await click('적용 후'); await wait('!!document.querySelector("[data-agent-comparison=after]")'); await sleep(500)
  assert.equal(fs.existsSync(sidecar), false, 'Preview must not save a sidecar')
  assert.notEqual(await photoSample(), basePixels, 'Preview changes the displayed photo sample')
  await snapshot('electron-agent-preview.png')
  await click('현재 편집으로 돌아가기'); await wait('!document.querySelector("[data-agent-comparison]")')
  assert.equal(fs.existsSync(sidecar), false, 'Cancel preview must leave disk untouched')
  assert.equal(await photoSample(), basePixels, 'Clearing preview restores the displayed photo')
  mark('approve, save, Undo and Redo')
  await click('제안 적용')
  await wait('document.querySelector(".lx-agent-conversation").innerText.includes("적용 완료")')
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits.shadows, 20)
  await closeAgent(); await key('z', { metaKey: true })
  await wait('document.querySelector(`[role=slider][aria-label="어두운 부분"]`).getAttribute("aria-valuenow")==="0"')
  await sleep(700)
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits.shadows, 0)
  await key('z', { metaKey: true, shiftKey: true }); await sleep(700)
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits.shadows, 20)
  mark('cancel before inference while real sidecar save is delayed')
  const callsBeforeCancel = proposalCalls
  saveDelayMs = 1800
  await js(`document.querySelector('[role=slider][aria-label=노출]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  await key('k', { metaKey: true })
  await wait('!!document.querySelector("#agent-chat-prompt")?.getClientRects().length')
  await prompt('어두운 부분을 25로 설정해줘. 다른 값은 유지해줘.')
  await wait('!document.querySelector(".lx-agent-send").disabled')
  await click('보내기')
  await wait('document.querySelector(".lx-agent-composer").innerText.includes("현재 보정을 저장하는 중")')
  await click('중단')
  await wait('document.querySelector(".lx-agent-composer").innerText.includes("요청을 중단했습니다")')
  assert.equal(proposalCalls, callsBeforeCancel, 'Canceled preparation cannot start a model request')
  saveDelayMs = 0
  await closeAgent(); await key('z', { metaKey: true }); await sleep(700)
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits.exposure, 0)
  mark('XMP review, approve, original-byte undo through real IPC')
  picker = xmp
  const review = await js('return window.luxinus.xmp.open()')
  const proposal = await js(`return window.luxinus.xmp.propose(${JSON.stringify(review.documentId)},{Exposure2012:1.25})`)
  assert.equal(fs.readFileSync(xmp, 'utf8'), originalXml)
  const applied = await js(`return window.luxinus.xmp.apply(${JSON.stringify(proposal.proposalId)})`)
  assert.equal(fs.readFileSync(xmp, 'utf8'), originalXml.replace('crs:Exposure2012="0"', 'crs:Exposure2012="1.25"'))
  await js(`return window.luxinus.xmp.undo(${JSON.stringify(applied.operationId)})`)
  assert.equal(fs.readFileSync(xmp, 'utf8'), originalXml)
  mark('close immediately during debounced save')
  await js(`document.querySelector('[role=slider][aria-label=노출]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`)
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Save-aware close timed out')), 18000)
    win.once('closed', () => { clearTimeout(timeout); resolve() })
  })
  win.close(); await closed
  assert.equal(JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits.exposure, 1)
  assert.equal(hash(photo), originalHash)
  assert.equal(consoleErrors.length, 0, consoleErrors.join('\n'))
  const report = { scratch, runtime, model, actualKoreanSmoke: status.lastTest, heldOutAbsolutePatch: heldOut.patch, unsupportedArithmeticRejected: true, structuredProposal: { shadows: 20 }, modelModal1024FocusAndEscape: true, previewDiskUnchanged: true, previewPixelsChangedAndRestored: true, approveSaveUndoRedo: true, cancelDuringDelayedSavePreventsInference: true, closeFlushedPendingSave: true, xmpBytePreservingApplyUndo: true, originalUnchanged: true, consoleErrors }
  fs.writeFileSync(path.join(artifacts, 'electron-agent-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report)); app.quit()
}
run().catch(error => {
  console.error(stage, error)
  fs.writeFileSync(path.join(artifacts, 'electron-agent-smoke-error.txt'), `${stage}\n${error.stack}`)
  app.exit(1)
})
