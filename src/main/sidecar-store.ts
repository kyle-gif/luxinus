import { EDIT_SCHEMA_VERSION, type EditState } from '../shared/edits'
import { validateEditState } from '../shared/edit-validation'
import { assertAuthorizedPhoto } from './file-policy'
import { atomicReplace, contentHash, decodeUtf8, readRegularFile, serializeFile } from './safe-file'
import { assertSemanticSource } from './semantic-source'

export const sidecarPath = (photoPath: string): string => photoPath + '.lux.json'
const baselines = new Map<string, string | null>()
type SidecarDocument = Record<string, unknown> & { edits: Record<string, unknown> }

function parseSidecar(raw: Buffer): SidecarDocument {
  const parsed = JSON.parse(decodeUtf8(raw).replace(/^\uFEFF/, '')) as SidecarDocument
  if (!parsed || parsed.app !== 'luxinus' || !parsed.edits || typeof parsed.edits !== 'object' || Array.isArray(parsed.edits)) throw new Error('Luxinus sidecar 형식이 아닙니다. 기존 파일을 보존했습니다.')
  if (!Number.isInteger(parsed.version) || Number(parsed.version) < 1 || Number(parsed.version) > EDIT_SCHEMA_VERSION) throw new Error('지원하지 않는 sidecar 버전입니다. 기존 파일을 보존했습니다.')
  validateEditState(parsed.edits)
  return parsed
}

async function readSnapshot(photoPath: string, trackBaseline: boolean): Promise<{ edits: EditState | null; hash: string | null }> {
  const photo = await assertAuthorizedPhoto(photoPath)
  return serializeFile(sidecarPath(photo), async () => {
    const raw = await readRegularFile(sidecarPath(photo))
    const hash = raw === null ? null : contentHash(raw)
    const edits = raw === null ? null : validateEditState(parseSidecar(raw).edits)
    if (edits) await assertSemanticSource(edits, photo)
    if (trackBaseline) baselines.set(photo, hash)
    return { edits, hash }
  })
}

export async function readEditSnapshot(photoPath: string): Promise<{ edits: EditState | null; hash: string | null }> {
  return readSnapshot(photoPath, false)
}

// Only a renderer loading a photo into its actual edit buffer advances the
// autosave baseline. Agent inspection and export must not accept external edits
// on behalf of an older active editor buffer.
export async function loadEdits(photoPath: string, trackBaseline = false): Promise<EditState | null> {
  return (await readSnapshot(photoPath, trackBaseline)).edits
}

// Preserve object extension fields. Arrays are deliberate edits; matching IDs
// retain extension fields while removals remain removals.
function preserveUnknown(previous: unknown, next: unknown): unknown {
  if (Array.isArray(next)) {
    if (!Array.isArray(previous)) return next
    return next.map((value, index) => {
      const old = value && typeof value === 'object' && 'id' in value
        ? previous.find((entry) => entry && typeof entry === 'object' && entry.id === value.id) : previous[index]
      return preserveUnknown(old, value)
    })
  }
  if (!next || typeof next !== 'object') return next
  const old = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}
  return Object.fromEntries([...Object.entries(old),
    ...Object.entries(next).map(([key, value]) => [key, preserveUnknown((old as Record<string, unknown>)[key], value)])])
}

export async function saveEdits(photoPath: string, input: EditState, expectedHash?: string | null): Promise<boolean> {
  const photo = await assertAuthorizedPhoto(photoPath)
  const edits = validateEditState(input)
  await assertSemanticSource(edits, photo)
  const target = sidecarPath(photo)
  return serializeFile(target, async () => {
    const raw = await readRegularFile(target)
    const currentHash = raw === null ? null : contentHash(raw)
    const expected = expectedHash !== undefined ? expectedHash : baselines.get(photo)
    if ((expected === undefined && raw !== null) || (expected !== undefined && expected !== currentHash)) throw new Error('보정 파일이 다른 작업에서 변경되었습니다. 사진을 다시 불러온 뒤 적용해 주세요. (충돌)')
    const old = raw === null ? {} : parseSidecar(raw)
    const document = { ...old, version: EDIT_SCHEMA_VERSION, app: 'luxinus',
      edits: preserveUnknown('edits' in old ? old.edits : {}, edits), updatedAt: new Date().toISOString() }
    const hash = await atomicReplace(target, JSON.stringify(document, null, 2) + '\n', currentHash, async () => { await assertAuthorizedPhoto(photo); await assertSemanticSource(edits, photo) })
    baselines.set(photo, hash)
    return true
  })
}
