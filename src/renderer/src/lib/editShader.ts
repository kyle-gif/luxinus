import type { EditState, Mask } from '../../../shared/edits'
import { HSL_BAND_HUE, HSL_BANDS } from '../../../shared/edits'
import { buildCurveLut, curvesAreIdentity } from './curve'

// The Luxinus develop pipeline as WebGL shaders — the single source of truth for
// both the real-time preview (EditCanvas) and full-resolution export, so what
// you see is exactly what you export.
//
// compareMode: 0 = edited everywhere · 1 = original everywhere · 2 = split at uSplit.

export const EDIT_VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 1.0 - (aPos.y * 0.5 + 0.5));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`

export const EDIT_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform sampler2D uLut;
uniform vec2 uTexel;

uniform float uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
uniform float uTemp, uTint, uSaturation, uVibrance, uClarity, uSharpen, uVignette;
uniform float uDehaze, uTexture, uGrain;
uniform float uUseLut;
uniform vec3 uHsl[8];   // per band: hue, sat, lum  (-1..1)
uniform float uBandHue[8];

uniform int uCompare;   // 0 edited, 1 original, 2 split
uniform float uSplit;

// Geometry
uniform vec4 uCrop;     // x,y,w,h in 0..1 (whole image if 0,0,1,1)
uniform vec2 uFlip;     // 1 or -1 per axis
uniform float uRotate;  // straighten radians
uniform float uAspect;  // image w/h (for correct rotation about center)

// Local-adjustment masks (radial + linear; parametric, applied after develop).
// Brush masks are handled separately (they need a coverage texture).
uniform int uMaskCount;
uniform float uMKind[8];   // 0 radial, 1 linear, 2 brush
uniform vec4 uMGeoA[8];    // radial: cx,cy,rx,ry · linear: x1,y1,x2,y2
uniform vec4 uMGeoB[8];    // radial: feather, invert, -, -
uniform vec4 uMAdj0[8];    // exposure, contrast, highlights, shadows
uniform vec4 uMAdj1[8];    // whites, blacks, temperature, tint
uniform vec4 uMAdj2[8];    // saturation, clarity, -, -
// Brush coverage: up to 4 brush masks packed one-per-channel into uBrushTex;
// uMBrushSel selects a mask's channel (e.g. (1,0,0,0)) so dot() reads it.
uniform sampler2D uBrushTex;
uniform vec4 uMBrushSel[8];
uniform int uMaskPreview; // slot to show as a red coverage overlay, or -1

// AI denoise: a restored copy of the source, blended in by uDenoiseAmt (0..1).
uniform sampler2D uDenoiseTex;
uniform float uDenoiseAmt;
uniform float uHasDenoise;

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

vec3 rgb2hsl(vec3 c) {
  float mx = max(max(c.r, c.g), c.b);
  float mn = min(min(c.r, c.g), c.b);
  float h = 0.0, s = 0.0, l = (mx + mn) * 0.5;
  float d = mx - mn;
  if (d > 1e-5) {
    s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, s, l);
}
float hue2rgb(float p, float q, float t) {
  if (t < 0.0) t += 1.0;
  if (t > 1.0) t -= 1.0;
  if (t < 1.0 / 6.0) return p + (q - p) * 6.0 * t;
  if (t < 1.0 / 2.0) return q;
  if (t < 2.0 / 3.0) return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
  return p;
}
vec3 hsl2rgb(vec3 hsl) {
  float h = hsl.x, s = hsl.y, l = hsl.z;
  if (s < 1e-5) return vec3(l);
  float q = l < 0.5 ? l * (1.0 + s) : l + s - l * s;
  float p = 2.0 * l - q;
  return vec3(hue2rgb(p, q, h + 1.0 / 3.0), hue2rgb(p, q, h), hue2rgb(p, q, h - 1.0 / 3.0));
}

// Map view uv → source texel coord, applying crop, straighten, and flips.
vec2 mapCoord(vec2 uv) {
  vec2 c = uCrop.xy + uv * uCrop.zw;
  if (abs(uRotate) > 0.0001) {
    vec2 p = (c - 0.5) * vec2(uAspect, 1.0);
    float s = sin(uRotate), co = cos(uRotate);
    p = mat2(co, -s, s, co) * p;
    float cover = abs(sin(uRotate)) * (uAspect > 1.0 ? 1.0 / uAspect : uAspect) + abs(cos(uRotate));
    p /= cover;
    c = p / vec2(uAspect, 1.0) + 0.5;
  }
  return clamp(vec2(uFlip.x < 0.0 ? 1.0 - c.x : c.x, uFlip.y < 0.0 ? 1.0 - c.y : c.y), 0.0, 1.0);
}

// The true original source (no denoise) — used by before/after compare.
vec3 sampleImg(vec2 uv) {
  return texture2D(uTex, mapCoord(uv)).rgb;
}

// Source with AI denoise blended in (part of the edit) — used by develop().
vec3 sampleSource(vec2 uv) {
  vec2 fc = mapCoord(uv);
  vec3 col = texture2D(uTex, fc).rgb;
  if (uHasDenoise > 0.5 && uDenoiseAmt > 0.001) {
    col = mix(col, texture2D(uDenoiseTex, fc).rgb, uDenoiseAmt);
  }
  return col;
}

vec3 develop(vec2 uv) {
  vec3 col = sampleSource(uv);

  // White balance. +temp = warmer (more red, less blue). +tint = magenta
  // (less green, more red/blue), matching Lightroom's direction.
  col.r *= 1.0 + uTemp * 0.35;
  col.b *= 1.0 - uTemp * 0.35;
  col.g *= 1.0 - uTint * 0.22;
  col.r *= 1.0 + uTint * 0.11;
  col.b *= 1.0 + uTint * 0.11;

  // Exposure (stops) — a photographic exposure is a LINEAR-light multiply, so
  // convert out of sRGB gamma, scale, and back. Doing this in gamma space (as
  // before) shifted midtones oddly and clipped highlights unnaturally.
  if (abs(uExposure) > 0.0001) {
    vec3 lin = pow(max(col, 0.0), vec3(2.2)) * pow(2.0, uExposure);
    // Soft clip in LINEAR light: near-identity below the knee, asymptotes to 1 so
    // overexposed values roll off smoothly. Monotonic — pushing exposure never
    // darkens a pixel — and leaves un-clipped tones essentially untouched.
    vec3 e = max(lin - 0.9, 0.0);
    lin = min(lin, vec3(0.9)) + 0.1 * (e / (e + 0.1));
    col = pow(lin, vec3(1.0 / 2.2));
  }

  // Contrast — S-curve pivoting on mid-grey (0.5), Lightroom-like.
  col = (col - 0.5) * (1.0 + uContrast) + 0.5;

  // Tonal regions. Every slider brightens its region when POSITIVE (Lightroom
  // convention): +highlights brightens highlights, +shadows lifts shadows,
  // +whites pushes the white point up, +blacks lifts blacks (−blacks crushes).
  float l = clamp(dot(col, LUM), 0.0, 1.0);
  // Broad, overlapping tonal masks so Highlights/Shadows act through the whole
  // upper/lower range (not just the extremes) — this is what makes them read as
  // "working" on ordinary midtone subjects, matching Lightroom's feel. Whites and
  // Blacks stay tighter to the endpoints.
  float wHi = smoothstep(0.25, 0.9, l);        // highlights: upper half and up
  float wSh = 1.0 - smoothstep(0.1, 0.75, l);  // shadows: lower half and down
  float wWh = smoothstep(0.55, 1.0, l);        // whites (brights)
  float wBl = 1.0 - smoothstep(0.0, 0.45, l);  // blacks (darks)
  col += uHighlights * 0.5 * wHi;
  col += uShadows * 0.5 * wSh;
  col += uWhites * 0.4 * wWh;
  col += uBlacks * 0.4 * wBl;

  // Dehaze: +removes atmospheric veiling (pull the airlight ~ per-pixel min, add
  // contrast + saturation); −adds haze. A perceptual approximation, not physical.
  if (abs(uDehaze) > 0.001) {
    float airlight = min(min(col.r, col.g), col.b);
    col -= uDehaze * 0.35 * airlight;
    col = (col - 0.5) * (1.0 + uDehaze * 0.45) + 0.5;
    float dl = dot(col, LUM);
    col = mix(vec3(dl), col, 1.0 + uDehaze * 0.4);
  }

  col = clamp(col, 0.0, 1.0);

  if (uUseLut > 0.5) {
    col.r = texture2D(uLut, vec2(col.r, 0.5)).r;
    col.g = texture2D(uLut, vec2(col.g, 0.5)).r;
    col.b = texture2D(uLut, vec2(col.b, 0.5)).r;
    col.r = texture2D(uLut, vec2(col.r, 0.5)).g;
    col.g = texture2D(uLut, vec2(col.g, 0.5)).b;
    col.b = texture2D(uLut, vec2(col.b, 0.5)).a;
  }

  vec3 hsl = rgb2hsl(col);
  if (hsl.y > 0.01) {
    float hueDeg = hsl.x * 360.0;
    for (int i = 0; i < 8; i++) {
      float d = abs(hueDeg - uBandHue[i]);
      d = min(d, 360.0 - d);
      float w = 1.0 - smoothstep(0.0, 45.0, d);
      if (w > 0.0) {
        hsl.x += uHsl[i].x * 0.06 * w;
        hsl.y = clamp(hsl.y * (1.0 + uHsl[i].y * w), 0.0, 1.0);
        hsl.z = clamp(hsl.z + uHsl[i].z * 0.25 * w * hsl.y, 0.0, 1.0);
      }
    }
    col = hsl2rgb(hsl);
  }

  float lum = dot(col, LUM);
  float sat = max(max(col.r, col.g), col.b) - min(min(col.r, col.g), col.b);
  float vibAmt = uVibrance * (1.0 - sat);
  col = mix(vec3(lum), col, 1.0 + vibAmt + uSaturation);

  col = clamp(col, 0.0, 1.0);
  return col;
}

// Coverage of mask i at uv (0..1), in the displayed (post-crop) view space.
float maskWeight(int i, vec2 uv) {
  for (int k = 0; k < 8; k++) {
    if (k != i) continue;
    vec4 g = uMGeoA[k];
    if (uMKind[k] < 0.5) {
      // Radial ellipse: 1 inside, feathered to 0 at the rim.
      vec2 d = (uv - g.xy) / max(g.zw, vec2(1e-4));
      float r = length(d);
      float feather = max(uMGeoB[k].x, 0.001);
      float m = 1.0 - smoothstep(1.0 - feather, 1.0, r);
      return uMGeoB[k].y > 0.5 ? 1.0 - m : m;
    } else if (uMKind[k] < 1.5) {
      // Linear gradient: 0 at p1 ramping to 1 at p2.
      vec2 dir = g.zw - g.xy;
      float t = dot(uv - g.xy, dir) / max(dot(dir, dir), 1e-6);
      return clamp(t, 0.0, 1.0);
    } else {
      // Brush: coverage from the packed brush texture channel.
      return clamp(dot(texture2D(uBrushTex, uv), uMBrushSel[k]), 0.0, 1.0);
    }
  }
  return 0.0;
}

// Apply mask i's local adjustments to col, scaled by coverage w. hi = local
// contrast (for clarity), computed once in main.
vec3 applyLocalMask(int i, vec3 c, float hi, vec2 uv) {
  float w = maskWeight(i, uv);
  if (w <= 0.0) return c;
  vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0);
  for (int k = 0; k < 8; k++) {
    if (k == i) { a0 = uMAdj0[k]; a1 = uMAdj1[k]; a2 = uMAdj2[k]; }
  }
  vec3 o = c;
  // White balance
  o.r *= 1.0 + a1.z * 0.35 * w;
  o.b *= 1.0 - a1.z * 0.35 * w;
  o.g *= 1.0 - a1.w * 0.22 * w;
  o.r *= 1.0 + a1.w * 0.11 * w;
  o.b *= 1.0 + a1.w * 0.11 * w;
  // Exposure (a0.x pre-scaled to stops) + contrast
  o *= pow(2.0, a0.x * w);
  o = (o - 0.5) * (1.0 + a0.y * w) + 0.5;
  // Tonal regions
  float l = clamp(dot(o, LUM), 0.0, 1.0);
  o += a0.z * 0.5 * smoothstep(0.25, 0.9, l) * w;
  o += a0.w * 0.5 * (1.0 - smoothstep(0.1, 0.75, l)) * w;
  o += a1.x * 0.4 * smoothstep(0.55, 1.0, l) * w;
  o += a1.y * 0.4 * (1.0 - smoothstep(0.0, 0.45, l)) * w;
  o = clamp(o, 0.0, 1.0);
  // Saturation + clarity
  float lum = dot(o, LUM);
  o = mix(vec3(lum), o, 1.0 + a2.x * w);
  o += hi * a2.y * 0.8 * w;
  return clamp(o, 0.0, 1.0);
}

void main() {
  if (uCompare == 1) { gl_FragColor = vec4(clamp(sampleImg(vUv), 0.0, 1.0), 1.0); return; }
  if (uCompare == 2 && vUv.x < uSplit) {
    gl_FragColor = vec4(clamp(sampleImg(vUv), 0.0, 1.0), 1.0);
    return;
  }

  vec3 col = develop(vUv);

  // Local contrast (unsharp) — drives global clarity/sharpen AND per-mask clarity.
  float hi = 0.0;
  if (abs(uClarity) > 0.001 || uSharpen > 0.001 || uMaskCount > 0) {
    float c0 = dot(col, LUM);
    float rad = 3.0;
    float blur =
      dot(develop(vUv + vec2(uTexel.x * rad, 0.0)), LUM) +
      dot(develop(vUv - vec2(uTexel.x * rad, 0.0)), LUM) +
      dot(develop(vUv + vec2(0.0, uTexel.y * rad)), LUM) +
      dot(develop(vUv - vec2(0.0, uTexel.y * rad)), LUM);
    blur *= 0.25;
    hi = c0 - blur;
    col += hi * (uClarity * 0.8 + uSharpen * 1.2);
  }

  // Local-adjustment masks, composited over the globally-developed image.
  for (int i = 0; i < 8; i++) {
    if (i >= uMaskCount) break;
    col = applyLocalMask(i, col, hi, vUv);
  }

  // Coverage overlay: paint the selected mask's reach in red over a dimmed image
  // so it's obvious what a mask affects (Lightroom-style). Preview only.
  if (uMaskPreview >= 0) {
    float w = maskWeight(uMaskPreview, vUv);
    vec3 dim = mix(col, vec3(dot(col, LUM)), 0.35) * 0.7;
    vec3 red = vec3(1.0, 0.16, 0.42);
    gl_FragColor = vec4(clamp(mix(dim, red, w * 0.6), 0.0, 1.0), 1.0);
    return;
  }

  // Texture: fine, high-frequency local contrast (a tight-radius unsharp on the
  // source luma — cheaper than clarity's develop() taps, and higher frequency).
  if (abs(uTexture) > 0.001) {
    float r = 1.3;
    float c0 = dot(sampleSource(vUv), LUM);
    float b = 0.25 * (
      dot(sampleSource(vUv + vec2(uTexel.x * r, 0.0)), LUM) +
      dot(sampleSource(vUv - vec2(uTexel.x * r, 0.0)), LUM) +
      dot(sampleSource(vUv + vec2(0.0, uTexel.y * r)), LUM) +
      dot(sampleSource(vUv - vec2(0.0, uTexel.y * r)), LUM));
    col += (c0 - b) * uTexture * 1.6;
  }

  if (abs(uVignette) > 0.001) {
    float d = distance(vUv, vec2(0.5));
    col *= 1.0 + uVignette * smoothstep(0.25, 0.75, d);
  }

  // Film grain: static per-pixel monochrome noise, luminance-weighted so it reads
  // in the mids and fades in highlights (like real film).
  if (uGrain > 0.001) {
    float n = fract(sin(dot(vUv * uTexel.yx * 4096.0, vec2(12.9898, 78.233))) * 43758.5453);
    float lg = dot(col, LUM);
    col += (n - 0.5) * uGrain * 0.14 * (1.0 - lg * 0.6);
  }

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`

export const EDIT_UNIFORMS = [
  'uTex', 'uLut', 'uTexel', 'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uWhites', 'uBlacks', 'uTemp', 'uTint', 'uSaturation', 'uVibrance', 'uClarity',
  'uSharpen', 'uVignette', 'uDehaze', 'uTexture', 'uGrain', 'uUseLut', 'uHsl', 'uBandHue', 'uCompare', 'uSplit',
  'uCrop', 'uFlip', 'uRotate', 'uAspect',
  'uMaskCount', 'uMKind', 'uMGeoA', 'uMGeoB', 'uMAdj0', 'uMAdj1', 'uMAdj2',
  'uBrushTex', 'uMBrushSel', 'uMaskPreview',
  'uDenoiseTex', 'uDenoiseAmt', 'uHasDenoise'
] as const

export type EditUniforms = Record<string, WebGLUniformLocation | null>

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)!
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[editShader] compile:', gl.getShaderInfoLog(s))
    return null
  }
  return s
}

// Build the program + fullscreen triangle + resolve uniforms. Returns null on
// failure (caller falls back). Leaves the program bound and attrib enabled.
export function buildEditProgram(
  gl: WebGLRenderingContext
): { prog: WebGLProgram; U: EditUniforms } | null {
  const vs = compile(gl, gl.VERTEX_SHADER, EDIT_VERT)
  const fs = compile(gl, gl.FRAGMENT_SHADER, EDIT_FRAG)
  if (!vs || !fs) return null
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error('[editShader] link:', gl.getProgramInfoLog(prog))
    return null
  }
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const aPos = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(aPos)
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)
  const U: EditUniforms = {}
  for (const n of EDIT_UNIFORMS) U[n] = gl.getUniformLocation(prog, n)
  return { prog, U }
}

// Upload the tone-curve LUT into `tex` (texture unit 1). Returns whether the LUT
// is active (non-identity) so the caller can set uUseLut.
export function uploadCurveLut(
  gl: WebGLRenderingContext,
  tex: WebGLTexture,
  e: EditState
): boolean {
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildCurveLut(e.curves))
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return !curvesAreIdentity(e.curves)
}

// Rasterize brush strokes into an RGBA coverage texture on unit 2 — each enabled
// brush mask packed into one channel. Baked in the displayed (post-crop) space so
// uv sampling lines up; the canvas is sized to displayAspect so brushes are round
// on screen. Returns a hash so the caller can skip re-baking unchanged strokes.
export function brushStrokeHash(e: EditState): string {
  const parts: string[] = []
  for (const m of e.masks ?? []) {
    if (m.kind !== 'brush' || !m.brush) continue
    let pc = 0
    for (const s of m.brush.strokes) pc += s.points.length
    parts.push(`${m.id}:${m.enabled ? 1 : 0}:${m.brush.strokes.length}:${pc}`)
  }
  return parts.join('|')
}

export function bakeBrushTexture(
  gl: WebGLRenderingContext,
  tex: WebGLTexture,
  e: EditState,
  displayAspect: number
): void {
  gl.activeTexture(gl.TEXTURE2)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)

  const brushes = assignBrushChannels(e)
  if (!brushes.length) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    return
  }
  const W = 768
  const H = Math.max(1, Math.round(W / Math.max(displayAspect, 1e-3)))
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const combined = new Uint8Array(W * H * 4)
  for (const { mask, channel } of brushes) {
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = '#fff'
    ctx.strokeStyle = '#fff'
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const s of mask.brush!.strokes) {
      const rad = Math.max(0.5, s.radius * W)
      ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
      ctx.lineWidth = rad * 2
      const pts = s.points
      if (pts.length === 1) {
        ctx.beginPath()
        ctx.arc(pts[0].x * W, pts[0].y * H, rad, 0, Math.PI * 2)
        ctx.fill()
      } else if (pts.length > 1) {
        ctx.beginPath()
        ctx.moveTo(pts[0].x * W, pts[0].y * H)
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x * W, pts[i].y * H)
        ctx.stroke()
      }
    }
    const data = ctx.getImageData(0, 0, W, H).data
    for (let p = 0; p < W * H; p++) combined[p * 4 + channel] = data[p * 4 + 3] // alpha = coverage
  }
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, combined)
}

interface RenderOpts {
  compare?: 0 | 1 | 2
  split?: number
  imgW: number
  imgH: number
  maskPreview?: number // slot to show as a red coverage overlay, or -1/undefined
  hasDenoise?: boolean // a denoised source texture is bound on unit 3
}

// Set all edit uniforms for one draw. Assumes uTex on unit 0, uLut on unit 1.
export function setEditUniforms(
  gl: WebGLRenderingContext,
  U: EditUniforms,
  e: EditState,
  useLut: boolean,
  opts: RenderOpts
): void {
  gl.uniform1i(U.uTex, 0)
  gl.uniform1i(U.uLut, 1)
  gl.uniform1f(U.uUseLut, useLut ? 1 : 0)
  gl.uniform2f(U.uTexel, 1 / opts.imgW, 1 / opts.imgH)
  gl.uniform1f(U.uAspect, opts.imgW / opts.imgH)
  gl.uniform1i(U.uCompare, opts.compare ?? 0)
  gl.uniform1f(U.uSplit, opts.split ?? 0.5)
  gl.uniform1i(U.uMaskPreview, opts.maskPreview ?? -1)
  gl.uniform1i(U.uDenoiseTex, 3)
  gl.uniform1f(U.uDenoiseAmt, e.denoise / 100)
  gl.uniform1f(U.uHasDenoise, opts.hasDenoise ? 1 : 0)

  gl.uniform1f(U.uExposure, (e.exposure / 100) * 2.0)
  gl.uniform1f(U.uContrast, e.contrast / 100)
  gl.uniform1f(U.uHighlights, e.highlights / 100)
  gl.uniform1f(U.uShadows, e.shadows / 100)
  gl.uniform1f(U.uWhites, e.whites / 100)
  gl.uniform1f(U.uBlacks, e.blacks / 100)
  gl.uniform1f(U.uTemp, e.temperature / 100)
  gl.uniform1f(U.uTint, e.tint / 100)
  gl.uniform1f(U.uSaturation, e.saturation / 100)
  gl.uniform1f(U.uVibrance, e.vibrance / 100)
  gl.uniform1f(U.uClarity, e.clarity / 100)
  gl.uniform1f(U.uSharpen, e.sharpening / 100)
  gl.uniform1f(U.uVignette, e.vignette / 100)
  gl.uniform1f(U.uDehaze, e.dehaze / 100)
  gl.uniform1f(U.uTexture, e.texture / 100)
  gl.uniform1f(U.uGrain, e.grain / 100)

  const hsl = new Float32Array(24)
  const bandHue = new Float32Array(8)
  HSL_BANDS.forEach((b, i) => {
    hsl[i * 3] = e.hsl[b].hue / 100
    hsl[i * 3 + 1] = e.hsl[b].sat / 100
    hsl[i * 3 + 2] = e.hsl[b].lum / 100
    bandHue[i] = HSL_BAND_HUE[b]
  })
  gl.uniform3fv(U.uHsl, hsl)
  gl.uniform1fv(U.uBandHue, bandHue)

  const crop = e.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  gl.uniform4f(U.uCrop, crop.x, crop.y, crop.w, crop.h)
  gl.uniform2f(U.uFlip, e.flipH ? -1 : 1, e.flipV ? -1 : 1)
  gl.uniform1f(U.uRotate, (e.rotate * Math.PI) / 180)

  uploadMaskUniforms(gl, U, e)
}

const MAX_MASKS = 8
export const MAX_BRUSH_MASKS = 4 // one per RGBA channel of the packed brush texture

// The shader slot of a mask by id (its index among enabled, valid masks in the
// same order uploadMaskUniforms packs them), or -1 if it isn't uploaded. Used to
// drive the coverage overlay for the selected mask.
export function maskSlotIndex(e: EditState, id: string | null): number {
  if (!id) return -1
  const brushIds = new Set(assignBrushChannels(e).map((b) => b.mask.id))
  let n = 0
  for (const m of e.masks ?? []) {
    if (n >= MAX_MASKS) break
    if (!m.enabled) continue
    const valid =
      (m.kind === 'radial' && m.radial) ||
      (m.kind === 'linear' && m.linear) ||
      (m.kind === 'brush' && m.brush && brushIds.has(m.id))
    if (!valid) continue
    if (m.id === id) return n
    n++
  }
  return -1
}

// Assign each enabled brush mask a coverage-texture channel (0..3), in order.
// Shared by the uniform upload and the texture baker so channels line up.
export function assignBrushChannels(e: EditState): { mask: Mask; channel: number }[] {
  const out: { mask: Mask; channel: number }[] = []
  for (const m of e.masks ?? []) {
    if (m.kind === 'brush' && m.enabled && m.brush) {
      if (out.length >= MAX_BRUSH_MASKS) break
      out.push({ mask: m, channel: out.length })
    }
  }
  return out
}

// Pack enabled masks into the shader's uniform arrays. Radial/linear are fully
// parametric; brush masks reference a channel of the packed coverage texture.
function uploadMaskUniforms(gl: WebGLRenderingContext, U: EditUniforms, e: EditState): void {
  const kind = new Float32Array(MAX_MASKS)
  const geoA = new Float32Array(MAX_MASKS * 4)
  const geoB = new Float32Array(MAX_MASKS * 4)
  const adj0 = new Float32Array(MAX_MASKS * 4)
  const adj1 = new Float32Array(MAX_MASKS * 4)
  const adj2 = new Float32Array(MAX_MASKS * 4)
  const brushSel = new Float32Array(MAX_MASKS * 4)
  const brushChannel = new Map<string, number>()
  for (const { mask, channel } of assignBrushChannels(e)) brushChannel.set(mask.id, channel)

  let n = 0
  for (const m of e.masks ?? []) {
    if (n >= MAX_MASKS) break
    if (!m.enabled) continue
    if (m.kind === 'radial' && m.radial) {
      kind[n] = 0
      geoA[n * 4] = m.radial.cx
      geoA[n * 4 + 1] = m.radial.cy
      geoA[n * 4 + 2] = m.radial.rx
      geoA[n * 4 + 3] = m.radial.ry
      geoB[n * 4] = m.radial.feather
      geoB[n * 4 + 1] = m.radial.invert ? 1 : 0
    } else if (m.kind === 'linear' && m.linear) {
      kind[n] = 1
      geoA[n * 4] = m.linear.x1
      geoA[n * 4 + 1] = m.linear.y1
      geoA[n * 4 + 2] = m.linear.x2
      geoA[n * 4 + 3] = m.linear.y2
    } else if (m.kind === 'brush' && m.brush && brushChannel.has(m.id)) {
      kind[n] = 2
      brushSel[n * 4 + (brushChannel.get(m.id) as number)] = 1
    } else {
      continue // malformed / over the brush cap — skip
    }
    const a = m.adjust
    adj0[n * 4] = (a.exposure / 100) * 1.5
    adj0[n * 4 + 1] = a.contrast / 100
    adj0[n * 4 + 2] = a.highlights / 100
    adj0[n * 4 + 3] = a.shadows / 100
    adj1[n * 4] = a.whites / 100
    adj1[n * 4 + 1] = a.blacks / 100
    adj1[n * 4 + 2] = a.temperature / 100
    adj1[n * 4 + 3] = a.tint / 100
    adj2[n * 4] = a.saturation / 100
    adj2[n * 4 + 1] = a.clarity / 100
    n++
  }
  gl.uniform1i(U.uMaskCount, n)
  gl.uniform1fv(U.uMKind, kind)
  gl.uniform4fv(U.uMGeoA, geoA)
  gl.uniform4fv(U.uMGeoB, geoB)
  gl.uniform4fv(U.uMAdj0, adj0)
  gl.uniform4fv(U.uMAdj1, adj1)
  gl.uniform4fv(U.uMAdj2, adj2)
  gl.uniform4fv(U.uMBrushSel, brushSel)
  gl.uniform1i(U.uBrushTex, 2) // texture unit 2
}
