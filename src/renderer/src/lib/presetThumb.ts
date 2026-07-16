import type { EditState } from '../../../shared/edits'
import { buildEditProgram, setEditUniforms, uploadCurveLut, type EditUniforms } from './editShader'

// Renders preset thumbnails through the SAME edit shader as the main preview,
// but from a SINGLE shared offscreen WebGL context — so a panel of N presets
// doesn't spawn N WebGL contexts (browsers cap those). The current photo's proxy
// is uploaded once; each preset renders to a small canvas → dataURL, cached.

const THUMB = 132 // px (square-ish tile; letterboxed by CSS)

interface Ctx {
  gl: WebGLRenderingContext
  U: EditUniforms
  lutTex: WebGLTexture
  imgW: number
  imgH: number
}

let ctx: Ctx | null = null
let canvas: HTMLCanvasElement | null = null
let sourceKey = '' // identifies which photo is currently uploaded
const cache = new Map<string, string>() // key: sourceKey|editHash → dataURL

function ensureCtx(): Ctx | null {
  if (ctx) return ctx
  canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true })
  if (!gl) return null
  const built = buildEditProgram(gl)
  if (!built) return null
  ctx = { gl, U: built.U, lutTex: gl.createTexture()!, imgW: 1, imgH: 1 }
  return ctx
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('thumb image load failed'))
    img.src = url
  })
}

// Upload a new source photo (call when the selected photo changes).
export async function setPresetSource(key: string, url: string): Promise<void> {
  const c = ensureCtx()
  if (!c || sourceKey === key) return
  const img = await loadImage(url)
  const { gl } = c
  const tex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  c.imgW = img.naturalWidth
  c.imgH = img.naturalHeight
  sourceKey = key
  cache.clear()
}

// Render one preset over the current source → dataURL (cached).
export function renderPresetThumb(edit: EditState, editHash: string): string | null {
  const c = ensureCtx()
  if (!c || c.imgW < 2 || !canvas) return null
  const key = `${sourceKey}|${editHash}`
  const hit = cache.get(key)
  if (hit) return hit

  const aspect = c.imgW / c.imgH
  let w = THUMB
  let h = THUMB
  if (aspect >= 1) h = Math.round(THUMB / aspect)
  else w = Math.round(THUMB * aspect)
  canvas.width = w
  canvas.height = h
  const { gl, U } = c
  gl.viewport(0, 0, w, h)
  const useLut = uploadCurveLut(gl, c.lutTex, edit)
  // Preset thumbnails ignore geometry so the framing stays comparable.
  const flat = { ...edit, crop: null, rotate: 0, flipH: false, flipV: false }
  setEditUniforms(gl, U, flat, useLut, { imgW: c.imgW, imgH: c.imgH, compare: 0 })
  gl.drawArrays(gl.TRIANGLES, 0, 3)
  const url = canvas.toDataURL('image/webp', 0.8)
  cache.set(key, url)
  return url
}
