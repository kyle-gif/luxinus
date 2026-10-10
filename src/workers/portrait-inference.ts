import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { InferenceSession, Tensor } from 'onnxruntime-node'
import { PORTRAIT_MODELS, PORTRAIT_MODEL_FINGERPRINT, PORTRAIT_SESSION_OPTIONS, type PortraitModelKey, type PortraitModelPaths } from '../shared/portrait-model'
import { PORTRAIT_REGIONS, type PortraitInferenceInput, type PortraitInferenceResult, type PortraitRegion } from '../shared/portrait'
import { classify, coverageBounds, decodeFaces, faceFrame, portraitTensor, sourceToModel, squareFrame } from './portrait-pixels'

const ort = require('onnxruntime-node') as typeof import('onnxruntime-node')
const sessions = new Map<PortraitModelKey, { path: string; session: InferenceSession }>()
async function modelSession(key: PortraitModelKey, file: string): Promise<InferenceSession> {
  const existing = sessions.get(key)
  if (existing?.path === file) return existing.session
  if (existing) { await existing.session.release(); sessions.delete(key) }
  const bytes = await readFile(file), model = PORTRAIT_MODELS[key]
  if (bytes.length !== model.bytes || createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error(`${model.id} 인물 모델 체크섬이 다릅니다.`)
  const session = await ort.InferenceSession.create(bytes, { ...PORTRAIT_SESSION_OPTIONS, executionProviders: [...PORTRAIT_SESSION_OPTIONS.executionProviders] })
  sessions.set(key, { path: file, session })
  return session
}

async function infer(session: InferenceSession, pixels: Float32Array, size: number, outputNames?: string[]): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>> {
  if (session.inputNames.length !== 1) throw new Error('인물 모델 입력 규격이 올바르지 않습니다.')
  const input: Tensor = new ort.Tensor('float32', pixels, [1, 3, size, size])
  let output: InferenceSession.OnnxValueMapType | undefined
  try {
    const feeds = { [session.inputNames[0]]: input }
    output = outputNames ? await session.run(feeds, outputNames) : await session.run(feeds)
    const result: Record<string, { data: Float32Array; dims: readonly number[] }> = {}
    for (const [name, value] of Object.entries(output)) {
      if (value.type !== 'float32') throw new Error('인물 모델 출력은 float32여야 합니다.')
      result[name] = { data: new Float32Array(value.data as Float32Array), dims: [...value.dims] }
    }
    return result
  } finally { input.dispose(); if (output) for (const value of Object.values(output)) value.dispose() }
}

function segmentation(output: { data: Float32Array; dims: readonly number[] } | undefined, classes: number) {
  if (!output || output.dims.length !== 4 || output.dims[0] !== 1 || output.dims[1] !== classes || output.dims[2] < 1 || output.dims[3] < 1) throw new Error('인물 분할 출력 크기가 올바르지 않습니다.')
  return { ...classify(output.data, classes, output.dims[3], output.dims[2]), width: output.dims[3], height: output.dims[2] }
}

export async function inferPortrait(input: PortraitInferenceInput, paths: PortraitModelPaths): Promise<PortraitInferenceResult> {
  const { rgba, width: sourceWidth, height: sourceHeight } = input
  const scale = Math.min(1, 512 / Math.max(sourceWidth, sourceHeight)), width = Math.max(1, Math.round(sourceWidth * scale)), height = Math.max(1, Math.round(sourceHeight * scale))
  const maps = Object.fromEntries(PORTRAIT_REGIONS.map(region => [region, new Uint8Array(width * height)])) as Record<PortraitRegion, Uint8Array>
  const frame = squareFrame(sourceWidth, sourceHeight)
  const warnings: string[] = []

  // The original SCHP extractor reads BGR with these per-channel constants.
  // Keep source aspect ratio by padding the square, then map back to source UV.
  const bodySession = await modelSession('body', paths.body)
  const bodyOutput = await infer(bodySession, portraitTensor(rgba, sourceWidth, sourceHeight, 512, frame, [2, 1, 0], [.406, .456, .485], [.225, .224, .229]), 512, ['logits'])
  const body = segmentation(bodyOutput.logits, 18)
  const projectedLabels = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = y * width + x, source = sourceToModel(x, y, sourceWidth, sourceHeight, width, height, frame, body.width, body.height)
    if (source < 0 || body.confidence[source] < 128) continue
    const label = body.labels[source], value = body.confidence[source]
    projectedLabels[i] = label
    if (label !== 0) maps.person[i] = value
    if (label === 11) maps.face[i] = value
    if ([12, 13, 14, 15].includes(label)) maps.skin[i] = value
    if ([1, 4, 5, 6, 7, 8, 9, 10, 17].includes(label)) maps.clothes[i] = value
    if (label === 2) maps.hair[i] = value
  }
  const detector = await modelSession('detector', paths.detector)
  const detectorOutput = await infer(detector, portraitTensor(rgba, sourceWidth, sourceHeight, 640, frame, [2, 1, 0], [0, 0, 0], [1, 1, 1], 1), 640)
  const detected = decodeFaces(Object.fromEntries(Object.entries(detectorOutput).map(([key, value]) => [key, value.data])), 640, frame)
    .filter(face => face.x + face.width > 0 && face.y + face.height > 0 && face.x < sourceWidth && face.y < sourceHeight)
  const faces = detected.filter(face => Math.min(face.width, face.height) >= 32).slice(0, 8)
  if (!faces.length) warnings.push('얼굴 세부를 충분히 확인하지 못했습니다. 작은 얼굴, 옆얼굴 또는 가려진 부위는 마스크가 없을 수 있습니다.')
  if (detected.length > faces.length) warnings.push('작은 얼굴 또는 8명을 넘는 얼굴의 세부 분석은 생략했습니다.')
  if (detected.length > 1) warnings.push('여러 얼굴을 합친 마스크입니다. 전신 분할 모델은 한 인물이 중심인 구도에 적합하므로 결과를 확인해 주세요.')

  if (faces.length) {
    const faceSession = await modelSession('face', paths.face)
    const refined = new Uint8Array(width * height)
    for (const face of faces) {
      const crop = faceFrame(face)
      const raw = await infer(faceSession, portraitTensor(rgba, sourceWidth, sourceHeight, 512, crop, [0, 1, 2], [.485, .456, .406], [.229, .224, .225]), 512, [faceSession.outputNames[0]])
      const parsed = segmentation(raw[faceSession.outputNames[0]], 19)
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const index = sourceToModel(x, y, sourceWidth, sourceHeight, width, height, crop, parsed.width, parsed.height)
        if (index < 0) continue
        const i = y * width + x, label = parsed.labels[index], value = parsed.confidence[index] >= 128 ? parsed.confidence[index] : 0
        const set = (region: PortraitRegion, labels: readonly number[]): void => { if (labels.includes(label)) maps[region][i] = Math.max(maps[region][i], value) }
        // Precise facial skin must not include eyes, lips or hair from the coarse face class.
        if (!refined[i] && projectedLabels[i] === 11) { maps.face[i] = 0; maps.skin[i] = 0 }
        refined[i] = 1
        set('face', [1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13])
        set('eyes', [4, 5]); set('nose', [10]); set('mouth', [11, 12, 13])
        set('skin', [1, 7, 8, 10, 14]); set('hair', [17])
        if (label !== 0) maps.person[i] = Math.max(maps.person[i], value)
      }
    }
  }
  const requested = input.regions ?? [...PORTRAIT_REGIONS]
  const regions = requested.flatMap(region => {
    const coverage = maps[region], bounds = coverageBounds(coverage, width, height)
    return bounds ? [{ region, coverage, bounds }] : []
  })
  if (!regions.length) warnings.push('선택한 부위를 찾지 못했습니다. 마스크를 만들지 않았습니다.')
  return { ok: true, width, height, regions, modelFingerprint: PORTRAIT_MODEL_FINGERPRINT, facesDetected: detected.length, warnings }
}
