// Real local CNN inference on the public-domain NASA astronaut fixture and
// synthetic controls. Does not use user photographs, a hosted model or a mock.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto')
const esbuild = require('esbuild'), sharp = require('sharp')
const root = path.resolve(__dirname, '..'), out = path.join(root, '.omc/artifacts/portrait-models')
fs.mkdirSync(out, { recursive: true })
for (const [entry, name] of [['src/workers/portrait-inference.ts', 'inference'], ['src/shared/portrait-model.ts', 'metadata']]) esbuild.buildSync({ entryPoints: [path.join(root, entry)], outfile: path.join(out, name + '.cjs'), platform: 'node', bundle: true, packages: 'external', format: 'cjs' })
const { inferPortrait } = require(path.join(out, 'inference.cjs')), { PORTRAIT_MODELS, PORTRAIT_MODEL_FINGERPRINT, PORTRAIT_SESSION_OPTIONS } = require(path.join(out, 'metadata.cjs'))
const paths = Object.fromEntries(Object.entries(PORTRAIT_MODELS).map(([key, model]) => [key, path.join(root, 'models', model.filename)]))
const network = []
require('./network-observer.cjs').observeNodeNetwork(event => network.push(event))
;(async () => {
  const file = process.argv[2] || path.join(root, '.omc/portrait-models/astronaut.png')
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5', 'Expected the pinned public-domain NASA fixture')
  const source = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const fixtures = [{ name: 'astronaut', rgba: source.data, width: source.info.width, height: source.info.height }]
  const blank = Buffer.alloc(320 * 200 * 4, 100)
  for (let i = 3; i < blank.length; i += 4) blank[i] = 255
  fixtures.push({ name: 'blank', rgba: blank, width: 320, height: 200 })
  const duo = await sharp({ create: { width: 1024, height: 512, channels: 4, background: '#202020' } }).composite([{ input: file, left: 0, top: 0 }, { input: file, left: 512, top: 0 }]).raw().toBuffer()
  fixtures.push({ name: 'two-portraits', rgba: duo, width: 1024, height: 512 })
  const reports = []
  for (const fixture of fixtures) {
    const start = performance.now()
    const result = await inferPortrait({ ...fixture, rgba: new Uint8Array(fixture.rgba), requestId: `fixture-${fixture.name}` }, paths)
    const elapsedMs = Math.round(performance.now() - start)
    assert.equal(result.ok, true, result.message)
    assert.equal(result.modelFingerprint, PORTRAIT_MODEL_FINGERPRINT)
    const base = await sharp(fixture.rgba, { raw: { width: fixture.width, height: fixture.height, channels: 4 } }).resize(result.width, result.height).raw().toBuffer()
    const regions = []
    for (const region of result.regions) {
      assert.equal(region.coverage.length, result.width * result.height)
      let pixels = 0, sumX = 0, sumY = 0
      const overlay = Buffer.alloc(base.length)
      for (let i = 0; i < region.coverage.length; i++) { if (region.coverage[i]) { pixels++; sumX += i % result.width; sumY += Math.floor(i / result.width) } overlay[i * 4] = 255; overlay[i * 4 + 1] = 50; overlay[i * 4 + 2] = 30; overlay[i * 4 + 3] = Math.round(region.coverage[i] * .6) }
      await sharp(base, { raw: { width: result.width, height: result.height, channels: 4 } }).composite([{ input: overlay, raw: { width: result.width, height: result.height, channels: 4 } }]).png().toFile(path.join(out, fixture.name + '-' + region.region + '.png'))
      await sharp(region.coverage, { raw: { width: result.width, height: result.height, channels: 1 } }).png().toFile(path.join(out, fixture.name + '-' + region.region + '-mask.png'))
      regions.push({ region: region.region, pixels, fraction: pixels / region.coverage.length, bounds: region.bounds, centroid: { x: sumX / pixels / result.width, y: sumY / pixels / result.height } })
    }
    if (fixture.name === 'blank') {
      assert.equal(result.facesDetected, 0); assert.deepEqual(regions, [])
    } else {
      assert.equal(result.facesDetected, fixture.name === 'astronaut' ? 1 : 2)
      assert.equal(regions.length, 8, 'All requested semantic classes must come from actual CNN output')
      const byName = Object.fromEntries(regions.map(region => [region.region, region]))
      assert.ok(byName.eyes.centroid.y < byName.nose.centroid.y && byName.nose.centroid.y < byName.mouth.centroid.y)
      assert.ok(byName.face.fraction > .01 && byName.face.fraction < .08)
      assert.ok(byName.clothes.fraction > .2 && byName.clothes.fraction < .6)
      if (fixture.name === 'astronaut') for (const name of ['eyes', 'nose', 'mouth']) {
        assert.ok(byName[name].centroid.x > .38 && byName[name].centroid.x < .50, `${name} source x must align with the actual face`)
        assert.ok(byName[name].centroid.y > .17 && byName[name].centroid.y < .31, `${name} source y must align with the actual face`)
      }
    }
    reports.push({ fixture: fixture.name, width: result.width, height: result.height, elapsedMs, facesDetected: result.facesDetected, regions, warnings: result.warnings })
    console.log(JSON.stringify(reports.at(-1)))
  }
  assert.equal(network.length, 0)
  const report = { at: new Date().toISOString(), source: 'NASA Eileen Collins public domain via scikit-image v0.25.2; synthetic blank and duplicated portrait', fixtureSha256: '88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5', modelFingerprint: PORTRAIT_MODEL_FINGERPRINT, provider: 'CPU', sessionOptions: PORTRAIT_SESSION_OPTIONS, realOnnx: true, networkEvents: network, reports }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
})().catch(error => { console.error(error); process.exitCode = 1 })
