/* Actual Electron main + preload + ONNX persistence across fresh processes.
 * Run with node, passing the approved model file and its installed basename.
 * Uses only synthetic pixels and temporary userData. No network requests. */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const root = path.resolve(__dirname, '..')
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

if (!process.versions.electron) {
  ;(async () => {
    const sourceModel = process.argv[2], installedName = process.argv[3]
    assert.ok(sourceModel && installedName && /^[-a-zA-Z0-9_.]+\.onnx$/.test(installedName), 'Usage: node script <approved model path> <installed model filename>')
    const model = fs.realpathSync(sourceModel)
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-cache-native-')))
    const photos = path.join(scratch, 'photos'), uiPhotos = path.join(scratch, 'ui-photos'), userData = path.join(scratch, 'user-data')
    for (const folder of [photos, uiPhotos, path.join(userData, 'models')]) fs.mkdirSync(folder, { recursive: true })
    fs.symlinkSync(model, path.join(userData, 'models', installedName))
    const width = 48, height = 40, rgba = Buffer.alloc(width * height * 4)
    let seed = 91
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const i = (y * width + x) * 4, noise = (seed % 25) - 12
      rgba[i] = 60 + x * 2 + noise; rgba[i + 1] = 80 + y * 2 + noise; rgba[i + 2] = 110 + noise; rgba[i + 3] = 255
    }
    await require('sharp')(rgba, { raw: { width, height, channels: 4 } }).png().toFile(path.join(photos, 'synthetic.png'))
    fs.copyFileSync(path.join(photos, 'synthetic.png'), path.join(uiPhotos, 'synthetic.png'))
    fs.writeFileSync(path.join(scratch, 'input.json'), JSON.stringify({ width, height, rgba: [...rgba] }))
    const originalHash = hash(fs.readFileSync(path.join(photos, 'synthetic.png')))
    const electron = require('electron'), { spawnSync } = require('node:child_process')
    const phases = []
    for (const phase of ['write', 'read', 'ui-write', 'ui-read']) {
      const run = spawnSync(electron, [__filename, `--cache-phase=${phase}`, `--scratch=${scratch}`], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 })
      if (run.stdout) process.stdout.write(run.stdout)
      if (run.stderr) process.stderr.write(run.stderr)
      assert.equal(run.status, 0, `Native ${phase} phase failed: ${run.error?.message ?? ''}`)
      phases.push(JSON.parse(fs.readFileSync(path.join(scratch, `${phase}.json`), 'utf8')))
    }
    assert.notEqual(phases[0].pid, phases[1].pid)
    assert.equal(phases[0].outputHash, phases[1].outputHash)
    assert.equal(phases[0].modelFingerprint, phases[1].modelFingerprint)
    assert.notEqual(phases[2].pid, phases[3].pid)
    assert.equal(phases[2].outputHash, phases[3].outputHash)
    assert.equal(phases[2].proxyInputHash, phases[3].proxyInputHash)
    assert.equal(phases[2].modelFingerprint, phases[3].modelFingerprint)
    assert.equal(hash(fs.readFileSync(path.join(photos, 'synthetic.png'))), originalHash)
    assert.equal(hash(fs.readFileSync(path.join(uiPhotos, 'synthetic.png'))), originalHash)
    const report = { at: new Date().toISOString(), scratch, modelHash: hash(fs.readFileSync(model)), originalHash,
      originalUnchanged: true, freshElectronProcessReusedPixels: true, actualRendererProxyRestartHit: true, phases }
    fs.mkdirSync(path.join(root, '.omc/artifacts'), { recursive: true })
    fs.writeFileSync(path.join(root, '.omc/artifacts/electron-restoration-cache-smoke.json'), JSON.stringify(report, null, 2))
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  })().catch(error => { console.error(error); process.exitCode = 1 })
} else {
  const { app, BrowserWindow, dialog, utilityProcess } = require('electron')
  const phase = process.argv.find(value => value.startsWith('--cache-phase=')).slice(14)
  const scratch = process.argv.find(value => value.startsWith('--scratch=')).slice(10)
  const uiPhase = phase.startsWith('ui-')
  const photos = path.join(scratch, uiPhase ? 'ui-photos' : 'photos'), source = path.join(photos, 'synthetic.png')
  app.setPath('userData', path.join(scratch, 'user-data'))
  app.on('child-process-gone', (_event, details) => console.error('[cache-native] child process gone', JSON.stringify(details)))
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [photos] })
  const network = [], workers = new Set()
  require('./network-observer.cjs').observeNodeNetwork(event => network.push(event))
  let inferenceMessages = 0
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (file, args, options) => {
    const worker = fork(file, args, options)
    workers.add(worker); worker.on('exit', () => workers.delete(worker))
    if (path.basename(file) === 'onnx.worker.js') {
      const post = worker.postMessage.bind(worker)
      worker.postMessage = message => { if (message.type === 'denoise') inferenceMessages++; return post(message) }
    }
    return worker
  }
  const deadline = setTimeout(() => { console.error('Cache native phase timed out'); app.exit(1) }, 160000)
  require(path.join(root, 'out/main/index.js'))
  ;(async () => {
    await app.whenReady()
    let win
    for (let i = 0; i < 150; i++) {
      win = BrowserWindow.getAllWindows().find(candidate => candidate.isVisible())
      if (win && await win.webContents.executeJavaScript('!!window.luxinus?.ai?.restorePreview').catch(() => false)) break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert.ok(win)
    win.webContents.setBackgroundThrottling(false)
    const js = code => win.webContents.executeJavaScript(`(async()=>(${code}))()`)
    if (uiPhase) {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
      const wait = async condition => {
        for (let i = 0; i < 1000; i++) { if (await js(condition)) return; await sleep(100) }
        throw Error(`Actual renderer condition timed out: ${condition}\n${await js('document.body.innerText')}`)
      }
      const click = label => js(`(()=>{const button=[...document.querySelectorAll('button')].find(el=>el.textContent.trim()===${JSON.stringify(label)});if(!button)throw Error('Missing button: '+${JSON.stringify(label)});button.click()})()`)
      await wait('!!document.querySelector(".lx-topbar")')
      await js(`document.querySelector('[aria-label="AI 채팅 닫기"]')?.click()`)
      await click('폴더 열기')
      await wait('document.querySelectorAll(".lx-thumbnail-image img").length===1')
      await click('사진 편집')
      await wait(`[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='기본 보정')`)
      await click('기본 보정')
      await wait(`!!document.querySelector('.lx-stage canvas') && !!document.querySelector('[role=slider][aria-label="노이즈 제거 강도"]')`)
      // Production React handler decodes its own proxy and requests the cache.
      if (phase === 'ui-write') {
        await wait(`[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='노이즈 제거 (NAFNet SIDD)'&&!el.closest('fieldset')?.disabled)`)
        await wait(`[...document.querySelectorAll('button')].some(el=>el.textContent.trim()==='밝기 자동 보정'&&!el.disabled)`)
        await click('노이즈 제거 (NAFNet SIDD)')
      }
      const message = phase === 'ui-write' ? '복원 결과를 이 컴퓨터에 저장했습니다.' : '저장된 복원 결과를 불러왔습니다.'
      await wait(`document.body.innerText.includes(${JSON.stringify(message)})`)
      await wait(`document.querySelector('[role=slider][aria-label="노이즈 제거 강도"]')?.getAttribute('aria-valuenow')==='60'`)
      assert.equal(inferenceMessages, phase === 'ui-write' ? 1 : 0)
      const cacheDirectory = path.join(scratch, 'user-data/restoration-cache')
      const entries = fs.readdirSync(cacheDirectory).map(name => {
        const bytes = fs.readFileSync(path.join(cacheDirectory, name))
        const length = bytes.readUInt32BE(8)
        const header = JSON.parse(bytes.subarray(12, 12 + length).toString('utf8'))
        return { name, header, rgba: bytes.subarray(12 + length) }
      })
      const entry = entries.find(value => value.header.descriptor.source.pathHash === hash(source))
      assert.ok(entry, 'UI restoration must have its own source-identity cache file')
      assert.equal(hash(entry.rgba), entry.header.outputHash)
      // Scroll the actual status into view for the independently reviewed screenshot.
      await js(`(()=>{[...document.querySelectorAll('[role=status]')].find(el=>el.textContent===${JSON.stringify(message)})?.scrollIntoView({block:'center'})})()`)
      await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(root, `.omc/artifacts/electron-restoration-cache-${phase}.png`), image.toPNG()))
      const closed = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Save-aware UI close timed out')), 18000)
        win.once('closed', () => { clearTimeout(timer); resolve() })
      })
      win.close(); await closed
      const sidecar = JSON.parse(fs.readFileSync(path.join(photos, 'synthetic.png.lux.json'), 'utf8'))
      assert.equal(sidecar.edits.denoise, 60, 'Normal close must preserve the auto-seeded restoration strength')
      assert.equal(network.length, 0)
      const report = { phase, pid: process.pid, cacheStatus: phase === 'ui-write' ? 'stored' : 'hit', actualReactButtonAndProxy: true,
        inferenceMessages, uiMessage: message, proxyInputHash: entry.header.descriptor.inputHash, outputHash: entry.header.outputHash,
        width: entry.header.descriptor.width, height: entry.header.descriptor.height, modelFingerprint: entry.header.descriptor.modelFingerprint,
        sidecarStrength: sidecar.edits.denoise, normalCloseFlushed: true, cacheFile: entry.name, networkEvents: network }
      fs.writeFileSync(path.join(scratch, `${phase}.json`), JSON.stringify(report, null, 2))
      console.log(`[cache-native] ${phase}: ${report.cacheStatus}, inference messages ${inferenceMessages}`)
      clearTimeout(deadline); for (const worker of workers) worker.kill(); app.exit(0)
      return
    }
    const folder = await js('window.luxinus.library.openFolder()')
    assert.equal(folder.photos.length, 1)
    await js(`window.luxinus.edits.load(${JSON.stringify(source)})`)
    if (phase === 'write') assert.equal(await js(`window.luxinus.edits.save(${JSON.stringify(source)},{denoise:35})`), true)
    assert.equal((await js(`window.luxinus.edits.load(${JSON.stringify(source)})`)).denoise, 35)
    const input = JSON.parse(fs.readFileSync(path.join(scratch, 'input.json'), 'utf8'))
    const sourceStat = fs.statSync(source)
    const request = JSON.stringify({ requestId: `native-cache-${phase}`, filePath: source, sourceMtimeMs: sourceStat.mtimeMs, sourceSize: sourceStat.size, width: input.width, height: input.height })
    const result = await js(`(async()=>{const result=await window.luxinus.ai.restorePreview({...${request},rgba:new Uint8Array(${JSON.stringify(input.rgba)})});return {...result,rgba:result.rgba?Array.from(result.rgba):null}})()`)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.cache.status, phase === 'write' ? 'stored' : 'hit')
    assert.equal(inferenceMessages, phase === 'write' ? 1 : 0)
    assert.equal(result.width, input.width); assert.equal(result.height, input.height)
    assert.notEqual(hash(Buffer.from(result.rgba)), hash(Buffer.from(input.rgba)), 'Actual ONNX output must change noisy pixels')
    assert.equal(network.length, 0, 'Normal main JS operations make no network calls')
    const report = { phase, pid: process.pid, cacheStatus: result.cache.status, inferenceMessages, width: result.width, height: result.height,
      outputHash: hash(Buffer.from(result.rgba)), modelFingerprint: result.modelFingerprint, sidecarStrength: 35,
      cacheFiles: fs.readdirSync(path.join(scratch, 'user-data/restoration-cache')), networkEvents: network }
    fs.writeFileSync(path.join(scratch, `${phase}.json`), JSON.stringify(report, null, 2))
    console.log(`[cache-native] ${phase}: ${result.cache.status}, inference messages ${inferenceMessages}`)
    clearTimeout(deadline); for (const worker of workers) worker.kill(); app.exit(0)
  })().catch(error => { console.error(error); clearTimeout(deadline); for (const worker of workers) worker.kill(); app.exit(1) })
}
