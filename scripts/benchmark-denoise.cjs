// Reproducible synthetic quality benchmark; no user photographs or network.
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const esbuild = require('esbuild')
const sharp = require('sharp')
const root = path.resolve(__dirname, '..')
const large = process.argv.includes('--large')
const out = path.join(root, '.omc/artifacts', large ? 'denoise-benchmark-large' : 'denoise-benchmark')
fs.mkdirSync(out, { recursive: true })
esbuild.buildSync({ entryPoints: [path.join(root, 'src/workers/lib/tiledInference.ts')], outfile: path.join(out, 'tiled.cjs'), bundle: true, platform: 'node', format: 'cjs' })
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/ai.ts')], outfile: path.join(out, 'ai.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { rgbaToPlanar, planarToRgba, runTiled } = require(path.join(out, 'tiled.cjs'))
const { RESTORATION_SESSION_OPTIONS } = require(path.join(out, 'ai.cjs'))
const networkEvents = []
require('./network-observer.cjs').observeNodeNetwork(event => networkEvents.push(event))
const ort = require('onnxruntime-node')
const width = large ? 896 : 320, height = large ? 800 : 256
function random(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 } }
function fixture() {
  const pixels = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4
    const u = x * 320 / width, v = y * 256 / height
    let r = 40 + u * .45 + v * .12, g = 35 + v * .65, b = 155 - u * .24 + v * .1
    if (u > 30 && u < 137 && v > 30 && v < 128) { r = 175; g = 95; b = 62 }
    if ((u - 232) ** 2 + (v - 79) ** 2 < 46 ** 2) { r = 72; g = 165; b = 192 }
    // Both strong boundaries and a low-contrast woven texture test detail retention.
    if (v > 159 && u > 20 && u < 300) { const texture = 10 * Math.sin(x * .56) + 6 * Math.cos(y * .44); r += texture; g += texture; b += texture }
    if (u > 156 && u < 292 && v > 133 && v < 146 && x % 12 < 4) r = g = b = 225
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = (x + y) % 256
  }
  return pixels
}
function noisy(clean, kind, seed) {
  const rng = random(seed), pixels = new Uint8Array(clean)
  for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) {
    const gaussian = Math.sqrt(-2 * Math.log(Math.max(1e-9, rng()))) * Math.cos(2 * Math.PI * rng())
    const sigma = kind === 'gaussian-15' ? 15 : kind === 'gaussian-25' ? 25 : Math.sqrt(16 + clean[i] * 1.8)
    pixels[i] = Math.round(Math.max(0, Math.min(255, clean[i] + gaussian * sigma)))
  }
  return pixels
}
function metrics(actual, clean) {
  let squared = 0, gradient = 0, gradientN = 0, texture = 0, textureN = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) {
    const i = (y * width + x) * 4 + c, error = actual[i] - clean[i]
    squared += error * error
    if (y * 256 / height > 159 && x * 320 / width > 20 && x * 320 / width < 300) { texture += error * error; textureN++ }
    if (x > 0 && y > 0) for (const offset of [4, width * 4]) {
      const reference = clean[i] - clean[i - offset]
      if (Math.abs(reference) >= 12) { const e = actual[i] - actual[i - offset] - reference; gradient += e * e; gradientN++ }
    }
  }
  const mse = squared / (width * height * 3)
  return { psnrDb: mse === 0 ? null : 10 * Math.log10(255 * 255 / mse), edgeGradientRmse: Math.sqrt(gradient / gradientN), textureRmse: Math.sqrt(texture / textureN) }
}
async function png(name, pixels) { await sharp(pixels, { raw: { width, height, channels: 4 } }).removeAlpha().png().toFile(path.join(out, name + '.png')) }
;(async () => {
  const clean = fixture()
  const cases = (large ? ['gaussian-25'] : ['gaussian-15', 'gaussian-25', 'signal-dependent']).map((name, i) => ({ name, pixels: noisy(clean, name, 7123 + i) }))
  const models = [
    { id: 'gopro-deblur', file: path.join(root, 'models/nafnet.onnx'), tile: 512, input: 'lq', overlap: 32, expectedSha256: '07263f416febecce10193dd648e950b22e397cf521eedab1a114ef77b2bc9587' },
    { id: 'sidd-denoise', file: process.argv.slice(2).find(arg => !arg.startsWith('--')) || path.join(root, 'models/nafnet-sidd-width32.onnx'), tile: 768, input: 'input', overlap: 32, expectedSha256: '8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230' }
  ]
  const report = { createdAt: new Date().toISOString(), fixture: { width, height, seed: 7123, description: 'Synthetic gradients, color shapes, fine bars and low-contrast sinusoidal texture; quantized RGB with seeded Gaussian or signal-dependent Gaussian noise. Not a real-camera dataset.' }, runtime: { node: process.version, onnxruntime: ort.env.versions.node, platform: process.platform, arch: process.arch, provider: 'CPU' }, strengthPercent: [60, 100], cases: cases.map(c => ({ name: c.name, noisy: metrics(c.pixels, clean) })), models: [], networkEvents }
  await png('clean', clean)
  for (const c of cases) await png(c.name + '-noisy', c.pixels)
  for (const model of models) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(model.file)).digest('hex')
    if (hash !== model.expectedSha256) throw new Error(`Unexpected ${model.id} model checksum`)
    const start = performance.now()
    const sessionOptions = { executionProviders: ['cpu'], logSeverityLevel: 3, ...(model.id === 'sidd-denoise' ? RESTORATION_SESSION_OPTIONS : { graphOptimizationLevel: 'all' }) }
    const session = await ort.InferenceSession.create(model.file, sessionOptions)
    const entry = { ...model, sessionOptions, sha256: hash, loadMs: Math.round(performance.now() - start), inputMetadata: session.inputMetadata, outputMetadata: session.outputMetadata, cases: [] }
    console.log(model.id, 'loaded', entry.loadMs)
    for (const c of [...cases, { name: 'clean-input', pixels: clean }]) {
      const t = performance.now()
      const restored = await runTiled(rgbaToPlanar(c.pixels, width, height), width, height, async (input, size) => {
        const tensor = new ort.Tensor('float32', input, [1, 3, size, size]); let output
        try { output = await session.run({ [model.input]: tensor }); return new Float32Array(output.output.data) }
        finally { tensor.dispose(); if (output) for (const value of Object.values(output)) value.dispose() }
      }, { tile: model.tile, overlap: model.overlap })
      const inferMs = Math.round(performance.now() - t)
      for (const strength of report.strengthPercent) {
        const pixels = planarToRgba(restored, c.pixels, width, height, strength / 100)
        if (pixels.some((v, i) => i % 4 === 3 && v !== c.pixels[i])) throw new Error('Alpha changed')
        const result = { name: c.name, strength, inferMs, ...metrics(pixels, clean) }
        entry.cases.push(result); console.log(model.id, JSON.stringify(result))
        await png(`${c.name}-${model.id}-${strength}`, pixels)
      }
    }
    report.models.push(entry)
    await session.release()
  }
  if (networkEvents.length) throw new Error('Unexpected network activity')
  report.peakRSSMiB = process.resourceUsage().maxRSS / 1024
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
  console.log('Report:', path.join(out, 'report.json'))
})().catch(error => { console.error(error); process.exitCode = 1 })
