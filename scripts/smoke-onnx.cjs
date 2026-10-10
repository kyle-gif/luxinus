const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const out = path.join(root, '.omc', 'artifacts')
fs.mkdirSync(out, { recursive: true })
esbuild.buildSync({ entryPoints: [path.join(root, 'src/workers/lib/tiledInference.ts')], outfile: path.join(out, 'tiled.cjs'), bundle: true, platform: 'node', format: 'cjs' })
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/ai.ts')], outfile: path.join(out, 'ai.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { RESTORATION_SESSION_OPTIONS } = require(path.join(out, 'ai.cjs'))
const networkRequests = []
require('./network-observer.cjs').observeNodeNetwork(event => networkRequests.push(event))
const ort = require('onnxruntime-node')
const { rgbaToPlanar, planarToRgba, runTiled } = require(path.join(out, 'tiled.cjs'))
;(async () => {
  const file = path.join(root, 'models/nafnet-sidd-width32.onnx')
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (checksum !== '8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230') throw new Error('Unexpected model checksum')
  const t0 = performance.now()
  const session = await ort.InferenceSession.create(file, { executionProviders: ['cpu'], logSeverityLevel: 3, ...RESTORATION_SESSION_OPTIONS })
  const loaded = performance.now()
  const width = 96, height = 80
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    rgba[i] = Math.round(x / width * 255)
    rgba[i + 1] = Math.round(y / height * 255)
    rgba[i + 2] = (x + y) % 19 === 0 ? 220 : 80
    rgba[i + 3] = 73
  }
  let tiles = 0
  const restored = await runTiled(rgbaToPlanar(rgba, width, height), width, height, async (pixels, size) => {
    const input = new ort.Tensor('float32', pixels, [1, 3, size, size])
    const output = await session.run({ input })
    input.dispose()
    const result = new Float32Array(output.output.data)
    if (result.some((n) => !Number.isFinite(n))) throw new Error('Non-finite pixel')
    output.output.dispose()
    tiles++
    return result
  }, { tile: 768, overlap: 32 })
  const result = planarToRgba(restored, rgba, width, height, 1)
  let delta = 0
  for (let i = 0; i < result.length; i++) {
    if (i % 4 === 3 && result[i] !== rgba[i]) throw new Error('Alpha not preserved')
    delta += Math.abs(result[i] - rgba[i])
  }
  if (!delta) throw new Error('Inference returned unchanged original')
  if (networkRequests.length) throw new Error('Unexpected network API use during local ONNX inference')
  const report = { model: 'nafnet-sidd-width32.onnx', role: 'RGB denoising (SIDD), after RAW decoding', checksum, provider: 'CPU', input: session.inputMetadata, output: session.outputMetadata, loadMs: Math.round(loaded-t0), inferMs: Math.round(performance.now()-loaded), peakRSSMiB: process.resourceUsage().maxRSS / 1024, tiles, width, height, alphaPreserved: true, pixelDelta: delta, networkRequests, networkObservationScope: 'Node JS APIs; no network blocking or native packet capture', electronWorkerTested: false }
  fs.writeFileSync(path.join(out, 'onnx-smoke.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  await session.release()
})().catch((error) => { console.error(error); process.exitCode = 1 })
