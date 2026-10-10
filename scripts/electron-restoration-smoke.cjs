/* Real Electron restoration/export integration; synthetic files and temporary
 * userData only. Launch requires the user's authorization for native UI.
 * Harness observers forward calls unchanged. This test makes no network requests.
 * Model execution, pixels, IPC and export stay production. */
const assert = require('node:assert/strict')
const { app, BrowserWindow, dialog, utilityProcess, session } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const sharp = require('sharp')
const root = path.resolve(__dirname, '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-restoration-smoke-')))
const photos = path.join(scratch, 'photos'), exportsDir = path.join(scratch, 'exports'), userData = path.join(scratch, 'user-data')
const artifacts = path.join(root, '.omc/artifacts')
for (const dir of [photos, exportsDir, userData, path.join(userData, 'models'), artifacts]) fs.mkdirSync(dir, { recursive: true })
const model = path.join(root, 'models/nafnet-sidd-width32.onnx')
const hashBytes = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const hashFile = (file) => hashBytes(fs.readFileSync(file))
const expectedModelHash = '8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230'
assert.equal(hashFile(model), expectedModelHash, 'Unexpected model checksum')
fs.symlinkSync(model, path.join(userData, 'models/nafnet-sidd-width32.onnx'))
app.setPath('userData', userData)
let picker = photos
let activeWindow, lastCode, phase = 'starting'
const issues = [], networkEvents = [], workerReady = [], progress = [], spawnedWorkers = []
require('./network-observer.cjs').observeNodeNetwork(event => networkEvents.push({ source: 'main', ...event }))
const observedSessions = new Set()
function observeSession(target) {
  if (observedSessions.has(target)) return
  observedSessions.add(target)
  // A different stage from onBeforeRequest: this must never replace or conceal
  // a production request-denial listener. Forward all headers unchanged.
  target.webRequest.onBeforeSendHeaders((details, callback) => {
    if (/^(?:https?|wss?):/.test(details.url)) networkEvents.push({ source: 'chromium', api: new URL(details.url).protocol })
    callback({ requestHeaders: details.requestHeaders })
  })
}
app.whenReady().then(() => observeSession(session.defaultSession))
const setPhase = (value) => { phase = value; console.log(`[restoration-smoke] ${value}`) }
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picker] })

// Observe actual worker API calls without blocking or initiating any connection.
const originalFork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (modulePath, args, options) => {
  const name = path.basename(modulePath)
  if (name !== 'onnx.worker.js' && name !== 'decode.worker.js') return originalFork(modulePath, args, options)
  const wrapper = path.join(scratch, `${name}.audit.cjs`)
  fs.writeFileSync(wrapper, `
    require(${JSON.stringify(path.join(root, 'scripts/network-observer.cjs'))}).observeNodeNetwork(event => process.parentPort.postMessage({type:'smoke:network',event,pid:process.pid}));
    require(${JSON.stringify(modulePath)});
    process.parentPort.postMessage({type:'smoke:observing',pid:process.pid});
  `)
  const worker = originalFork(wrapper, args, options)
  spawnedWorkers.push({ name, serviceName: options?.serviceName })
  worker.on('message', message => {
    if (message?.type === 'smoke:network') networkEvents.push({ source: name, ...message.event })
    if (message?.type === 'smoke:observing') workerReady.push({ worker: name, pid: message.pid })
  })
  return worker
}
app.on('web-contents-created', (_event, contents) => {
  observeSession(contents.session)
  contents.on('console-message', (_event, level, message) => { if (level >= 3) issues.push({ phase, message }) })
  contents.on('render-process-gone', (_event, details) => issues.push({ phase, message: `renderer exited: ${details.reason}` }))
})
const width = 640, height = 400
const fixture = path.join(photos, 'synthetic-restoration.png')
const fixtureReady = (async () => {
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    const border = Math.abs(x - 270) < 9 || Math.abs(y - 160) < 9
    pixels[i] = Math.round(35 + (x / width) * 165)
    pixels[i + 1] = Math.round(45 + (y / height) * 150)
    pixels[i + 2] = border ? 225 : 80 + ((Math.floor(x / 24) + Math.floor(y / 24)) % 2) * 22
    pixels[i + 3] = 255
  }
  await sharp(pixels, { raw: { width, height, channels: 4 } }).blur(0.6).png().toFile(fixture)
})()
require(path.join(root, 'out/main/index.js'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const deadline = setTimeout(() => { console.error(`Smoke deadline exceeded in ${phase}`); app.exit(1) }, 240000)
function pixelStats(data) {
  const sum = [0, 0, 0], minimum = [255, 255, 255], maximum = [0, 0, 0]
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) { sum[c] += data[i + c]; minimum[c] = Math.min(minimum[c], data[i + c]); maximum[c] = Math.max(maximum[c], data[i + c]) }
  return { mean: sum.map((n) => n / (data.length / 4)), minimum, maximum }
}
async function main() {
  await app.whenReady(); await fixtureReady
  setPhase('waiting for real renderer and preload')
  for (let i = 0; i < 150; i++) { activeWindow = BrowserWindow.getAllWindows().find((window) => window.isVisible()); if (activeWindow) break; await sleep(100) }
  assert.ok(activeWindow, 'No visible Electron renderer')
  activeWindow.webContents.setBackgroundThrottling(false)
  const js = async (code, window = activeWindow) => {
    lastCode = code
    const result = await window.webContents.executeJavaScript(`(async()=>{try{return {ok:true,value:await (${code})}}catch(error){return {ok:false,message:String(error),stack:error?.stack}}})()`)
    if (!result.ok) throw new Error(`Renderer evaluation failed: ${result.message}\n${result.stack}\nExpression: ${code}`)
    return result.value
  }
  const wait = async (code) => { for (let i = 0; i < 150; i++) { if (await js(code)) return; await sleep(100) } throw new Error(`Timed out: ${code}`) }
  await wait('!!window.luxinus && !!document.querySelector(".lx-topbar")')
  const originalHash = hashFile(fixture)
  const builtMainHash = hashFile(path.join(root, 'out/main/index.js'))
  setPhase('real folder scan and source authorization')
  const folder = await js('window.luxinus.library.openFolder()')
  assert.equal(folder.photos.length, 1)
  assert.equal(folder.photos[0].filePath, fixture)
  const outside = path.join(scratch, 'outside.png')
  fs.copyFileSync(fixture, outside)
  const outsideDenied = await js(`window.luxinus.edits.save(${JSON.stringify(outside)},{exposure:15}).then(()=>false,()=>true)`)
  assert.equal(outsideDenied, true)
  assert.equal(fs.existsSync(outside + '.lux.json'), false)
  await js(`window.luxinus.edits.load(${JSON.stringify(fixture)})`)
  await js(`window.luxinus.edits.save(${JSON.stringify(fixture)},{denoise:0})`)
  const zeroEdit = await js(`window.luxinus.edits.load(${JSON.stringify(fixture)})`)
  const modelStatus = await js('window.luxinus.ai.status()')
  assert.equal(modelStatus.modelAvailable, true, modelStatus.message)
  await js(`(()=>{window.__restorationProgress=[];window.luxinus.ai.onProgress(value=>window.__restorationProgress.push(value));})()`)
  setPhase('actual ONNX utility inference over renderer IPC')
  const start = Date.now()
  const direct = await js(`(async()=>{
    const width=96,height=80,rgba=new Uint8Array(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;rgba[i]=40+Math.round(x/width*160);rgba[i+1]=45+Math.round(y/height*150);rgba[i+2]=80+((x+y)%17===0?30:0);rgba[i+3]=73;}
    const result=await window.luxinus.ai.denoise({width,height,rgba,strength:100});
    if(!result.ok)throw Error(result.message);let delta=0,alpha=true,channels=[0,0,0];
    for(let i=0;i<rgba.length;i++){if(i%4===3)alpha=alpha&&result.rgba[i]===rgba[i];else{delta+=Math.abs(result.rgba[i]-rgba[i]);channels[i%4]+=result.rgba[i]}}
    return {ok:result.ok,provider:result.provider,fellBack:result.fellBack,width:result.width,height:result.height,pixelDelta:delta,alphaPreserved:alpha,outputMean:channels.map(v=>v/(width*height))};
  })()`)
  direct.durationMs = Date.now() - start
  assert.equal(direct.provider, 'CPU')
  assert.equal(direct.width, 96); assert.equal(direct.height, 80)
  assert.equal(direct.alphaPreserved, true); assert.ok(direct.pixelDelta > 0)
  setPhase('full-original-size GPU export without restoration')
  picker = exportsDir
  const destDir = await js('window.luxinus.exportr.pickDir()')
  const options = { format: 'png', quality: 90, longEdge: 0, filenamePattern: 'render', exifMode: 'strip', frameStyle: 'minimal', destDir }
  const exportWith = async (editState, opts = options) => {
    const result = await js(`window.luxinus.exportr.run([{filePath:${JSON.stringify(fixture)},fileName:'synthetic-restoration.png',editState:${JSON.stringify(editState)},meta:null}],${JSON.stringify(opts)})`)
    assert.equal(result.errors.length, 0, JSON.stringify(result)); assert.equal(result.written.length, 1); assert.equal(result.canceled, false)
    return result.written[0]
  }
  const zeroFile = await exportWith(zeroEdit)
  const zeroBytes = await sharp(zeroFile).ensureAlpha().raw().toBuffer()
  const zeroHash = hashFile(zeroFile)
  const zeroMeta = await sharp(zeroFile).metadata()
  assert.equal(zeroMeta.width, width); assert.equal(zeroMeta.height, height)
  setPhase('saved restoration strength reloaded by full-resolution export')
  await js(`window.luxinus.edits.save(${JSON.stringify(fixture)},{...${JSON.stringify(zeroEdit)},denoise:100})`)
  const saved = JSON.parse(fs.readFileSync(fixture + '.lux.json', 'utf8'))
  assert.equal(saved.edits.denoise, 100)
  const restoredFile = await exportWith(null)
  assert.notEqual(restoredFile, zeroFile, 'Collision must choose another filename')
  assert.equal(hashFile(zeroFile), zeroHash, 'Existing export must remain unchanged')
  const restoredBytes = await sharp(restoredFile).ensureAlpha().raw().toBuffer()
  let exportDelta = 0
  for (let i = 0; i < zeroBytes.length; i++) if (i % 4 !== 3) exportDelta += Math.abs(zeroBytes[i] - restoredBytes[i])
  assert.ok(exportDelta > 0, 'Restoration was not applied in export')
  const restoredMeta = await sharp(restoredFile).metadata()
  assert.equal(restoredMeta.width, width); assert.equal(restoredMeta.height, height)
  fs.copyFileSync(zeroFile, path.join(artifacts, 'restoration-export-zero.png'))
  fs.copyFileSync(restoredFile, path.join(artifacts, 'restoration-export-full.png'))
  setPhase('photo background cannot affect generated pixels')
  // Display background is renderer-only; altering its CSS and persisted preference
  // must not enter the sidecar or the hidden export renderer's pixel state.
  const sidecarHash = hashFile(fixture + '.lux.json')
  await js(`(()=>{localStorage.setItem('lx-photo-background',JSON.stringify('light'));document.documentElement.style.setProperty('--photo-background','#d1d1d1');document.body.style.background='#d1d1d1';})()`)
  const lightFile = await exportWith(null)
  const lightBytes = await sharp(lightFile).ensureAlpha().raw().toBuffer()
  assert.equal(hashBytes(lightBytes), hashBytes(restoredBytes), 'Display background affected export pixels')
  assert.equal(hashFile(fixture + '.lux.json'), sidecarHash, 'Display background changed sidecar')
  setPhase('original-name collision never overwrites the source')
  picker = photos
  const originalDir = await js('window.luxinus.exportr.pickDir()')
  const originalCollision = await exportWith(zeroEdit, { ...options, filenamePattern: '{name}', destDir: originalDir })
  assert.notEqual(originalCollision, fixture)
  assert.equal(hashFile(fixture), originalHash)
  const hidden = BrowserWindow.getAllWindows().find((window) => window !== activeWindow)
  assert.ok(hidden, 'Full-resolution export did not create hidden GPU renderer')
  const webgl = await js(`(()=>{const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl');if(!gl)throw Error('WebGL context unavailable');const ext=gl.getExtension('WEBGL_debug_renderer_info');const result={version:gl.getParameter(gl.VERSION),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),vendor:ext?gl.getParameter(ext.UNMASKED_VENDOR_WEBGL):gl.getParameter(gl.VENDOR),maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)};gl.getExtension('WEBGL_lose_context')?.loseContext();return result;})()`, hidden)
  setPhase('actual utility cancellation and clean restart')
  const cancellation = await js(`(async()=>{const width=640,height=400,rgba=new Uint8Array(width*height*4).fill(120);for(let i=3;i<rgba.length;i+=4)rgba[i]=255;const pending=window.luxinus.ai.denoise({width,height,rgba,strength:100});await new Promise(resolve=>setTimeout(resolve,50));const accepted=await window.luxinus.ai.cancel();const cancelled=await pending;const restarted=await window.luxinus.ai.denoise({width:16,height:16,rgba:new Uint8Array(16*16*4).fill(120),strength:100});return{accepted,cancelled:{ok:cancelled.ok,message:cancelled.message},restarted:{ok:restarted.ok,provider:restarted.provider,width:restarted.width,height:restarted.height,message:restarted.message}}})()`)
  assert.equal(cancellation.accepted, true)
  assert.equal(cancellation.cancelled.ok, false)
  assert.ok(cancellation.cancelled.message.includes('취소'))
  assert.equal(cancellation.restarted.ok, true, cancellation.restarted.message)
  assert.equal(cancellation.restarted.provider, 'CPU')
  progress.push(...await js('window.__restorationProgress'))
  assert.ok(progress.some((event) => event.progress > 0 && event.progress <= 1), 'No actual inference progress')
  assert.ok(workerReady.some(event => event.worker === 'onnx.worker.js'))
  assert.ok(workerReady.some(event => event.worker === 'decode.worker.js'))
  const normalNetworkEvents = networkEvents
  assert.deepEqual(normalNetworkEvents, [], 'Normal photo processing made a network request')
  const gpu = await app.getGPUInfo('basic')
  const report = { passed: true, at: new Date().toISOString(), scratch, builtMainHash, electron: process.versions.electron,
    actualPreloadIPC: true, actualOnnxUtility: true, actualHiddenWebGLExport: true, modelHash: expectedModelHash, modelRole: 'RGB denoising (SIDD), after RAW decoding',
    direct, cancellation, export: { width, height, baseline: zeroFile, restored: restoredFile, backgroundVariant: lightFile, originalNameCollision: originalCollision,
      rgbAbsoluteDelta: exportDelta, zeroStats: pixelStats(zeroBytes), restoredStats: pixelStats(restoredBytes), backgroundPixelsIdentical: true, savedRestorationLoaded: true },
    originalsUnchanged: true, originalHash, existingExportUnchanged: true, outsideLibraryDenied: true,
    network: { normalNetworkEvents, workerReady,
      scope: 'Normal Node JS API and Chromium request observation. No requests, connection blocking or native packet capture.' },
    spawnedWorkers, progressEvents: progress.length, webgl, gpu, issues }
  assert.equal(hashFile(fixture), originalHash)
  assert.equal(issues.length, 0, JSON.stringify(issues))
  fs.writeFileSync(path.join(artifacts, 'electron-restoration-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  fs.rmSync(path.join(artifacts, 'electron-restoration-smoke-error.json'), { force: true })
  await js('window.luxinus.ai.cancel()')
  clearTimeout(deadline)
  app.quit()
  setTimeout(() => app.exit(0), 1500)
}
main().catch(async (error) => {
  console.error(error)
  fs.writeFileSync(path.join(artifacts, 'electron-restoration-smoke-error.json'), JSON.stringify({ passed: false, error: String(error), stack: error.stack, phase, lastCode, issues, networkEvents, scratch }, null, 2))
  clearTimeout(deadline)
  app.exit(1)
})
