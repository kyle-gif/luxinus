// Genuine Electron utility-process CNN inference. No windows, auth or user photos.
// Run: npx electron scripts/electron-portrait-model-smoke.cjs
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const assert = require('node:assert/strict'), crypto = require('node:crypto')
const { app, utilityProcess } = require('electron'), esbuild = require('esbuild'), sharp = require('sharp')
const root = path.resolve(__dirname, '..'), build = path.join(root, '.omc/portrait-native-build')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-portrait-model-native-'))
const defaultUserData = app.getPath('userData')
app.setPath('userData', path.join(scratch, 'user-data'))
const networkEvents = [], workers = new Set(), workerExits = [], requests = []
require('./network-observer.cjs').observeNodeNetwork(event => networkEvents.push({ context: 'main', ...event }))
const originalFork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (file, args, options) => {
  const worker = originalFork(file, args, options)
  workers.add(worker)
  worker.on('message', message => { if (message?.type === 'network-observed') networkEvents.push({ context: 'portrait-utility', ...message.event }) })
  worker.on('exit', code => { workerExits.push({ pid: worker.pid, code }); workers.delete(worker) })
  const post = worker.postMessage.bind(worker)
  worker.postMessage = message => { if (message?.type === 'analyze') requests.push(message.input.requestId); return post(message) }
  return worker
}
const crashes = []
app.on('child-process-gone', (_event, detail) => { if (detail.reason === 'crashed') crashes.push(detail) })
const deadline = setTimeout(() => { console.error('Portrait native deadline'); for (const worker of workers) worker.kill(); app.exit(1) }, 120_000)
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
;(async () => {
  fs.mkdirSync(build, { recursive: true })
  for (const [source, name] of [['src/main/portrait-model-runner.ts', 'runner.cjs'], ['src/workers/portrait.worker.ts', 'portrait-implementation.cjs'], ['src/shared/portrait-model.ts', 'metadata.cjs']]) esbuild.buildSync({ entryPoints: [path.join(root, source)], outfile: path.join(build, name), bundle: true, packages: 'external', platform: 'node', format: 'cjs' })
  fs.writeFileSync(path.join(build, 'portrait.worker.js'), `require(${JSON.stringify(path.join(root, 'scripts/network-observer.cjs'))}).observeNodeNetwork(event => process.parentPort.postMessage({type:'network-observed',event}));require('./portrait-implementation.cjs')`)
  const metadata = require(path.join(build, 'metadata.cjs'))
  fs.mkdirSync(path.join(scratch, 'user-data/models'), { recursive: true })
  for (const model of Object.values(metadata.PORTRAIT_MODELS)) fs.symlinkSync(path.join(root, 'models', model.filename), path.join(scratch, 'user-data/models', model.filename))
  await app.whenReady()
  const runner = require(path.join(build, 'runner.cjs'))
  const file = path.join(root, '.omc/portrait-models/astronaut.png'), originalHash = hash(fs.readFileSync(file))
  assert.equal(originalHash, '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5')
  const source = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const input = { rgba: new Uint8Array(source.data), width: source.info.width, height: source.info.height }
  const reports = []
  async function run(name, pixels = input, regions) {
    const start = performance.now()
    const result = await runner.runPortraitSegmentation({ ...pixels, regions, requestId: `native-${name}-${crypto.randomUUID()}` })
    assert.equal(result.ok, true, result.message)
    assert.equal(result.modelFingerprint, metadata.PORTRAIT_MODEL_FINGERPRINT)
    assert.ok(result.width <= 512 && result.height <= 512)
    const records = result.regions.map(region => {
      assert.equal(region.coverage.length, result.width * result.height)
      return { region: region.region, hash: hash(region.coverage), bounds: region.bounds, pixels: region.coverage.reduce((count, value) => count + Number(value > 0), 0) }
    })
    reports.push({ name, elapsedMs: Math.round(performance.now() - start), width: result.width, height: result.height, facesDetected: result.facesDetected, regions: records, warnings: result.warnings })
    return result
  }
  const first = await run('first')
  assert.equal(first.facesDetected, 1); assert.equal(first.regions.length, 8)
  const firstPid = [...workers][0]?.pid
  const repeated = await run('repeated')
  assert.equal([...workers][0]?.pid, firstPid, 'Repeated inference must reuse the same actual utility')
  for (let i = 0; i < first.regions.length; i++) assert.equal(hash(first.regions[i].coverage), hash(repeated.regions[i].coverage))
  const blank = new Uint8Array(320 * 200 * 4).fill(100)
  for (let i = 3; i < blank.length; i += 4) blank[i] = 255
  const empty = await run('blank', { rgba: blank, width: 320, height: 200 })
  assert.equal(empty.facesDetected, 0); assert.deepEqual(empty.regions, [])
  const subset = await run('subset', input, ['eyes', 'mouth'])
  assert.deepEqual(subset.regions.map(region => region.region), ['eyes', 'mouth'])
  const requestId = `native-cancel-${crypto.randomUUID()}`, beforeCancel = runner.getPortraitGeneration()
  const canceled = runner.runPortraitSegmentation({ ...input, requestId })
  for (let i = 0; i < 100 && !requests.includes(requestId); i++) await pause(10)
  assert.ok(requests.includes(requestId), 'Cancel must happen after delivery to the actual utility')
  runner.cancelPortraitSegmentation()
  assert.equal((await canceled).ok, false)
  assert.ok(runner.getPortraitGeneration() > beforeCancel)
  const restarted = await run('after-cancel')
  assert.notEqual([...workers][0]?.pid, firstPid)
  for (let i = 0; i < first.regions.length; i++) assert.equal(hash(first.regions[i].coverage), hash(restarted.regions[i].coverage))
  assert.equal(runner.isPortraitModelBusy(), false)
  assert.equal(hash(fs.readFileSync(file)), originalHash)
  assert.deepEqual(networkEvents, []); assert.deepEqual(crashes, [])
  runner.cancelPortraitSegmentation()
  const report = { at: new Date().toISOString(), defaultUserData, scratch, realElectronUtility: true, electron: process.versions.electron, provider: 'CPU', sessionOptions: metadata.PORTRAIT_SESSION_OPTIONS, modelFingerprint: metadata.PORTRAIT_MODEL_FINGERPRINT, fixtureSha256: originalHash, sameWorkerRepeated: true, cancelAfterDeliveryAndRestart: true, originalUnchanged: true, networkEvents, crashes, workerExits, reports }
  fs.mkdirSync(path.join(root, '.omc/artifacts'), { recursive: true })
  fs.writeFileSync(path.join(root, '.omc/artifacts/electron-portrait-model-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  clearTimeout(deadline); app.exit(0)
})().catch(error => { console.error(error); clearTimeout(deadline); for (const worker of workers) worker.kill(); app.exit(1) })
