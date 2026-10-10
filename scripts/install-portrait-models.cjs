// Explicit CLI installation; the application never downloads portrait models.
// node scripts/install-portrait-models.cjs [--from directory] [--destination models-dir]
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..'), compiled = path.join(root, '.omc/portrait-models/metadata.cjs')
esbuild.buildSync({ entryPoints: [path.join(root, 'src/shared/portrait-model.ts')], outfile: compiled, platform: 'node', bundle: true, format: 'cjs' })
const { PORTRAIT_MODELS, PORTRAIT_MODEL_FINGERPRINT } = require(compiled)
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function option(name) { const i = process.argv.indexOf(name); if (i === -1) return null; if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing ${name}`); return path.resolve(process.argv[i + 1]) }
async function publish(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try { await fs.link(temporary, file) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || hash(await fs.readFile(file)) !== hash(bytes)) throw new Error(`Existing file differs or is a link: ${file}`)
    }
  } finally { await fs.rm(temporary, { force: true }) }
}
;(async () => {
  const from = option('--from'), destination = option('--destination') || path.join(root, 'models')
  await fs.mkdir(destination, { recursive: true })
  for (const model of Object.values(PORTRAIT_MODELS)) {
    let bytes
    if (from) bytes = await fs.readFile(path.join(from, model.sourceName))
    else {
      console.log(`Downloading ${model.id}: ${(model.bytes / 1048576).toFixed(1)} MiB`)
      const response = await fetch(model.url)
      if (!response.ok || !response.body) throw new Error(`${model.id}: HTTP ${response.status}`)
      const chunks = []; let size = 0
      for await (const chunk of response.body) { size += chunk.length; if (size > model.bytes) throw new Error('Model exceeds pinned size'); chunks.push(chunk) }
      bytes = Buffer.concat(chunks)
    }
    if (bytes.length !== model.bytes || hash(bytes) !== model.sha256) throw new Error(`${model.id}: checksum mismatch`)
    await publish(path.join(destination, model.filename), bytes)
    await publish(path.join(destination, model.filename + '.LICENSE.txt'), await fs.readFile(path.join(root, 'docs/licenses', model.licenseFile)))
    console.log(`Verified ${model.filename} ${model.sha256}`)
  }
  await publish(path.join(destination, 'portrait-models.manifest.json'), Buffer.from(JSON.stringify({ models: PORTRAIT_MODELS, modelFingerprint: PORTRAIT_MODEL_FINGERPRINT }, null, 2)))
  console.log(`Installed local CNN portrait models in ${destination}`)
})().catch(error => { console.error(error.message); process.exitCode = 1 })
