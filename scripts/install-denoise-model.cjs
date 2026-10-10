// Explicit installation command only. The application never downloads models.
// Usage: node scripts/install-denoise-model.cjs [--archive file.dtmodel] [--destination models-dir]
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const root = path.resolve(__dirname, '..')
const MODEL = {
  url: 'https://github.com/darktable-org/darktable-ai/releases/download/release-5.6.0/denoise-nafnet.dtmodel',
  archiveBytes: 108413592,
  archiveSha256: '4b5c0b9c2650956eaab9a3fc6ffe3e11d4dc4f55b246b7f3a0d2d72161b6980c',
  modelBytes: 117341957,
  modelSha256: '8b437280db2f9f0ef5c733fa0fec70fc10012a62d19dac24a25b80ec8c529230',
  filename: 'nafnet-sidd-width32.onnx',
  source: 'https://github.com/darktable-org/darktable-ai/tree/master/models/denoise-nafnet',
  original: 'https://github.com/megvii-research/NAFNet',
  license: 'MIT',
  role: 'RGB image denoising, SIDD width-32',
  input: { name: 'input', shape: [1, 3, 768, 768], type: 'float32', range: [0, 1], channels: 'RGB' }
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function value(flag) { const i = process.argv.indexOf(flag); if (i < 0) return null; if (!process.argv[i + 1] || process.argv[i + 1].startsWith('--')) throw new Error(`Missing ${flag} value`); return process.argv[i + 1] }

async function publish(file, bytes, matches = existing => existing.equals(bytes)) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  try {
    await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 })
    try { await fs.link(temporary, file) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const stat = await fs.lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || !matches(await fs.readFile(file))) throw new Error(`Existing file differs or is a link: ${file}; preserve it and choose another directory.`)
    }
  } finally { await fs.rm(temporary, { force: true }) }
}

// Read a single named member only after verifying the exact pinned archive.
// No paths from the archive are ever used for file writes.
function modelMember(archive) {
  let end = archive.length - 22
  while (end >= Math.max(0, archive.length - 65557) && archive.readUInt32LE(end) !== 0x06054b50) end--
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50) throw new Error('Invalid model archive directory')
  let offset = archive.readUInt32LE(end + 16)
  const count = archive.readUInt16LE(end + 10)
  for (let i = 0; i < count; i++) {
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid archive entry')
    const method = archive.readUInt16LE(offset + 10), size = archive.readUInt32LE(offset + 20), unpacked = archive.readUInt32LE(offset + 24)
    const nameLength = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32)
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (name === 'denoise-nafnet/model.onnx') {
      if (method !== 8 || unpacked !== MODEL.modelBytes) throw new Error('Unexpected model archive format')
      const local = archive.readUInt32LE(offset + 42)
      if (archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid model member')
      const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28)
      return zlib.inflateRawSync(archive.subarray(start, start + size), { maxOutputLength: MODEL.modelBytes })
    }
    offset += 46 + nameLength + extra + comment
  }
  throw new Error('Model member missing')
}

;(async () => {
  const archiveFile = value('--archive')
  const destination = path.resolve(value('--destination') || path.join(root, 'models'))
  let archive
  if (archiveFile) archive = await fs.readFile(path.resolve(archiveFile))
  else {
    console.log(`Downloading official NAFNet SIDD model archive (${(MODEL.archiveBytes / 1048576).toFixed(1)} MiB)`)
    const response = await fetch(MODEL.url)
    if (!response.ok || !response.body) throw new Error(`Download failed: ${response.status}`)
    const chunks = []; let size = 0
    for await (const chunk of response.body) { size += chunk.length; if (size > MODEL.archiveBytes) throw new Error('Archive exceeds expected size'); chunks.push(chunk) }
    archive = Buffer.concat(chunks)
  }
  if (archive.length !== MODEL.archiveBytes || hash(archive) !== MODEL.archiveSha256) throw new Error('Official archive checksum mismatch')
  const model = modelMember(archive)
  if (model.length !== MODEL.modelBytes || hash(model) !== MODEL.modelSha256) throw new Error('Model checksum mismatch')
  await fs.mkdir(destination, { recursive: true })
  const target = path.join(destination, MODEL.filename)
  await publish(target, model, existing => hash(existing) === MODEL.modelSha256)
  await publish(path.join(destination, 'nafnet-sidd-width32.LICENSE.txt'), await fs.readFile(path.join(root, 'docs/licenses/NAFNet.txt')))
  await publish(path.join(destination, 'nafnet-sidd-width32.manifest.json'), Buffer.from(JSON.stringify({ ...MODEL, installedAt: new Date().toISOString(), platform: os.platform() }, null, 2)), existing => {
    try { const previous = JSON.parse(existing.toString()); return Object.entries(MODEL).every(([key, value]) => JSON.stringify(previous[key]) === JSON.stringify(value)) }
    catch { return false }
  })
  console.log(JSON.stringify({ installed: target, bytes: model.length, sha256: MODEL.modelSha256, license: MODEL.license }))
})().catch(error => { console.error(error.message); process.exitCode = 1 })
