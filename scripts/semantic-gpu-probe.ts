import { defaultEditState, zeroMaskAdjust, type EditState, type Mask } from '../src/shared/edits'
import { PORTRAIT_REGIONS, encodeSemanticCoverage } from '../src/shared/portrait'
import { bakeBrushTexture, buildEditProgram, maskSlotIndex, setEditUniforms, uploadCurveLut } from '../src/renderer/src/lib/editShader'
import { bakeSemanticTexture } from '../src/renderer/src/lib/semanticAtlas'

const W = 64, H = 48
function draw(edit: EditState, source: Uint8Array, preview = -1): Uint8Array {
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })!
  if (!gl) throw Error('Real WebGL unavailable')
  try {
    const program = buildEditProgram(gl)
    if (!program) throw Error('Production edit shader compile/link failed')
    const upload = (unit: number, bytes: Uint8Array, w: number, h: number) => {
      gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture()); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, bytes)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    upload(gl.TEXTURE0, source, W, H); upload(gl.TEXTURE3, new Uint8Array([0, 0, 0, 255]), 1, 1)
    const useLut = uploadCurveLut(gl, gl.createTexture()!, edit)
    bakeBrushTexture(gl, gl.createTexture()!, edit, W / H)
    bakeSemanticTexture(gl, gl.createTexture()!, edit)
    setEditUniforms(gl, program.U, edit, useLut, { imgW: W, imgH: H, compare: 0, maskPreview: preview, overlayMode: 1 })
    gl.viewport(0, 0, W, H); gl.drawArrays(gl.TRIANGLES, 0, 3)
    const result = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, result)
    if (gl.getError() !== gl.NO_ERROR) throw Error('Semantic render emitted WebGL error')
    return result
  } finally { gl.getExtension('WEBGL_lose_context')?.loseContext() }
}
function image(gray: Uint8Array): Uint8Array {
  const out = new Uint8Array(W * H * 4)
  for (let i = 0; i < gray.length; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = gray[i]; out[i * 4 + 3] = 255 }
  return out
}
function mask(coverage: Uint8Array, index: number): Mask {
  return { id: `semantic-${index}`, name: `region ${index}`, kind: 'semantic', enabled: true, adjust: { ...zeroMaskAdjust(), exposure: 40 }, semantic: {
    version: 1, space: 'source', encoding: 'gray8-base64', width: W, height: H, coverage: encodeSemanticCoverage(coverage),
    region: PORTRAIT_REGIONS[index % PORTRAIT_REGIONS.length], bounds: { x: 0, y: 0, width: 1, height: 1 }, modelFingerprint: 'synthetic-probe:' + 'a'.repeat(64),
    source: { pathHash: 'b'.repeat(64), mtimeMs: 1, ctimeMs: 1, size: 1, dev: 1, ino: 1 }, inputHash: 'c'.repeat(64)
  } }
}
;(window as unknown as { runSemanticProbe(): unknown }).runSemanticProbe = () => {
  const original = image(new Uint8Array(W * H).fill(64))
  const base = defaultEditState()
  const masks = PORTRAIT_REGIONS.map((_region, index) => {
    const coverage = new Uint8Array(W * H)
    for (let y = 0; y < H / 2; y++) for (let x = index * 8; x < (index + 1) * 8; x++) coverage[y * W + x] = 255
    return mask(coverage, index)
  })
  masks.push({ id: 'brush', name: 'manual brush', kind: 'brush', enabled: true, adjust: { ...zeroMaskAdjust(), exposure: 40 }, brush: { strokes: [{ points: [{ x: .5, y: .8 }], radius: .1, erase: false }] } })
  const all = { ...base, masks }, rendered = draw(all, original)
  const stripeValues: number[] = []
  for (let i = 0; i < 8; i++) {
    const x = i * 8 + 4, y = H - 1 - 8
    const value = rendered[(y * W + x) * 4]; stripeValues.push(value)
    if (value <= 70) throw Error(`Semantic region ${i + 1} was dropped: ${value}`)
  }
  const brushValue = rendered[((H - 1 - Math.floor(.8 * H)) * W + W / 2) * 4]
  if (brushValue <= 70) throw Error(`Manual brush alongside eight semantic masks was dropped: ${brushValue}`)
  const coverage = new Uint8Array(W * H)
  for (let y = 6; y < 33; y++) for (let x = 7; x < 25; x++) coverage[y * W + x] = 255
  const semantic = mask(coverage, 0), transforms: unknown[] = []
  for (const geometry of [{}, { flipH: true }, { flipV: true }, { rotate: 27 }, { rotate: -90, flipH: true }, { crop: { x: .1, y: .2, w: .6, h: .7 }, rotate: 17, flipV: true }]) {
    const edit = { ...base, ...geometry, masks: [semantic] }
    const overlay = draw(edit, original, maskSlotIndex(edit, semantic.id))
    const reference = draw({ ...edit, masks: [] }, image(coverage))
    let maxDelta = 0, white = 0
    for (let i = 0; i < reference.length; i += 4) { maxDelta = Math.max(maxDelta, Math.abs(overlay[i] - reference[i])); if (reference[i] > 240) white++ }
    if (maxDelta > 2 || !white) throw Error(`Source-space mask moved from source under ${JSON.stringify(geometry)}: delta ${maxDelta}`)
    transforms.push({ geometry, maxChannelDelta: maxDelta, whitePixels: white })
  }
  return { passed: true, actualProductionWebGLShader: true, eightSemanticMasksAndManualBrush: true, stripeValues, brushValue, transforms }
}
