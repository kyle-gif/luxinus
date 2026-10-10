import { useEffect, useRef } from 'react'
import type { EditState } from '../../types'
import { useStore } from '../../store/useStore'
import {
  bakeBrushTexture,
  brushStrokeHash,
  buildEditProgram,
  setEditUniforms,
  uploadCurveLut,
  type EditUniforms
} from '../../lib/editShader'
import { bakeSemanticTexture, semanticTextureKey } from '../../lib/semanticAtlas'

// Live-histogram readback target. Small — we only need the distribution.
const HW = 192
const HH = 128
const HIST_BINS = 64

function computeHistogram(buf: Uint8Array): {
  r: number[]
  g: number[]
  b: number[]
  lum: number[]
} {
  const r = new Array(HIST_BINS).fill(0)
  const g = new Array(HIST_BINS).fill(0)
  const b = new Array(HIST_BINS).fill(0)
  const lum = new Array(HIST_BINS).fill(0)
  const shift = 8 - Math.log2(HIST_BINS) // 256 → HIST_BINS
  for (let i = 0; i < buf.length; i += 4) {
    const rv = buf[i]
    const gv = buf[i + 1]
    const bv = buf[i + 2]
    r[rv >> shift]++
    g[gv >> shift]++
    b[bv >> shift]++
    lum[(((rv * 54 + gv * 183 + bv * 19) >> 8) & 0xff) >> shift]++
  }
  return { r, g, b, lum }
}

// Real-time WebGL develop renderer. The decoded proxy is uploaded once as a
// texture; every edit runs through the shared edit shader (identical to export),
// so slider drags update at frame rate. Full-resolution rendering happens only
// at export using the same shader module.

interface EditCanvasProps {
  imageUrl: string
  edit: EditState
  compareMode: 0 | 1 | 2
  splitPos: number
  /** Mask slot to show as a coverage overlay, or -1 for none. */
  maskPreview?: number
  /** Overlay rendering: 0 red-on-image · 1 white-on-black · 2 black-on-white. */
  overlayMode?: number
  /** Zebra-stripe clipped pixels (red blown · blue crushed). */
  showClip?: boolean
  /** A denoised copy of the source (data URL) blended in by the Denoise slider. */
  denoiseUrl?: string | null
  /** Comparison snapshots must not overwrite the current edit histogram. */
  publishHistogram?: boolean
  className?: string
}

export function EditCanvas({
  imageUrl,
  edit,
  compareMode,
  splitPos,
  maskPreview = -1,
  overlayMode = 0,
  showClip = false,
  denoiseUrl = null,
  publishHistogram = true,
  className = ''
}: EditCanvasProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<{
    gl: WebGLRenderingContext
    U: EditUniforms
    lutTex: WebGLTexture
    brushTex: WebGLTexture
    semanticTex: WebGLTexture
    denoiseTex: WebGLTexture
    /** The proxy texture on unit 0 — replaced (and deleted) per photo. */
    imgTex: WebGLTexture | null
    hasDenoise: boolean
    histFbo: WebGLFramebuffer
    histTex: WebGLTexture
    histBuf: Uint8Array
    imgW: number
    imgH: number
  } | null>(null)
  const editRef = useRef(edit)
  const cmpRef = useRef(compareMode)
  const splitRef = useRef(splitPos)
  const maskPrevRef = useRef(maskPreview)
  const overlayModeRef = useRef(overlayMode)
  const showClipRef = useRef(showClip)
  const publishHistogramRef = useRef(publishHistogram)
  editRef.current = edit
  cmpRef.current = compareMode
  splitRef.current = splitPos
  maskPrevRef.current = maskPreview
  overlayModeRef.current = overlayMode
  showClipRef.current = showClip
  publishHistogramRef.current = publishHistogram

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const canvas = cv
    const ctx = canvas.getContext('webgl', { preserveDrawingBuffer: true })
    if (!ctx) return
    const gl = ctx
    const built = buildEditProgram(gl)
    if (!built) return
    const lutTex = gl.createTexture()!
    const brushTex = gl.createTexture()!
    const semanticTex = gl.createTexture()!
    const denoiseTex = gl.createTexture()!
    // Bind a 1×1 placeholder on unit 3 so the sampler is always complete.
    gl.activeTexture(gl.TEXTURE3)
    gl.bindTexture(gl.TEXTURE_2D, denoiseTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0]))
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    // Offscreen render target for the live histogram (readback source).
    const histTex = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE7)
    gl.bindTexture(gl.TEXTURE_2D, histTex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, HW, HH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const histFbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, histFbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, histTex, 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    glRef.current = {
      gl,
      U: built.U,
      lutTex,
      brushTex,
      semanticTex,
      denoiseTex,
      imgTex: null,
      hasDenoise: false,
      histFbo,
      histTex,
      histBuf: new Uint8Array(HW * HH * 4),
      imgW: 1,
      imgH: 1
    }
    return () => {
      // Release every GPU object, then drop the context itself. Without this a
      // remount leaks the whole set and browsers cap live WebGL contexts.
      const ctx = glRef.current
      if (ctx?.imgTex) gl.deleteTexture(ctx.imgTex)
      gl.deleteTexture(lutTex)
      gl.deleteTexture(brushTex)
      gl.deleteTexture(semanticTex)
      gl.deleteTexture(denoiseTex)
      gl.deleteTexture(histTex)
      gl.deleteFramebuffer(histFbo)
      gl.deleteProgram(built.prog)
      glRef.current = null
      // NB: don't loseContext() here. The canvas element survives a StrictMode
      // remount, so the re-run effect would get the same, now-dead context back.
      // The context is released with the canvas anyway.
    }
  }, [])

  // Upload the proxy image as a texture whenever it changes. The previous one is
  // deleted first — creating a fresh texture per photo without releasing the old
  // leaked a full-size GPU allocation on every selection change.
  useEffect(() => {
    const ctx = glRef.current
    if (!ctx) return
    const { gl } = ctx
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      // A fast photo switch can land this load after the effect was torn down;
      // applying it would resize the canvas to the wrong (stale) photo.
      if (cancelled || glRef.current !== ctx) return
      if (ctx.imgTex) gl.deleteTexture(ctx.imgTex)
      const tex = gl.createTexture()
      ctx.imgTex = tex
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      ctx.imgW = img.naturalWidth
      ctx.imgH = img.naturalHeight
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    img.src = imageUrl
    return () => {
      cancelled = true
    }
  }, [imageUrl])

  // Upload the denoised source onto texture unit 3 when it changes (or clear it).
  useEffect(() => {
    const ctx = glRef.current
    if (!ctx) return
    const { gl } = ctx
    if (!denoiseUrl) {
      ctx.hasDenoise = false
      return
    }
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      // Guard the race: without this a load that resolves after the photo
      // changed re-enables denoise using the previous photo's pixels.
      if (cancelled || glRef.current !== ctx) return
      gl.activeTexture(gl.TEXTURE3)
      gl.bindTexture(gl.TEXTURE_2D, ctx.denoiseTex)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      ctx.hasDenoise = true
    }
    img.src = denoiseUrl
    return () => {
      cancelled = true
      ctx.hasDenoise = false
    }
  }, [denoiseUrl])

  // rAF loop with a DIRTY GATE: the shader only draws when an input actually
  // changed (edit state is immutable, so reference equality is exact). An idle
  // app renders zero frames instead of re-running the full develop pipeline at
  // 60fps — this was the renderer's biggest steady-state GPU/CPU cost.
  useEffect(() => {
    let raf = 0
    let lastKey = ''
    let lastBrush = 'init' // force an initial bake (binds a valid unit-2 texture)
    let lastSemantic = 'init'
    let useLut = false
    let lastHist = 0
    let lastSig: unknown[] = []
    let histDirty = true
    function frame(now: number): void {
      const ctx = glRef.current
      if (ctx && ctx.imgW > 1) {
        const { gl, U } = ctx
        const e = editRef.current
        const sig = [
          e, cmpRef.current, splitRef.current, maskPrevRef.current,
          overlayModeRef.current, showClipRef.current, ctx.hasDenoise, ctx.imgW, ctx.imgH
        ]
        const dirty = lastSig.length !== sig.length || sig.some((v, i) => v !== lastSig[i])
        if (dirty) {
          lastSig = sig
          histDirty = true
          const key = JSON.stringify(e.curves)
          if (key !== lastKey) {
            lastKey = key
            useLut = uploadCurveLut(gl, ctx.lutTex, e)
          }
          const dispAspect = (ctx.imgW / ctx.imgH) * (e.crop ? e.crop.w / e.crop.h : 1)
          const bkey = `${brushStrokeHash(e)}@${dispAspect.toFixed(4)}`
          if (bkey !== lastBrush) {
            lastBrush = bkey
            bakeBrushTexture(gl, ctx.brushTex, e, dispAspect)
          }
          const semanticKey = semanticTextureKey(e)
          if (semanticKey !== lastSemantic) {
            lastSemantic = semanticKey
            bakeSemanticTexture(gl, ctx.semanticTex, e)
          }
          setEditUniforms(gl, U, e, useLut, {
            imgW: ctx.imgW,
            imgH: ctx.imgH,
            compare: cmpRef.current,
            split: splitRef.current,
            maskPreview: maskPrevRef.current,
            overlayMode: overlayModeRef.current,
            showClip: showClipRef.current,
            hasDenoise: ctx.hasDenoise
          })
          gl.drawArrays(gl.TRIANGLES, 0, 3)
        }

        // Real histogram: re-render the edited image (compare off) into a tiny
        // offscreen target, read it back, and bin. Throttled AND change-gated.
        if (publishHistogramRef.current && histDirty && now - lastHist > 160) {
          lastHist = now
          histDirty = false
          gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.histFbo)
          gl.viewport(0, 0, HW, HH)
          setEditUniforms(gl, U, e, useLut, {
            imgW: ctx.imgW,
            imgH: ctx.imgH,
            compare: 0,
            maskPreview: -1,
            hasDenoise: ctx.hasDenoise
          })
          gl.drawArrays(gl.TRIANGLES, 0, 3)
          gl.readPixels(0, 0, HW, HH, gl.RGBA, gl.UNSIGNED_BYTE, ctx.histBuf)
          gl.bindFramebuffer(gl.FRAMEBUFFER, null)
          const cv = canvasRef.current
          if (cv) gl.viewport(0, 0, cv.width, cv.height)
          useStore.getState().setHistogram(computeHistogram(ctx.histBuf))
        }
      }
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return <canvas ref={canvasRef} className={className} />
}
