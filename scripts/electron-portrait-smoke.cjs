/* Licensed fixture copies only. Actual CNN, UI selection, Undo, atomic sidecar,
 * fresh-process reload and production full-resolution WebGL export. */
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const assert = require('node:assert/strict')
const root = path.resolve(__dirname, '..'), artifacts = path.join(root, '.omc/artifacts')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const source = process.argv[2]
  if (!source || !path.isAbsolute(source)) throw Error('Pass an absolute path to a licensed portrait test fixture.')
  const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-portrait-ui-')))
  fs.mkdirSync(path.join(scratch, 'photos')); fs.mkdirSync(path.join(scratch, 'exports'))
  fs.mkdirSync(path.join(scratch, 'user-data/models'), { recursive: true })
  fs.copyFileSync(source, path.join(scratch, 'photos', 'portrait' + path.extname(source)))
  for (const file of fs.readdirSync(path.join(root, 'models')).filter(name => name.startsWith('portrait-') && name.endsWith('.onnx'))) fs.symlinkSync(path.join(root, 'models', file), path.join(scratch, 'user-data/models', file))
  fs.mkdirSync(artifacts, { recursive: true })
  const original = hash(source)
  for (const phase of ['write', 'read']) {
    const run = spawnSync(require('electron'), [__filename, phase, scratch], { cwd: root, stdio: 'inherit', timeout: 240_000 })
    if (run.status !== 0) process.exit(run.status || 1)
  }
  assert.equal(hash(source), original)
  const write = JSON.parse(fs.readFileSync(path.join(scratch, 'write.json'))), read = JSON.parse(fs.readFileSync(path.join(scratch, 'read.json')))
  assert.notEqual(write.pid, read.pid); assert.equal(read.portraitStarts, 0)
  assert.equal(write.sidecarHash, read.sidecarHash); assert.equal(write.outputHash, read.outputHash)
  fs.writeFileSync(path.join(artifacts, 'electron-portrait-smoke.json'), JSON.stringify({ passed: true, scratch, sourceHash: original, write, read }, null, 2))
  console.log('Actual portrait UI, restart and export passed.')
} else {
  const { app, BrowserWindow, dialog, session, utilityProcess } = require('electron')
  const sharp = require('sharp')
  const phase = process.argv[2], scratch = process.argv[3], photos = path.join(scratch, 'photos')
  const photo = path.join(photos, fs.readdirSync(photos).find(name => !name.endsWith('.lux.json'))), sidecar = photo + '.lux.json'
  const exportsDir = path.join(scratch, 'exports'), sourceHash = hash(photo)
  const errors = [], network = []
  let picker = photos, win, stage = 'launch', portraitStarts = 0, exportResult
  app.setPath('userData', path.join(scratch, 'user-data'))
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picker] })
  const fork = utilityProcess.fork.bind(utilityProcess)
  utilityProcess.fork = (module, args, options) => { if (options?.serviceName === 'luxinus-portrait') portraitStarts++; return fork(module, args, options) }
  require('./network-observer.cjs').observeNodeNetwork(event => network.push(event))
  app.whenReady().then(() => session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => { if (/^(https?|wss?):/.test(details.url)) network.push({ protocol: new URL(details.url).protocol }); callback({ requestHeaders: details.requestHeaders }) }))
  app.on('web-contents-created', (_event, contents) => contents.on('console-message', (_e, level, message) => { if (level >= 3) errors.push(message) }))
  require(path.join(root, 'out/main/index.js'))
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const deadline = setTimeout(() => { console.error(`Portrait UI timeout: ${stage}`); app.exit(1) }, 220_000)
  const js = async code => {
    const value = await win.webContents.executeJavaScript(`(async()=>{try{return {value:await(async()=>{${code}})()}}catch(error){return {error:error.stack||String(error)}}})()`)
    if (value.error) throw Error(`${stage}: ${value.error}`)
    return value.value
  }
  const wait = async (condition, limit = 180) => { for (let i = 0; i < limit; i++) { if (await js(`return (${condition})`)) return; await sleep(100) } throw Error(`${stage}: timed out ${condition}\n${await js('return document.body.innerText')}`) }
  const click = label => js(`const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(label)}&&x.getClientRects().length);if(!b||b.matches(':disabled'))throw Error('Button unavailable: '+${JSON.stringify(label)});b.click()`)
  const paint = () => js('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
  const screenshot = async name => { await paint(); fs.writeFileSync(path.join(artifacts, name), (await win.webContents.capturePage()).toPNG()) }
  async function run() {
    await app.whenReady()
    for (let i = 0; i < 100; i++) { win = BrowserWindow.getAllWindows().find(item => item.isVisible()); if (win) break; await sleep(100) }
    assert.ok(win); win.webContents.setBackgroundThrottling(false)
    await wait('!!document.querySelector(".lx-agent-panel")')
    await click('폴더 열기'); await wait('!!document.querySelector(".lx-thumbnail-image img")')
    await click('사진 편집'); await wait('!!document.querySelector(".lx-stage canvas")')
    await js('document.querySelector("button[aria-label=\"AI 채팅 닫기\"]").click()')
    await js('const b=[...document.querySelectorAll("button")].find(x=>x.title==="부분 보정"||x.textContent.trim()==="부분 보정");if(!b)throw Error("mask tool missing");b.click()')
    await wait('!!document.querySelector("section[aria-label=\"인물 자동 선택\"]")')
    let parts = []
    if (phase === 'write') {
      stage = 'actual CNN detection and region selection'
      await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="인물 부위 찾기"&&!b.disabled)')
      const start = Date.now()
      await click('인물 부위 찾기')
      await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="다시 분석")', 1600)
      parts = await js('return [...document.querySelectorAll("section[aria-label=\"인물 자동 선택\"] button")].filter(b=>!b.disabled&&b.textContent.trim()!=="다시 분석").map(b=>b.textContent.trim())')
      for (const label of ['인물 전체', '얼굴', '눈', '코', '입', '피부', '옷']) assert.ok(parts.includes(label), `Missing ${label}: ${parts}`)
      console.log(`Actual CNN ${Date.now()-start}ms: ${parts.join(', ')}`)
      assert.equal(fs.existsSync(sidecar), false, 'Analysis alone cannot change the edit')
      await click('피부'); await wait('!!document.querySelector("[role=slider][aria-label=노출]")')
      await js('const s=document.querySelector("[role=slider][aria-label=노출]");s.dispatchEvent(new KeyboardEvent("keydown",{key:"PageUp",bubbles:true}));')
      await wait('document.querySelector("[role=slider][aria-label=노출]").getAttribute("aria-valuenow")==="10"')
      await js('document.querySelector("[role=slider][aria-label=노출]").dispatchEvent(new KeyboardEvent("keydown",{key:"PageUp",bubbles:true}))')
      await wait('document.querySelector("[role=slider][aria-label=노출]").getAttribute("aria-valuenow")==="20"')
      await screenshot('electron-portrait-skin-overlay.png')
      await js('document.querySelector("button[aria-label=\"실행 취소\"]").click()')
      await wait('document.querySelector("[role=slider][aria-label=노출]").getAttribute("aria-valuenow")==="0"')
      await js('document.querySelector("button[aria-label=\"다시 실행\"]").click()')
      await wait('document.querySelector("[role=slider][aria-label=노출]").getAttribute("aria-valuenow")==="20"')
      await wait('document.querySelector(".lx-status").innerText.includes("보정 저장 완료")')
      const edit = JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits
      assert.equal(edit.masks.length, 1); assert.equal(edit.masks[0].kind, 'semantic'); assert.equal(edit.masks[0].adjust.exposure, 20)
      assert.ok(edit.masks[0].semantic.coverage.length > 1000)
      fs.writeFileSync(path.join(scratch, 'parts.json'), JSON.stringify(parts))
    } else {
      stage = 'fresh-process durable mask load'
      const stored = JSON.parse(fs.readFileSync(sidecar, 'utf8')).edits
      assert.equal(stored.masks[0].adjust.exposure, 20)
      await wait('[...document.querySelectorAll("button")].some(b=>b.textContent.trim()==="피부")')
      await click('피부')
      await wait('document.querySelector("[role=slider][aria-label=노출]")?.getAttribute("aria-valuenow")==="20"')
      await screenshot('electron-portrait-reloaded.png')
    }
    stage = 'production full-resolution PNG export'
    picker = exportsDir
    const destination = await js('return window.luxinus.exportr.pickDir()')
    const options = { format: 'png', quality: 90, longEdge: 0, filenamePattern: `portrait-${phase}`, exifMode: 'strip', frameStyle: 'minimal', destDir: destination }
    const output = await js(`return window.luxinus.exportr.run([{filePath:${JSON.stringify(photo)},fileName:${JSON.stringify(path.basename(photo))},editState:null,meta:null}],${JSON.stringify(options)})`)
    assert.deepEqual(output.errors, []); assert.equal(output.written.length, 1); assert.equal(output.canceled, false)
    exportResult = output.written[0]
    const originalMeta = await sharp(photo).metadata(), outputMeta = await sharp(exportResult).metadata()
    assert.equal(outputMeta.width, originalMeta.width); assert.equal(outputMeta.height, originalMeta.height)
    const loaded = await js(`return window.luxinus.edits.load(${JSON.stringify(photo)})`)
    const zeroOutput = await js(`const edit=await window.luxinus.edits.load(${JSON.stringify(photo)});edit.masks=[];return window.luxinus.exportr.run([{filePath:${JSON.stringify(photo)},fileName:${JSON.stringify(path.basename(photo))},editState:edit,meta:null}],${JSON.stringify({ ...options, filenamePattern: `baseline-${phase}` })})`)
    assert.deepEqual(zeroOutput.errors, [])
    const base = await sharp(zeroOutput.written[0]).removeAlpha().raw().toBuffer(), edited = await sharp(exportResult).removeAlpha().raw().toBuffer()
    const semantic = loaded.masks[0].semantic, coverage = Buffer.from(semantic.coverage, 'base64')
    let total = 0, outsideDelta = 0, outsidePixels = 0, selectedDelta = 0, selectedPixels = 0
    for (let y=0;y<outputMeta.height;y++) for(let x=0;x<outputMeta.width;x++) {
      const sx = Math.min(semantic.width-1,Math.floor(x/outputMeta.width*semantic.width)), sy=Math.min(semantic.height-1,Math.floor(y/outputMeta.height*semantic.height))
      const mask = coverage[sy*semantic.width+sx], i=(y*outputMeta.width+x)*3
      const delta=Math.abs(base[i]-edited[i])+Math.abs(base[i+1]-edited[i+1])+Math.abs(base[i+2]-edited[i+2]);total+=delta
      if(mask>240){selectedDelta+=delta;selectedPixels++}
      let clear=mask===0
      for(let dy=-2;dy<=2&&clear;dy++)for(let dx=-2;dx<=2;dx++){const px=sx+dx,py=sy+dy;if(px>=0&&py>=0&&px<semantic.width&&py<semantic.height&&coverage[py*semantic.width+px])clear=false}
      if(clear){outsideDelta+=delta;outsidePixels++}
    }
    assert.ok(total>1000&&selectedPixels>20);assert.ok(selectedDelta/selectedPixels>1)
    assert.ok(outsidePixels>20);assert.ok(outsideDelta/outsidePixels<.05,'Unselected background changed')
    assert.equal(hash(photo),sourceHash);assert.deepEqual(network,[]);assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(scratch, `${phase}.json`),JSON.stringify({pid:process.pid,portraitStarts,parts,sidecarHash:hash(sidecar),outputHash:hash(exportResult),width:outputMeta.width,height:outputMeta.height,selectedMeanDelta:selectedDelta/selectedPixels,outsideMeanDelta:outsideDelta/outsidePixels,originalUnchanged:true,networkRequests:network.length},null,2))
    clearTimeout(deadline);win.close()
    for(let i=0;i<100&&!win.isDestroyed();i++)await sleep(50)
    assert.ok(win.isDestroyed(),'Normal close must flush the edit');app.quit()
  }
  run().catch(error=>{clearTimeout(deadline);console.error(error);fs.writeFileSync(path.join(artifacts,'electron-portrait-smoke-error.json'),JSON.stringify({stage,phase,scratch,error:String(error),stack:error.stack,network,errors},null,2));app.exit(1)})
}
