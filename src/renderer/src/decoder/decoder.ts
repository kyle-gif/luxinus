// Runs inside the hidden decode window (a real Chromium renderer) — the native
// environment libraw-wasm is built for (Web Worker + wasm fetch). Decodes RAW
// bytes handed over by main and returns RGB (proxy) or an embedded JPEG (thumb).
import LibRaw from 'libraw-wasm'
import { mapLibrawMeta, type RawDecodeResult } from '@shared/library'
import type { DecodeRequest, LuxDecoderApi } from '../../../preload/decoder'
import type { ExportRenderRequest } from '../../../shared/export'
import { exportRender } from './exportRender'

declare global {
  interface Window {
    luxDecoder: LuxDecoderApi
  }
}

const lux = window.luxDecoder

// Bound the decoded buffer to a safe size before it crosses IPC. Large sensors
// (e.g. 60MP ARW) produce a ~90MB RGB buffer; structured-cloning that over IPC
// can fail with "Array buffer allocation failed". We box-average down to the
// proxy/thumb size here so only a small buffer is ever transferred, and the
// worker's sharp step just fine-tunes it.
function downscaleRGB(
  src: Uint8Array,
  w: number,
  h: number,
  channels: number,
  maxEdge: number
): { data: Uint8Array; width: number; height: number; channels: number } {
  const long = Math.max(w, h)
  if (long <= maxEdge) return { data: src, width: w, height: h, channels }
  const scale = maxEdge / long
  const dw = Math.max(1, Math.round(w * scale))
  const dh = Math.max(1, Math.round(h * scale))
  const out = new Uint8Array(dw * dh * 3)
  const bx = w / dw
  const by = h / dh
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * by)
    const sy1 = Math.min(h, Math.floor((y + 1) * by) + 1)
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * bx)
      const sx1 = Math.min(w, Math.floor((x + 1) * bx) + 1)
      let r = 0, g = 0, b = 0, n = 0
      for (let sy = sy0; sy < sy1; sy++) {
        let si = (sy * w + sx0) * channels
        for (let sx = sx0; sx < sx1; sx++) {
          r += src[si]
          g += src[si + 1]
          b += src[si + 2]
          n++
          si += channels
        }
      }
      const di = (y * dw + x) * 3
      out[di] = r / n
      out[di + 1] = g / n
      out[di + 2] = b / n
    }
  }
  return { data: out, width: dw, height: dh, channels: 3 }
}

async function handle(req: DecodeRequest): Promise<void> {
  const raw = new LibRaw()
  try {
    await raw.open(new Uint8Array(req.bytes), {
      useCameraWb: true,
      outputColor: 1, // sRGB
      outputBps: 8,
      userQual: 3, // AHD demosaic
      halfSize: true // fast, still ≥2560px on most sensors
    })
    const meta = mapLibrawMeta(((await raw.metadata()) ?? {}) as unknown as Record<string, unknown>)
    const payload: { id: string } & RawDecodeResult = { id: req.id, meta }

    const embeddedJpeg = async (): Promise<Uint8Array | null> => {
      const t = await raw.thumbnailData().catch(() => null)
      return t && t.format === 'jpeg' && t.data && t.data.length > 0 ? (t.data as Uint8Array) : null
    }

    // Thumbnails prefer the embedded JPEG (fastest, no demosaic).
    if (req.mode === 'thumb') {
      const jpeg = await embeddedJpeg()
      if (jpeg) {
        payload.thumbJpeg = jpeg
        lux.result(payload)
        return
      }
    }

    // Proxy (or thumb without an embedded JPEG): full LibRaw demosaic, then
    // downscale to a safe transfer size (prevents huge-buffer OOM over IPC).
    const img = await raw.imageData().catch(() => null)
    if (img && img.data && img.data.length > 0) {
      const maxEdge = req.mode === 'thumb' ? 512 : 2560
      const ds = downscaleRGB(
        img.data as Uint8Array,
        img.width,
        img.height,
        img.colors,
        maxEdge
      )
      payload.rgb = ds.data
      payload.width = ds.width
      payload.height = ds.height
      payload.channels = ds.channels
      lux.result(payload)
      return
    }

    // Graceful fallback: some very new/unsupported cameras can't be demosaiced by
    // this LibRaw build — fall back to the embedded preview so the photo still shows.
    const jpeg = await embeddedJpeg()
    if (jpeg) {
      payload.thumbJpeg = jpeg
      lux.result(payload)
      return
    }
    throw new Error('This RAW variant is not supported yet (no decodable image or embedded preview).')
  } catch (e) {
    lux.fail({ id: req.id, message: e instanceof Error ? e.message : String(e) })
  } finally {
    raw.dispose()
  }
}

async function handleExport(req: ExportRenderRequest): Promise<void> {
  try {
    const result = await exportRender(req)
    lux.exportResult({ id: req.id, ...result })
  } catch (e) {
    lux.exportFail({ id: req.id, message: e instanceof Error ? e.message : String(e) })
  }
}

lux.onDecode((req) => {
  void handle(req)
})
lux.onExport((req) => {
  void handleExport(req)
})
lux.ready()
