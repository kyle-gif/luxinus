/* Electron provider UI verification, synthetic files and isolated userData.
 * Startup/status use production IPC and local CLI discovery. Subsequent account
 * responses are explicitly simulated; no real login, Codex process or service
 * inference runs. This is UI evidence, never account/service validation. */
const { app, BrowserWindow, dialog, ipcMain, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const sharp = require('sharp')
const root = path.resolve(__dirname, '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-codex-ui-smoke-')))
const userData = path.join(scratch, 'user-data'), photos = path.join(scratch, 'photos')
const artifacts = path.join(root, '.omc/artifacts')
for (const dir of [userData, photos, artifacts]) fs.mkdirSync(dir, { recursive: true })
app.setPath('userData', userData)
const photo = path.join(photos, '합성-사진.png')
const fixtureReady = sharp(Buffer.from('<svg width="320" height="200"><rect width="320" height="200" fill="#425968"/><circle cx="220" cy="65" r="38" fill="#d5ab7e"/><path d="M0 200L90 45L180 200Z" fill="#214a38"/></svg>')).png().toFile(photo)
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let stage = 'startup', activeWindow, lastCode, simulated = false
let picker = photos, pendingPicker = null, heldStatus = null
let account = null
const calls = { productionStatus: 0, status: 0, login: 0, cancel: 0, cancelIds: [], ignoredCancels: 0, logout: 0, providerInputs: [] }
const networkEvents = [], unexpectedSpawns = [], rendererErrors = []
require('./network-observer.cjs').observeNodeNetwork(event => networkEvents.push({ source: 'node', ...event }))
// Test guard only: any unexpected process attempt fails instead of logging in.
require('node:child_process').spawn = (...args) => { unexpectedSpawns.push(String(args[0])); throw new Error('This UI harness must not start any child process') }
const observedSessions = new Set()
function observe(target) {
  if (observedSessions.has(target)) return
  observedSessions.add(target)
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    if (/^(?:https?|wss?):/.test(details.url)) networkEvents.push({ source: 'chromium', protocol: new URL(details.url).protocol })
    callback({ requestHeaders: details.requestHeaders })
  })
}
app.whenReady().then(() => observe(session.defaultSession))
app.on('web-contents-created', (_event, contents) => {
  observe(contents.session)
  contents.on('console-message', (_event, level, message) => { if (level >= 3) rendererErrors.push(message) })
})
dialog.showOpenDialog = async () => pendingPicker ? new Promise(resolve => { pendingPicker.resolve = resolve }) : ({ canceled: false, filePaths: [picker] })
const originalHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, listener) => originalHandle(channel, async (event, ...args) => {
  if (channel === 'codex:status' && !simulated) calls.productionStatus++
  if (simulated && channel.startsWith('codex:')) {
    if (channel === 'codex:status') {
      calls.status++
      if (heldStatus) {
        const deferred = heldStatus, captured = { ...account }
        heldStatus = null
        return new Promise(resolve => { deferred.release = () => resolve(captured) })
      }
    }
    if (channel === 'codex:login') {
      calls.login++
      account = { ...account, phase: 'signing-in', loginId: `synthetic-login-${calls.login}`, message: '검증용 로그인 진행 중' }
    } else if (channel === 'codex:cancelLogin') {
      calls.cancelIds.push(args[0] ?? null)
      if (args[0] && args[0] !== account.loginId) { calls.ignoredCancels++; return { ...account } }
      calls.cancel++; account = { ...account, phase: 'signed-out', loginId: null, email: null, planType: null, message: '검증용 로그인을 취소했습니다.' }
    } else if (channel === 'codex:logout') {
      calls.logout++; account = { ...account, phase: 'signed-out', loginId: null, email: null, planType: null, message: '검증용 로그아웃 완료' }
    } else if (channel !== 'codex:status') throw new Error(`Unexpected account operation: ${channel}`)
    return { ...account }
  }
  if (simulated && channel === 'localAgent:chat') {
    calls.providerInputs.push({ provider: args[0].provider, requestId: args[0].requestId })
    throw new Error('검증용: 실제 AI 요청을 실행하지 않았습니다.')
  }
  return listener(event, ...args)
})
require(path.join(root, 'out/main/index.js'))
const deadline = setTimeout(() => { console.error(`UI deadline: ${stage}`); app.exit(1) }, 60000)
async function run() {
  await app.whenReady(); await fixtureReady
  for (let i = 0; i < 100; i++) { activeWindow = BrowserWindow.getAllWindows().find(window => window.isVisible()); if (activeWindow) break; await sleep(100) }
  assert.ok(activeWindow)
  const win = activeWindow, originalHash = hash(photo)
  const js = async code => {
    lastCode = code
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await(async()=>{${code}})()}}catch(error){return {error:error.stack??String(error)}}})()`)
    if (result.error) throw new Error(`${stage}: ${result.error}`)
    return result.value
  }
  async function wait(condition) {
    for (let i = 0; i < 120; i++) { if (await js(`return (${condition})`)) return; await sleep(100) }
    throw new Error(`${stage}: timed out: ${condition}\n${await js('return document.body.innerText')}`)
  }
  async function waitMain(condition) {
    for (let i = 0; i < 100; i++) { if (condition()) return; await sleep(10) }
    throw new Error(`${stage}: main-process condition timed out`)
  }
  const click = label => js(`const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&x.getClientRects().length);if(!button||button.matches(':disabled'))throw Error('Button absent or disabled: '+${JSON.stringify(label)});button.click()`)
  const provider = value => js(`const radio=document.querySelector('input[name="ai-provider"][value=${value}]');if(!radio||radio.matches(':disabled'))throw Error('Provider is not selectable');radio.click()`)
  const panelProvider = value => click(value === 'codex' ? 'GPT Codex' : '로컬 모델')
  const closeAgent = () => js(`document.querySelector('[aria-label="AI 채팅 닫기"]')?.click()`)
  const openAgent = async () => { await js(`document.dispatchEvent(new CustomEvent('luxinus:agent-open'))`); await wait('!!document.querySelector("#agent-chat-prompt")?.getClientRects().length') }
  const prompt = text => js(`const input=document.querySelector('#agent-chat-prompt');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))`)
  const key = (key, modifiers = {}) => js(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true,...${JSON.stringify(modifiers)}}))`)
  const snapshot = async name => {
    await js('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
    const bytes = (await win.webContents.capturePage()).toPNG(); assert.ok(bytes.length > 1000)
    fs.writeFileSync(path.join(artifacts, name), bytes)
  }
  const focusAndLayout = () => js(`const modal=document.querySelector('[role=dialog]');const buttons=[...modal.querySelectorAll('button,input,select,textarea,[tabindex="0"]')].filter(x=>!x.matches(':disabled')&&x.getClientRects().length);const first=buttons[0],last=buttons.at(-1);last.focus();last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true}));const forward=document.activeElement===first;first.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}));const backward=document.activeElement===last;const rect=modal.getBoundingClientRect();return {forward,backward,withinViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,overflow:modal.scrollWidth>modal.clientWidth}`)
  const mark = value => { stage = value; console.log(`[codex-ui-smoke] ${value}`) }
  await wait('!!window.luxinus && !!document.querySelector(".lx-topbar")')
  // Keep the panel closed during modal account races so status observations
  // belong to the settings window under test, rather than its sibling panel.
  await closeAgent()
  await click('폴더 열기'); await wait('!!document.querySelector(".lx-thumbnail-image img")')
  await click('사진 편집'); await wait('!!document.querySelector(".lx-stage canvas")')
  win.setSize(1024, 768); await sleep(150)
  mark('production status discovers CLI without starting a process')
  await js(`const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='AI 설정');button.focus();button.click()`)
  await provider('codex'); await wait('!!document.querySelector("#codex-settings-heading")')
  await wait('[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="ChatGPT로 로그인"&&!x.matches(":disabled"))')
  const realStatus = await js('return window.luxinus.codex.status()')
  assert.ok(realStatus.cliPath, 'An installed CLI must be discovered locally')
  assert.equal(realStatus.phase, 'signed-out')
  assert.ok(calls.productionStatus >= 2)
  assert.deepEqual(unexpectedSpawns, []); assert.deepEqual(networkEvents, [])
  const initialLayout = await focusAndLayout()
  assert.deepEqual(initialLayout, { forward: true, backward: true, withinViewport: true, overflow: false })
  await snapshot('electron-codex-signed-out-1024.png')
  // Only the following account responses are simulated. Production handlers
  // remain registered behind this wrapper and were used for the checks above.
  simulated = true
  account = { ...realStatus, cliVersion: 'synthetic-ui-fixture', message: '검증용 로그인 정보 없음' }
  mark('simulated pending login and success state')
  await click('ChatGPT로 로그인'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  await snapshot('electron-codex-signing-in-1024.png')
  account = { ...account, phase: 'ready', loginId: null, email: 'synthetic@test.invalid', planType: 'UI fixture', message: '저장된 로그인 정보입니다. 요청할 때 실제 계정을 확인합니다.' }
  await wait('document.body.innerText.includes("synthetic@test.invalid")')
  assert.equal(await js('return document.body.innerText.includes("로그인 정보 저장됨") && document.body.innerText.includes("요청할 때 실제 계정을 확인합니다")'), true)
  await snapshot('electron-codex-ready-1024.png')
  await click('로그아웃'); await wait('[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="ChatGPT로 로그인")')
  assert.equal(calls.logout, 1)
  await click('ChatGPT로 로그인'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  const cancelsBeforeClose = calls.cancel
  await key('Escape'); await wait('!document.querySelector("[role=dialog]")')
  await sleep(100); assert.equal(calls.cancel, cancelsBeforeClose + 1)
  assert.equal(await js('return document.activeElement.textContent.trim()'), 'AI 설정')
  mark('an existing login is canceled before the first poll')
  account = { ...account, phase: 'signing-in', loginId: 'synthetic-existing-login', message: '검증용 기존 로그인' }
  const existingStart = Date.now(), existingCancels = calls.cancel, existingStatusCalls = calls.status
  await click('AI 설정'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  await key('Escape'); await waitMain(() => calls.cancel === existingCancels + 1)
  const initialLoginCloseMs = Date.now() - existingStart
  assert.ok(initialLoginCloseMs < 1500, 'Existing login must be canceled before polling')
  assert.equal(calls.status, existingStatusCalls + 1)
  mark('refreshing the same dialog does not cancel its existing login')
  account = { ...account, phase: 'signing-in', loginId: 'synthetic-refresh-login', message: '검증용 새로고침 로그인' }
  const refreshing = {}; heldStatus = refreshing
  await click('AI 설정'); await waitMain(() => !!refreshing.release)
  await click('상태 새로고침'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  const refreshCancels = calls.cancel
  refreshing.release(); await sleep(100)
  assert.equal(calls.cancel, refreshCancels, 'An initial response invalidated by refresh must not cancel the current login')
  assert.equal(account.loginId, 'synthetic-refresh-login')
  await key('Escape'); await waitMain(() => calls.cancel === refreshCancels + 1)
  mark('closing before an initial status response cancels that login only')
  account = { ...account, phase: 'signing-in', loginId: 'synthetic-delayed-login', message: '검증용 지연 로그인' }
  const delayed = {}; heldStatus = delayed
  const delayedCancels = calls.cancel
  await click('AI 설정'); await waitMain(() => !!delayed.release)
  await key('Escape'); await wait('!document.querySelector("[role=dialog]")')
  delayed.release(); await waitMain(() => calls.cancel === delayedCancels + 1)
  assert.equal(calls.cancelIds.at(-1), 'synthetic-delayed-login')
  mark('an old response cannot cancel a newer login')
  account = { ...account, phase: 'signing-in', loginId: 'synthetic-old-login', message: '검증용 이전 로그인' }
  const stale = {}; heldStatus = stale
  await click('AI 설정'); await waitMain(() => !!stale.release)
  await key('Escape'); await wait('!document.querySelector("[role=dialog]")')
  await click('AI 설정'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  await click('로그인 취소'); await wait('[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="ChatGPT로 로그인")')
  await click('ChatGPT로 로그인'); await wait('document.body.innerText.includes("브라우저에서 로그인해 주세요")')
  const newerLoginId = account.loginId, newerCancels = calls.cancel
  stale.release(); await waitMain(() => calls.cancelIds.at(-1) === 'synthetic-old-login')
  assert.equal(account.loginId, newerLoginId); assert.equal(account.phase, 'signing-in'); assert.equal(calls.cancel, newerCancels)
  assert.ok(calls.ignoredCancels > 0)
  await key('Escape'); await wait('!document.querySelector("[role=dialog]")')
  mark('local error and canceled busy state do not leak to Codex tab')
  await click('AI 설정'); await provider('local')
  picker = photo
  await click('실행 파일 선택'); await wait('!!document.querySelector("[role=alert]")')
  await provider('codex'); await wait('!!document.querySelector("#codex-settings-heading")')
  assert.equal(await js('return !!document.querySelector("[role=alert]")'), false)
  await provider('local')
  pendingPicker = {}; await click('실행 파일 선택')
  await wait('document.body.innerText.includes("선택한 작업을 처리하는 중")')
  await click('닫기'); await wait('!document.querySelector("[role=dialog]")')
  await openAgent(); await panelProvider('codex')
  await closeAgent(); await click('AI 설정'); await wait('!!document.querySelector("#codex-settings-heading")')
  assert.equal(await js('return document.querySelector("input[value=local]").matches(":disabled") || document.body.innerText.includes("선택한 작업을 처리하는 중")'), false)
  pendingPicker.resolve({ canceled: true, filePaths: [] }); pendingPicker = null
  await sleep(100); assert.equal(await js('return !!document.querySelector("[role=alert]")'), false)
  await snapshot('electron-codex-provider-reset-1024.png')
  await click('닫기')
  mark('provider-specific readiness and request gating')
  await openAgent(); await prompt('어두운 부분을 20으로')
  assert.equal(await js('return document.querySelector(".lx-agent-send").disabled'), true)
  await closeAgent()
  account = { ...account, phase: 'ready', loginId: null, email: 'synthetic@test.invalid', message: '검증용 저장된 로그인 정보' }
  await openAgent(); await prompt('어두운 부분을 20으로')
  await wait('!document.querySelector(".lx-agent-send").disabled')
  await panelProvider('local'); await wait('document.querySelector(".lx-agent-options").innerText.includes("로컬 모델 준비")')
  await prompt('어두운 부분을 20으로')
  assert.equal(await js('return document.querySelector(".lx-agent-send").disabled'), true)
  await panelProvider('codex'); await prompt('어두운 부분을 20으로'); await wait('!document.querySelector(".lx-agent-send").disabled')
  const agentLayout = await js('const panel=document.querySelector(".lx-agent-panel"),rect=panel.getBoundingClientRect();return {withinViewport:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,overflow:panel.scrollWidth>panel.clientWidth,composerVisible:document.querySelector(".lx-agent-send").getBoundingClientRect().bottom<innerHeight}')
  assert.deepEqual(agentLayout, { withinViewport: true, overflow: false, composerVisible: true })
  // A docked panel must allow native Tab navigation back to the rest of the app.
  win.focus()
  await js('document.querySelector(".lx-agent-panel button:not(:disabled)").focus()')
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] })
  await sleep(100)
  assert.equal(await js('return document.querySelector(".lx-agent-panel").contains(document.activeElement)'), false)
  await snapshot('electron-codex-agent-1024.png')
  await click('보내기'); await wait('document.body.innerText.includes("검증용: 실제 AI 요청을 실행하지 않았습니다")')
  assert.equal(calls.providerInputs.length, 1); assert.equal(calls.providerInputs[0].provider, 'codex')
  await closeAgent()
  assert.equal(fs.existsSync(photo + '.lux.json'), false)
  assert.equal(hash(photo), originalHash)
  assert.deepEqual(unexpectedSpawns, []); assert.deepEqual(networkEvents, []); assert.deepEqual(rendererErrors, [])
  const report = { passed: true, scratch, scope: 'Real Electron UI and production startup/status; simulated account responses only. No real authentication or service inference.', productionStatus: { phase: realStatus.phase, cliPath: realStatus.cliPath, calls: calls.productionStatus, childProcesses: 0 }, simulated: { login: calls.login, logout: calls.logout, cancel: calls.cancel, providerRequest: calls.providerInputs[0].provider }, realAuthentication: false, realServiceInference: false, localErrorAndBusyReset: true, readinessGating: true, escapeCancelsAndRestoresFocus: true, initialLoginCloseMs, sameDialogRefreshPreserved: true, delayedInitialLoginCanceledById: true, newerLoginPreserved: true, panelNativeTabLeavesPanel: true, initialLayout, agentLayout, networkEvents, rendererErrors, originalUnchanged: true, sidecarAbsent: true }
  fs.writeFileSync(path.join(artifacts, 'electron-codex-ui-smoke.json'), JSON.stringify(report, null, 2))
  fs.rmSync(path.join(artifacts, 'electron-codex-ui-smoke-error.json'), { force: true })
  console.log(JSON.stringify(report)); clearTimeout(deadline); app.quit()
}
run().catch(async error => {
  const report = { passed: false, stage, error: String(error), stack: error.stack, lastCode, calls, networkEvents, unexpectedSpawns, rendererErrors, scratch }
  console.error(JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(artifacts, 'electron-codex-ui-smoke-error.json'), JSON.stringify(report, null, 2))
  if (activeWindow && !activeWindow.isDestroyed()) fs.writeFileSync(path.join(artifacts, 'electron-codex-ui-failure.png'), (await activeWindow.webContents.capturePage()).toPNG())
  clearTimeout(deadline); app.exit(1)
})
