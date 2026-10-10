/* Native Electron navigation regression. Only generated fixtures and scratch userData.
 * Keyboard/mouse/wheel inputs travel through Electron; cancellation is a DOM event.
 * This tests Windows modifier semantics on macOS, not physical Windows hardware. */
const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const sharp = require('sharp')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-viewport-smoke-')))
const photos = path.join(scratch, 'photos')
fs.mkdirSync(photos)
fs.mkdirSync(path.join(scratch, 'user-data'))
app.setPath('userData', path.join(scratch, 'user-data'))
const artifacts = path.join(root, '.omc/artifacts')
fs.mkdirSync(artifacts, { recursive: true })
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [photos] })
const image = path.join(photos, 'navigation-fixture.jpg')
const fixtureReady = sharp(Buffer.from('<svg width="800" height="500"><rect width="800" height="500" fill="#486977"/><circle cx="510" cy="155" r="93" fill="#ecc499"/><path d="M0 500V310L215 160L470 500Z" fill="#294d36"/></svg>')).jpeg().toFile(image)
const errors = []
app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message) }))
require(path.join(root, 'out/main/index.js'))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
let win, lastCode
async function run() {
  await app.whenReady(); await fixtureReady
  for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows().find(window => window.isVisible()); if (win) break; await sleep(100) }
  if (!win) throw Error('No production window')
  const js = async code => {
    lastCode = code
    const result = await win.webContents.executeJavaScript(`(async()=>{try{return{ok:true,value:await(${code})}}catch(error){return{ok:false,error:String(error),stack:error?.stack}}})()`)
    if (!result.ok) throw Error(`${result.error}\n${result.stack}\n${code}`)
    return result.value
  }
  const wait = async code => { for (let i = 0; i < 100; i++) { if (await js(code)) return; await sleep(100) } throw Error(`Timed out: ${code}`) }
  const click = label => js(`(()=>{const el=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)});if(!el)throw Error('Missing ${label}');el.click()})()`)
  const view = () => js(`(()=>{const el=document.querySelector('[data-viewport-image]');return{z:+el.dataset.zoom,x:+el.dataset.panX,y:+el.dataset.panY}})()`)
  const centre = () => js(`(()=>{const r=document.querySelector('.lx-photo-area').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`)
  const focusArea = () => js(`document.querySelector('.lx-photo-area').focus()`)
  const fit = async () => { await js(`document.querySelector('[aria-label="사진 화면 맞춤"]').click()`); await sleep(80); assert.deepEqual(await view(), { z: 1, x: 0, y: 0 }) }
  const key = async (type, keyCode, modifiers = []) => { win.webContents.sendInputEvent({ type, keyCode, modifiers }); await sleep(50) }
  const near = (a, b, tolerance = 0.01) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`)
  await wait(`!!document.querySelector('.lx-topbar')`)
  await js(`document.querySelector('[aria-label="AI 채팅 닫기"]')?.click()`)
  await click('폴더 열기'); await wait(`document.querySelectorAll('.lx-thumbnail-image img').length===1`)
  await click('사진 편집'); await wait(`!!document.querySelector('[data-viewport-image] canvas')`)
  win.setSize(1024, 768); win.focus(); await sleep(200)
  const originalHash = hash(image)
  const sidecars = () => Object.fromEntries(fs.readdirSync(photos).filter(name => name.endsWith('.lux.json')).map(name => [name, fs.readFileSync(path.join(photos, name), 'utf8')]))
  const initialSidecars = sidecars()
  await js(`(()=>{window.__wheelEvents=[];const area=document.querySelector('.lx-photo-area');area.addEventListener('wheel',e=>window.__wheelEvents.push({x:e.deltaX,y:e.deltaY,ctrl:e.ctrlKey,meta:e.metaKey,shift:e.shiftKey}));window.addEventListener('pointerdown',e=>window.__pointerId=e.pointerId,true);})()`)
  async function wheel(deltaX, deltaY, modifiers = []) {
    const point = await centre(), before = await view()
    const cursor = { x: point.x + 47, y: point.y - 33 }
    await focusArea()
    await js('window.__wheelEvents=[]')
    win.webContents.sendInputEvent({ type: 'mouseMove', ...cursor })
    win.webContents.sendInputEvent({ type: 'mouseWheel', ...cursor, deltaX, deltaY, modifiers, hasPreciseScrollingDeltas: true, canScroll: true })
    await wait('window.__wheelEvents.length>0'); await sleep(150)
    return { before, after: await view(), events: await js('window.__wheelEvents'), cursor }
  }
  const xy = await wheel(23, -41)
  assert.equal(xy.after.z, 1)
  near(xy.after.x, -xy.events.reduce((sum, event) => sum + event.x, 0))
  near(xy.after.y, -xy.events.reduce((sum, event) => sum + event.y, 0))
  assert.ok(xy.after.x !== 0 && xy.after.y !== 0)
  await fit()
  const horizontal = await wheel(0, -50, ['shift'])
  assert.ok(horizontal.after.x !== 0); near(horizontal.after.y, 0); assert.equal(horizontal.after.z, 1)
  const zoomEvidence = []
  for (const modifier of ['meta', 'control']) {
    await fit()
    const result = await wheel(0, 65, [modifier])
    assert.ok(result.after.z > 1, `Native ${modifier} wheel did not zoom in`)
    const rect = await js(`document.querySelector('.lx-photo-area').getBoundingClientRect().toJSON()`)
    const anchor = { x: result.cursor.x - rect.left - rect.width / 2, y: result.cursor.y - rect.top - rect.height / 2 }
    near((anchor.x - result.before.x) / result.before.z, (anchor.x - result.after.x) / result.after.z)
    near((anchor.y - result.before.y) / result.before.z, (anchor.y - result.after.y) / result.after.z)
    near(win.webContents.getZoomFactor(), 1)
    zoomEvidence.push({ modifier, before: result.before, after: result.after, events: result.events })
  }
  await fit()
  const belowFit = await wheel(0, -65, ['control'])
  assert.ok(belowFit.after.z < 1)
  await js(`document.querySelector('[aria-label="미리보기 확대"]').focus()`)
  await key('keyDown', '1', ['shift']); await key('keyUp', '1', ['shift'])
  assert.deepEqual(await view(), { z: 1, x: 0, y: 0 })
  async function drag(button = 'left', holdSpace = true, cancel = null) {
    await focusArea()
    if (holdSpace) await key('keyDown', 'Space')
    const point = await centre(), before = await view(), downModifier = button === 'middle' ? 'middleButtonDown' : 'leftButtonDown'
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button, clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 44, y: point.y + 29, modifiers: [downModifier] })
    await sleep(120)
    const moved = await view()
    near(moved.x, before.x + 44); near(moved.y, before.y + 29)
    if (cancel) {
      assert.ok(await js('window.__pointerId > 0'), 'No native pointer ID observed for cancellation')
      await js(cancel === 'blur' ? `window.dispatchEvent(new Event('blur'))` : `document.querySelector('.lx-photo-area').dispatchEvent(new PointerEvent('pointercancel',{pointerId:window.__pointerId,bubbles:true}))`)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 65, y: point.y + 45, modifiers: [downModifier] })
      await sleep(80); assert.deepEqual(await view(), moved)
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: point.x + 65, y: point.y + 45, button, clickCount: 1 })
    if (holdSpace) await key('keyUp', 'Space')
    await sleep(100)
    const released = await view()
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x - 30, y: point.y - 30 })
    await sleep(80); assert.deepEqual(await view(), released)
    return moved
  }
  await fit(); await drag()
  assert.equal(await js(`!![...document.querySelectorAll('.lx-stage span')].find(el=>el.textContent==='원본')`), false)
  await fit(); await drag('middle', false)
  await fit(); await drag('left', true, 'blur')
  await fit(); await drag('left', true, 'cancel')
  await fit(); await focusArea(); await key('keyDown', 'B')
  await wait(`!![...document.querySelectorAll('.lx-stage span')].find(el=>el.textContent==='원본')`)
  await key('keyUp', 'B'); await wait(`![...document.querySelectorAll('.lx-stage span')].find(el=>el.textContent==='원본')`)
  await key('keyDown', 'B'); await js(`window.dispatchEvent(new Event('blur'))`)
  await wait(`![...document.querySelectorAll('.lx-stage span')].find(el=>el.textContent==='원본')`)
  await key('keyUp', 'B')
  await sleep(650); assert.deepEqual(sidecars(), initialSidecars, 'Navigation wrote a sidecar')
  await click('자르기·수평'); await wait(`!!document.querySelector('[aria-label="자르기와 수평 조정"]')`)
  const cropBefore = sidecars()
  await fit(); await drag(); await fit(); await drag('middle', false)
  await sleep(650); assert.deepEqual(sidecars(), cropBefore, 'Hand drag changed crop geometry')
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(artifacts, 'electron-viewport-crop-pan-1024.png'), image.toPNG()))
  await click('자르기 완료'); await click('부분 보정')
  await js(`(()=>{const el=[...document.querySelectorAll('.lx-edit-panel button')].find(x=>x.textContent.includes('브러시')&&x.textContent.includes('직접 칠해서'));if(!el)throw Error('Missing brush');el.click()})()`)
  await sleep(700)
  const brushBefore = sidecars(); assert.ok(Object.keys(brushBefore).length === 1)
  await fit(); await drag(); await fit(); await drag('middle', false)
  await sleep(650); assert.deepEqual(sidecars(), brushBefore, 'Hand drag painted a brush stroke')
  await fit()
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(artifacts, 'electron-viewport-fit-1024.png'), image.toPNG()))
  assert.equal(hash(image), originalHash)
  assert.deepEqual(errors.filter(message => /Uncaught|shader|Failed to load/.test(message)), [])
  const report = { testedAt: new Date().toISOString(), scratch, platform: process.platform, buildMain: hash(path.join(root, 'out/main/index.js')), nativeInputs: 'Electron keyboard, mouse and wheel', xyPan: true, shiftHorizontal: true, zoomEvidence, pinchModifierSemantics: true, zoomBelowFit: true, fitShortcut: true, spacePan: true, middlePan: true, blurCleanup: 'DOM window blur signal', pointerCancelCleanup: 'DOM pointercancel signal with captured pointer ID', releasedPointerStopsPan: true, holdBBeforeAndBlur: true, cropPreserved: true, brushPreserved: true, navigationCreatedNoSidecar: true, originalUnchanged: true, rendererErrors: errors, physicalTrackpadTested: false, physicalWindowsTested: false }
  fs.writeFileSync(path.join(artifacts, 'electron-viewport-smoke.json'), JSON.stringify(report, null, 2))
  fs.rmSync(path.join(artifacts, 'electron-viewport-smoke-error.json'), { force: true })
  console.log(JSON.stringify(report))
  app.quit(); setTimeout(() => app.exit(0), 1500)
}
run().catch(async error => {
  const report = { error: String(error), stack: error?.stack, lastCode, scratch, rendererErrors: errors }
  console.error(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(artifacts, 'electron-viewport-smoke-error.json'), JSON.stringify(report, null, 2))
  if (win && !win.isDestroyed()) await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(artifacts, 'electron-viewport-failure.png'), image.toPNG())).catch(() => {})
  app.exit(1)
})
