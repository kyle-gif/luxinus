import LibRaw from 'libraw-wasm'
import bricolage from '../assets/fonts/bricolage.woff2?url'
import geistMono from '../assets/fonts/geistmono.woff2?url'
import { bakeBrushTexture, buildEditProgram, setEditUniforms, uploadCurveLut } from '../lib/editShader'
import type { ExportRenderRequest, ExportRenderResult, FrameField, FrameStyle } from '../../../shared/export'

// Full-resolution export render, run inside the hidden Chromium window (its
// native WebGL + font environment). Applies the SAME edit shader as the live
// preview at full res, then optionally composites the Frame-mode border and
// typographic shooting-info caption. Returns upright RGBA to main for encoding.

let fontsReady: Promise<void> | null = null
function ensureFonts(): Promise<void> {
  if (fontsReady) return fontsReady
  const style = document.createElement('style')
  style.textContent = `
    @font-face { font-family: 'Bricolage Grotesque'; src: url('${bricolage}') format('woff2'); font-weight: 300 800; }
    @font-face { font-family: 'Geist Mono'; src: url('${geistMono}') format('woff2'); font-weight: 400 600; }
  `
  document.head.appendChild(style)
  fontsReady = Promise.all([
    (document as Document).fonts.load('600 40px "Bricolage Grotesque"'),
    (document as Document).fonts.load('500 24px "Geist Mono"')
  ]).then(() => undefined)
  return fontsReady
}

async function sourceToCanvas(req: ExportRenderRequest): Promise<{
  tex: (gl: WebGLRenderingContext) => WebGLTexture
  w: number
  h: number
}> {
  if (req.isRaw) {
    const raw = new LibRaw()
    await raw.open(new Uint8Array(req.bytes), {
      useCameraWb: true,
      outputColor: 1,
      outputBps: 8,
      userQual: 3,
      halfSize: false // full resolution for export
    })
    const img = await raw.imageData()
    raw.dispose()
    if (!img || !img.data) throw new Error('RAW decode produced no pixels')
    const w = img.width
    const h = img.height
    const data = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength)
    const channels = img.colors
    return {
      w,
      h,
      tex: (gl) => {
        const t = gl.createTexture()!
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, t)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
        const fmt = channels === 4 ? gl.RGBA : gl.RGB
        gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, fmt, gl.UNSIGNED_BYTE, data)
        texParams(gl)
        return t
      }
    }
  }

  // Standard formats: Chromium decodes JPEG/PNG/WebP (and TIFF/HEIF are
  // pre-converted to PNG by main before reaching here).
  const bmp = await createImageBitmap(new Blob([new Uint8Array(req.bytes)]))
  return {
    w: bmp.width,
    h: bmp.height,
    tex: (gl) => {
      const t = gl.createTexture()!
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, bmp)
      texParams(gl)
      return t
    }
  }
}

function texParams(gl: WebGLRenderingContext): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
}

export async function exportRender(req: ExportRenderRequest): Promise<ExportRenderResult> {
  const src = await sourceToCanvas(req)
  const e = req.editState
  const crop = e.crop ?? { x: 0, y: 0, w: 1, h: 1 }

  // Output size from crop, capped to the requested long edge.
  let outW = Math.max(1, Math.round(src.w * crop.w))
  let outH = Math.max(1, Math.round(src.h * crop.h))
  if (req.longEdge > 0) {
    const scale = Math.min(1, req.longEdge / Math.max(outW, outH))
    outW = Math.max(1, Math.round(outW * scale))
    outH = Math.max(1, Math.round(outH * scale))
  }

  // WebGL edit render at full (capped) resolution.
  const glCanvas = document.createElement('canvas')
  glCanvas.width = outW
  glCanvas.height = outH
  const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true })
  if (!gl) throw new Error('WebGL unavailable for export')
  const built = buildEditProgram(gl)
  if (!built) throw new Error('export shader build failed')
  src.tex(gl)
  const lutTex = gl.createTexture()!
  const useLut = uploadCurveLut(gl, lutTex, e)
  const brushTex = gl.createTexture()!
  bakeBrushTexture(gl, brushTex, e, outW / outH)
  gl.viewport(0, 0, outW, outH)
  setEditUniforms(gl, built.U, e, useLut, { imgW: src.w, imgH: src.h, compare: 0 })
  gl.drawArrays(gl.TRIANGLES, 0, 3)

  // Composite to a 2D canvas (upright), adding the frame if requested.
  if (req.frame) {
    await ensureFonts()
    return frameComposite(glCanvas, outW, outH, req.frame.style, req.frame.fields)
  }
  return readback(glCanvas, outW, outH)
}

function readback(source: CanvasImageSource, w: number, h: number): ExportRenderResult {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.drawImage(source, 0, 0, w, h)
  const rgba = new Uint8Array(ctx.getImageData(0, 0, w, h).data.buffer)
  return { rgba, width: w, height: h }
}

// Frame mode: place the edited image on a bordered card with a typographic
// shooting-info caption. Two styles — Minimal White, Black Film.
function frameComposite(
  imgCanvas: HTMLCanvasElement,
  imgW: number,
  imgH: number,
  style: FrameStyle,
  fields: FrameField[]
): ExportRenderResult {
  const theme =
    style === 'film'
      ? { bg: '#0c0c0e', title: '#f0eef2', tech: '#b9b6c0', hair: 'rgba(255,255,255,0.12)' }
      : { bg: '#f6f4f1', title: '#161418', tech: '#4a4750', hair: 'rgba(0,0,0,0.12)' }

  const long = Math.max(imgW, imgH)
  const pad = Math.round(long * 0.05)
  const captionH = Math.round(long * 0.13)
  const outW = imgW + pad * 2
  const outH = imgH + pad + captionH

  const c = document.createElement('canvas')
  c.width = outW
  c.height = outH
  const ctx = c.getContext('2d')!
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, outW, outH)
  ctx.drawImage(imgCanvas, pad, pad, imgW, imgH)

  // caption geometry
  const cx = outW / 2
  const capTop = pad + imgH
  const titleField = fields.find((f) => f.label === 'Camera')
  const techFields = fields.filter((f) => f.label !== 'Camera')

  // hairline above caption
  ctx.strokeStyle = theme.hair
  ctx.lineWidth = Math.max(1, Math.round(long * 0.0012))
  ctx.beginPath()
  ctx.moveTo(pad, capTop + captionH * 0.12)
  ctx.lineTo(outW - pad, capTop + captionH * 0.12)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  if (titleField) {
    ctx.fillStyle = theme.title
    ctx.font = `600 ${Math.round(long * 0.026)}px "Bricolage Grotesque", sans-serif`
    ctx.fillText(titleField.value, cx, capTop + captionH * 0.42)
  }

  const techLine = techFields.map((f) => f.value).join('   ·   ')
  ctx.fillStyle = theme.tech
  ctx.font = `500 ${Math.round(long * 0.016)}px "Geist Mono", monospace`
  ctx.fillText(techLine, cx, capTop + captionH * 0.72)

  return readback(c, outW, outH)
}
