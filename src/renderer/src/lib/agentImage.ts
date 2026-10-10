import type { EditState } from '../types'
import { bakeBrushTexture, buildEditProgram, maskSlotIndex, setEditUniforms, uploadCurveLut } from './editShader'
import { bakeSemanticTexture } from './semanticAtlas'

/** Render the saved edit, independent of canvas zoom, comparison and overlays. */
export async function renderAgentImage(imageUrl: string, edit: EditState, restoredUrl: string | null, longEdge = 1536, options?: { overlayMaskId?: string }): Promise<string> {
  if (edit.denoise > 0 && !restoredUrl) throw new Error('노이즈 제거 미리보기가 준비되면 보낼 수 있습니다. 사진 포함을 끄면 텍스트만 보낼 수 있습니다.')
  const load = async (url: string): Promise<HTMLImageElement> => {
    const img = new Image(); img.src = url; await img.decode(); return img
  }
  const [source, restored] = await Promise.all([load(imageUrl), restoredUrl && edit.denoise > 0 ? load(restoredUrl) : null])
  const crop = edit.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const w = source.naturalWidth * crop.w, h = source.naturalHeight * crop.h
  const scale = Math.min(1, longEdge / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale))
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })
  if (!gl) throw new Error('현재 보정을 이미지로 만들 수 없습니다. 그래픽 미리보기를 확인해 주세요.')
  try {
    const built = buildEditProgram(gl)
    if (!built) throw new Error('현재 사진 보정을 렌더링하지 못했습니다.')
    const upload = (unit: number, img: HTMLImageElement | null): void => {
      gl.activeTexture(unit); gl.bindTexture(gl.TEXTURE_2D, gl.createTexture())
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      if (img) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img)
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]))
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    }
    upload(gl.TEXTURE0, source); upload(gl.TEXTURE3, restored)
    const useLut = uploadCurveLut(gl, gl.createTexture()!, edit)
    bakeBrushTexture(gl, gl.createTexture()!, edit, w / h)
    bakeSemanticTexture(gl, gl.createTexture()!, edit)
    setEditUniforms(gl, built.U, edit, useLut, { imgW: source.naturalWidth, imgH: source.naturalHeight, compare: 0, hasDenoise: !!restored, maskPreview: maskSlotIndex(edit, options?.overlayMaskId ?? null) })
    gl.viewport(0, 0, canvas.width, canvas.height); gl.drawArrays(gl.TRIANGLES, 0, 3)
    if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR) throw new Error('첨부 사진을 렌더링하지 못했습니다. 다시 시도해 주세요.')
    return canvas.toDataURL('image/jpeg', .88)
  } finally {
    // This disposable canvas is never remounted by React StrictMode.
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    canvas.width = 1; canvas.height = 1
  }
}
