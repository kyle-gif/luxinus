import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { XmpApplyResult, XmpField, XmpProposal, XmpReview } from '../shared/xmp'
import { atomicReplace, contentHash, decodeUtf8, readRegularFile, serializeFile } from './safe-file'
import { importXmp, validateXmpXml } from './xmp'

const CRS = 'http://ns.adobe.com/camera-raw-settings/1.0/'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const ranges: Record<string, [number, number]> = {
  Exposure2012: [-5, 5], Contrast2012: [-100, 100], Highlights2012: [-100, 100],
  Shadows2012: [-100, 100], Whites2012: [-100, 100], Blacks2012: [-100, 100],
  Clarity2012: [-100, 100], Texture: [-100, 100], Dehaze: [-100, 100],
  Vibrance: [-100, 100], Saturation: [-100, 100], GrainAmount: [0, 100],
  IncrementalTemperature: [-100, 100], IncrementalTint: [-100, 100],
  Temperature: [2000, 50000], Tint: [-150, 150], Sharpness: [0, 150],
  PostCropVignetteAmount: [-100, 100], VignetteAmount: [-100, 100],
  ColorGradeBlending: [0, 100], SplitToningBalance: [-100, 100],
  SplitToningShadowHue: [0, 360], SplitToningShadowSaturation: [0, 100],
  SplitToningHighlightHue: [0, 360], SplitToningHighlightSaturation: [0, 100]
}
for (const color of ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']) {
  for (const prefix of ['HueAdjustment', 'SaturationAdjustment', 'LuminanceAdjustment']) ranges[prefix + color] = [-100, 100]
}
for (const region of ['Shadow', 'Midtone', 'Highlight', 'Global']) {
  for (const [key, min, max] of [['Hue', 0, 360], ['Sat', 0, 100], ['Lum', -100, 100]] as const) ranges[`ColorGrade${region}${key}`] = [min, max]
}

interface LocatedField extends XmpField { start: number; end: number }
function numericFields(xml: string): LocatedField[] {
  validateXmpXml(xml)
  const fields: LocatedField[] = []
  const namespaces: Record<string, string>[] = [{}]
  let descriptions = 0
  // Tokenize tags without interpreting or rebuilding the document. XML comments,
  // processing instructions, RDF arrays and unsupported content remain bytes.
  const tags = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?>/g
  for (const match of xml.matchAll(tags)) {
    const token = match[0]
    if (token.startsWith('<!') || token.startsWith('<?')) continue
    if (token.startsWith('</')) { namespaces.pop(); continue }
    const current = { ...namespaces[namespaces.length - 1] }
    const attributes = [...token.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/gs)]
    for (const attribute of attributes) {
      if (attribute[1].startsWith('xmlns:')) current[attribute[1].slice(6)] = attribute[3]
    }
    const name = /^<([\w:.-]+)/.exec(token)![1]
    const [prefix, local] = name.split(':')
    if (local === 'Description' && current[prefix] === RDF) {
      descriptions++
      for (const attribute of attributes) {
        const [attributePrefix, key] = attribute[1].split(':')
        if (current[attributePrefix] !== CRS || !ranges[key]) continue
        const raw = attribute[3]
        if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) continue
        const value = Number(raw)
        const [min, max] = ranges[key]
        if (!Number.isFinite(value) || value < min || value > max) continue
        const quoteOffset = attribute[0].indexOf(attribute[2])
        const start = match.index! + attribute.index! + quoteOffset + 1
        fields.push({ key, value, min, max, start, end: start + raw.length })
      }
    }
    if (!token.endsWith('/>')) namespaces.push(current)
  }
  if (descriptions !== 1) throw new Error('직접 수정은 rdf:Description이 하나인 XMP만 지원합니다. 원문은 변경되지 않았습니다.')
  if (new Set(fields.map((field) => field.key)).size !== fields.length) throw new Error('중복 보정 필드는 직접 수정할 수 없습니다.')
  return fields
}

export function proposeXmpText(xml: string, patch: Record<string, number>): { text: string; changes: XmpProposal['changes']; fields: XmpField[] } {
  const fields = numericFields(xml)
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length === 0 || Object.keys(patch).length > 100) throw new Error('수정할 XMP 필드를 선택해 주세요.')
  const changes: XmpProposal['changes'] = []
  const replacements: { start: number; end: number; value: string }[] = []
  for (const [key, value] of Object.entries(patch)) {
    const field = fields.find((candidate) => candidate.key === key)
    if (!field) throw new Error(`지원하는 기존 숫자 속성만 수정할 수 있습니다: ${key}`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < field.min || value > field.max) throw new Error(`${key}: ${field.min}~${field.max} 범위가 필요합니다.`)
    if (value === field.value) continue
    changes.push({ key, before: field.value, after: value })
    replacements.push({ start: field.start, end: field.end, value: String(value) })
  }
  if (!changes.length) throw new Error('변경된 값이 없습니다.')
  let text = xml
  for (const replace of replacements.sort((a, b) => b.start - a.start)) text = text.slice(0, replace.start) + replace.value + text.slice(replace.end)
  validateXmpXml(text)
  return { text, changes, fields }
}

interface DocumentGrant { path: string; dev: number; ino: number; hash: string }
interface Staged { documentId: string; proposal: XmpProposal; createdAt: number }
interface Operation { documentId: string; before: string; afterHash: string; journal: string }

export class XmpPatchService {
  private documents = new Map<string, DocumentGrant>()
  private staged = new Map<string, Staged>()
  private operations = new Map<string, Operation>()
  constructor(private readonly historyDirectory: string) {}

  private async assertDocument(id: string): Promise<DocumentGrant> {
    const grant = this.documents.get(id)
    if (!grant) throw new Error('XMP 파일을 먼저 선택해 주세요.')
    const stat = await fs.lstat(grant.path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== grant.dev || stat.ino !== grant.ino || await fs.realpath(grant.path) !== grant.path) throw new Error('XMP 파일 위치가 변경되었습니다. 다시 선택해 주세요.')
    return grant
  }

  private review(id: string, grant: DocumentGrant, xml: string): XmpReview {
    const fields = numericFields(xml).map(({ key, value, min, max }) => ({ key, value, min, max }))
    let mapped: string[] = [], ignored: string[] = []
    try { ({ mapped, ignored } = importXmp(xml, path.basename(grant.path))) }
    catch { ignored = ['현재 가져오기가 지원하지 않는 namespace 접두사 또는 RDF 구조'] }
    return { documentId: id, fileName: path.basename(grant.path), hash: contentHash(xml), fields, mapped, ignored }
  }

  async open(selectedPath: string): Promise<XmpReview> {
    if (path.extname(selectedPath).toLowerCase() !== '.xmp') throw new Error('사진 프리셋 XMP 파일만 선택해 주세요.')
    const source = await fs.realpath(selectedPath)
    if (source !== selectedPath) throw new Error('XMP 심볼릭 링크는 허용하지 않습니다.')
    const bytes = await readRegularFile(source, 4 * 1024 * 1024)
    if (!bytes) throw new Error('XMP 파일을 찾을 수 없습니다.')
    const xml = decodeUtf8(bytes)
    const stat = await fs.lstat(source)
    const id = randomUUID(), grant = { path: source, dev: stat.dev, ino: stat.ino, hash: contentHash(bytes) }
    const review = this.review(id, grant, xml)
    if (this.documents.size >= 24) this.documents.delete(this.documents.keys().next().value!)
    this.documents.set(id, grant)
    return review
  }

  async propose(documentId: string, patch: Record<string, number>): Promise<XmpProposal> {
    const grant = await this.assertDocument(documentId)
    const bytes = await readRegularFile(grant.path, 4 * 1024 * 1024)
    if (!bytes || contentHash(bytes) !== grant.hash) throw new Error('XMP가 변경되었습니다. 다시 선택해 주세요. (충돌)')
    const before = decodeUtf8(bytes)
    const result = proposeXmpText(before, patch)
    const proposal: XmpProposal = { proposalId: randomUUID(), fileName: path.basename(grant.path), beforeHash: contentHash(bytes), afterHash: contentHash(result.text), changes: result.changes, before, after: result.text }
    if (this.staged.size >= 24) this.staged.delete(this.staged.keys().next().value!)
    this.staged.set(proposal.proposalId, { documentId, proposal, createdAt: Date.now() })
    return proposal
  }

  async apply(proposalId: string): Promise<XmpApplyResult> {
    const staged = this.staged.get(proposalId)
    if (!staged || Date.now() - staged.createdAt > 15 * 60 * 1000) throw new Error('수정안이 만료되었습니다. 미리보기를 다시 생성해 주세요.')
    const source = await this.assertDocument(staged.documentId)
    return serializeFile(`xmp:${source.path}`, async () => {
      if (!this.staged.delete(proposalId)) throw new Error('이미 처리된 수정안입니다.')
      const grant = await this.assertDocument(staged.documentId)
      const operationId = randomUUID()
      await fs.mkdir(this.historyDirectory, { recursive: true })
      const journal = path.join(this.historyDirectory, `${operationId}.json`)
      const record = { operationId, filePath: grant.path, before: staged.proposal.before, afterHash: staged.proposal.afterHash, createdAt: new Date().toISOString(), status: 'prepared' }
      const journalHash = await atomicReplace(journal, JSON.stringify(record, null, 2), null, async () => {})
      await atomicReplace(grant.path, staged.proposal.after, staged.proposal.beforeHash, () => this.assertDocument(staged.documentId))
      const stat = await fs.lstat(grant.path)
      Object.assign(grant, { dev: stat.dev, ino: stat.ino, hash: staged.proposal.afterHash })
      this.operations.set(operationId, { documentId: staged.documentId, before: staged.proposal.before, afterHash: staged.proposal.afterHash, journal })
      await atomicReplace(journal, JSON.stringify({ ...record, status: 'applied' }, null, 2), journalHash, async () => {}).catch((error: Error) => console.warn('[xmp] history completion failed:', error.message))
      return { operationId, review: this.review(staged.documentId, grant, staged.proposal.after) }
    })
  }

  async undo(operationId: string): Promise<XmpReview> {
    const operation = this.operations.get(operationId)
    if (!operation) throw new Error('되돌릴 XMP 작업이 없습니다.')
    const source = await this.assertDocument(operation.documentId)
    return serializeFile(`xmp:${source.path}`, async () => {
      const grant = await this.assertDocument(operation.documentId)
      const hash = await atomicReplace(grant.path, operation.before, operation.afterHash, () => this.assertDocument(operation.documentId))
      const stat = await fs.lstat(grant.path)
      Object.assign(grant, { dev: stat.dev, ino: stat.ino, hash })
      this.operations.delete(operationId)
      const old = await readRegularFile(operation.journal)
      if (old) await atomicReplace(operation.journal, JSON.stringify({ ...JSON.parse(decodeUtf8(old)), status: 'undone' }, null, 2), contentHash(old), async () => {}).catch((error: Error) => console.warn('[xmp] undo history failed:', error.message))
      return this.review(operation.documentId, grant, operation.before)
    })
  }
}
