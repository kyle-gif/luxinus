import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ModelIntegrity } from '../src/main/model-integrity'

test('model verification detects changed bytes at the same path and never caches failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'luxinus-model-integrity-'))
  const file = path.join(dir, 'synthetic-model.onnx')
  const digest = createHash('sha256').update('trusted-model').digest('hex')
  const verifier = new ModelIntegrity()
  try {
    await fs.writeFile(file, 'trusted-model')
    await verifier.verify(file, digest)
    await verifier.verify(file, digest)
    await fs.writeFile(file, 'changed-model')
    await assert.rejects(verifier.verify(file, digest), /체크섬/)
    await fs.writeFile(file, 'trusted-model')
    await verifier.verify(file, digest)
    await assert.rejects(verifier.verify(dir, digest), /일반 파일/)
    await assert.rejects(verifier.verify(file, '0'.repeat(64)), /체크섬/)
  } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
