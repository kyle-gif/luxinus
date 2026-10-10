import type { EditState, Mask } from '../../../shared/edits'
import { decodeSemanticCoverage, type SemanticGeom } from '../../../shared/portrait'

export const MAX_RENDERED_MASKS = 16
type Tile = { mask: Mask; x: number; y: number; rect: [number, number, number, number] }
export function semanticAtlasLayout(edit: EditState): { width: number; height: number; tiles: Tile[] } {
  const masks = edit.masks.filter(mask => mask.enabled && mask.kind === 'semantic' && mask.semantic).slice(0, MAX_RENDERED_MASKS)
  if (!masks.length) return { width: 1, height: 1, tiles: [] }
  const cols = Math.min(4, masks.length), rows = Math.ceil(masks.length / cols)
  const cellW = Math.max(...masks.map(mask => mask.semantic!.width)) + 2
  const cellH = Math.max(...masks.map(mask => mask.semantic!.height)) + 2
  const width = cols * cellW, height = rows * cellH
  return { width, height, tiles: masks.map((mask, index) => {
    const x = (index % cols) * cellW + 1, y = Math.floor(index / cols) * cellH + 1
    return { mask, x, y, rect: [x / width, y / height, mask.semantic!.width / width, mask.semantic!.height / height] }
  }) }
}
const identities = new WeakMap<SemanticGeom, { id: number; data: string; width: number; height: number }>()
let serial = 0
export function semanticTextureKey(edit: EditState): string {
  return edit.masks.filter(mask => mask.enabled && mask.kind === 'semantic' && mask.semantic).slice(0, MAX_RENDERED_MASKS).map(mask => {
    const geometry = mask.semantic!
    let entry = identities.get(geometry)
    if (!entry || entry.data !== geometry.coverage || entry.width !== geometry.width || entry.height !== geometry.height) {
      entry = { id: ++serial, data: geometry.coverage, width: geometry.width, height: geometry.height }; identities.set(geometry, entry)
    }
    return `${mask.id}:${entry.id}`
  }).join('|')
}
export function rasterizeSemanticAtlas(edit: EditState): { width: number; height: number; data: Uint8Array } {
  const layout = semanticAtlasLayout(edit)
  const data = new Uint8Array(layout.width * layout.height)
  for (const { mask, x, y } of layout.tiles) {
    const geometry = mask.semantic!, pixels = decodeSemanticCoverage(geometry)
    for (let row = 0; row < geometry.height; row++) data.set(pixels.subarray(row * geometry.width, (row + 1) * geometry.width), (y + row) * layout.width + x)
  }
  return { width: layout.width, height: layout.height, data }
}
/** One extra texture holds every semantic region, with isolated pixel borders. */
export function bakeSemanticTexture(gl: WebGLRenderingContext, texture: WebGLTexture, edit: EditState): void {
  const atlas = rasterizeSemanticAtlas(edit)
  if (Math.max(atlas.width, atlas.height) > gl.getParameter(gl.MAX_TEXTURE_SIZE)) throw new Error('인물 마스크 크기가 GPU 텍스처 제한을 초과합니다.')
  gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, texture)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, atlas.width, atlas.height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, atlas.data)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
}
