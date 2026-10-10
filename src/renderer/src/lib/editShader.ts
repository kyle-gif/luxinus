import type { ColorGradeRegion, EditState, Mask } from '../../../shared/edits'
import { COLOR_GRADE_REGIONS, HSL_BAND_HUE, HSL_BANDS } from '../../../shared/edits'
import { buildCurveLut, curvesAreIdentity } from './curve'
import { srgbToOklab } from './color'
import { MAX_RENDERED_MASKS, semanticAtlasLayout } from './semanticAtlas'

// HSL→RGB (h,s,l in 0..1) — mirror of the shader's, for CPU-side precompute.
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s < 1e-5) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)]
}

// A color-grade region → vec4(zero-mean chroma tint · sat, lum). The tint is the
// region's hue as a fully-saturated color with its own luminance removed, so it
// nudges chroma without lifting brightness; scaled by the region's saturation.
function gradeVec(r: ColorGradeRegion): [number, number, number, number] {
  const [cr, cg, cb] = hslToRgb((r.hue % 360) / 360, 1, 0.5)
  const lu = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb
  const s = r.sat / 100
  return [(cr - lu) * s, (cg - lu) * s, (cb - lu) * s, r.lum / 100]
}

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

// Color grading — per region: rgb = zero-mean chroma tint (pre-scaled by sat),
// a = luminance shift (-1..1). uCgParams = (blending 0..1, balance -1..1).
uniform vec4 uCgSh, uCgMid, uCgHi, uCgGlobal;
uniform vec2 uCgParams;
uniform float uCgActive;

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
uniform float uMKind[16];   // 0 radial, 1 linear, 2 brush, 3 lum, 4 color, 5 semantic
uniform vec4 uMGeoA[16];    // radial geometry / semantic atlas rect
uniform vec4 uMGeoB[16];    // radial feather+invert / semantic inverse dimensions; z density
uniform vec4 uMAdj0[16];    // exposure, contrast, highlights, shadows
uniform vec4 uMAdj1[16];    // whites, blacks, temperature, tint
uniform vec4 uMAdj2[16];    // saturation, clarity, -, -
// Brush coverage: up to 4 brush masks packed one-per-channel into uBrushTex;
// uMBrushSel selects a mask's channel (e.g. (1,0,0,0)) so dot() reads it.
uniform sampler2D uBrushTex;
uniform vec4 uMBrushSel[16];
uniform sampler2D uSemanticTex;
// Refinements: a shared pool of source-evaluated components (lum/color range)
// combined onto a mask's primary shape. Per mask, uMRefine = (poolStart, count).
// uRMeta = (kind 3|4, mode 0 add/1 subtract/2 intersect, invert, -).
uniform vec4 uRMeta[8];
uniform vec4 uRGeoA[8];
uniform vec4 uRGeoB[8];
uniform vec2 uMRefine[16];
uniform int uMaskPreview; // slot to show as a coverage overlay, or -1
uniform int uOverlayMode; // 0 red · 1 white-on-black · 2 black-on-white
uniform int uShowClip;    // 1 = zebra-stripe clipped pixels (red blown · blue crushed)
// 1 when the unsharp (local-contrast) term is actually consumed — by global
// clarity/sharpening, or by a mask's clarity/sharpness. Computing it costs FOUR
// extra develop() evaluations per pixel, so it stays off unless something reads it.
uniform float uNeedHi;

// AI denoise: a restored copy of the source, blended in by uDenoiseAmt (0..1).
uniform sampler2D uDenoiseTex;
uniform float uDenoiseAmt;
uniform float uHasDenoise;

const vec3 LUM = vec3(0.2126, 0.7152, 0.0722);

// ── Shared adjustment primitives ────────────────────────────────────────────
// Used by BOTH the global develop() pass and per-mask local adjustments so the
// math never forks. For local use, pass strength pre-scaled by mask coverage.
vec3 adjWhiteBalance(vec3 c, float temp, float tint) {
  // +temp = warmer (more red, less blue). +tint = magenta, like Lightroom.
  c.r *= 1.0 + temp * 0.35;
  c.b *= 1.0 - temp * 0.35;
  c.g *= 1.0 - tint * 0.22;
  c.r *= 1.0 + tint * 0.11;
  c.b *= 1.0 + tint * 0.11;
  return c;
}
// Photographic exposure: LINEAR-light multiply with a monotonic soft clip at
// the top (knee 0.9) so overexposure rolls off instead of clipping hard.
vec3 adjExposure(vec3 c, float ev) {
  if (abs(ev) < 0.0001) return c;
  vec3 lin = pow(max(c, 0.0), vec3(2.2)) * pow(2.0, ev);
  vec3 e = max(lin - 0.9, 0.0);
  lin = min(lin, vec3(0.9)) + 0.1 * (e / (e + 0.1));
  return pow(lin, vec3(1.0 / 2.2));
}
// S-curve pivoting on mid-grey, Lightroom-like.
vec3 adjContrast(vec3 c, float amt) {
  return (c - 0.5) * (1.0 + amt) + 0.5;
}
// Tonal regions — broad, overlapping masks so Highlights/Shadows act through
// the whole upper/lower range; every slider brightens its region when positive.
vec3 adjTonal(vec3 c, float hi, float sh, float wh, float bl) {
  float l = clamp(dot(c, LUM), 0.0, 1.0);
  c += hi * 0.5 * smoothstep(0.25, 0.9, l);
  c += sh * 0.5 * (1.0 - smoothstep(0.1, 0.75, l));
  c += wh * 0.4 * smoothstep(0.55, 1.0, l);
  c += bl * 0.4 * (1.0 - smoothstep(0.0, 0.45, l));
  return c;
}
// Dehaze: + removes atmospheric veiling (pull the airlight, add contrast +
// saturation); − adds haze. A perceptual approximation, not physical.
vec3 adjDehaze(vec3 c, float amt) {
  if (abs(amt) < 0.001) return c;
  float airlight = min(min(c.r, c.g), c.b);
  c -= amt * 0.35 * airlight;
  c = (c - 0.5) * (1.0 + amt * 0.45) + 0.5;
  float dl = dot(c, LUM);
  return mix(vec3(dl), c, 1.0 + amt * 0.4);
}

// sRGB → Oklab, for perceptual color-distance masks. Mirror of lib/color.ts —
// keep the two in sync.
vec3 srgb2oklab(vec3 c) {
  c = pow(max(c, 0.0), vec3(2.2));
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(l, 1.0 / 3.0);
  m = pow(m, 1.0 / 3.0);
  s = pow(s, 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
  );
}

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
vec2 mapUnclampedCoord(vec2 uv) {
  vec2 c = uCrop.xy + uv * uCrop.zw;
  if (abs(uRotate) > 0.0001) {
    vec2 p = (c - 0.5) * vec2(uAspect, 1.0);
    float s = sin(uRotate), co = cos(uRotate);
    p = mat2(co, -s, s, co) * p;
    float cover = abs(sin(uRotate)) * (uAspect > 1.0 ? 1.0 / uAspect : uAspect) + abs(cos(uRotate));
    p /= cover;
    c = p / vec2(uAspect, 1.0) + 0.5;
  }
  return vec2(uFlip.x < 0.0 ? 1.0 - c.x : c.x, uFlip.y < 0.0 ? 1.0 - c.y : c.y);
}
vec2 mapCoord(vec2 uv) { return clamp(mapUnclampedCoord(uv), 0.0, 1.0); }

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

  // The shared adjustment primitives (see top of shader) — the same functions
  // run per-mask, so global and local adjustments can never drift apart.
  col = adjWhiteBalance(col, uTemp, uTint);
  col = adjExposure(col, uExposure);
  col = adjContrast(col, uContrast);
  col = adjTonal(col, uHighlights, uShadows, uWhites, uBlacks);
  col = adjDehaze(col, uDehaze);

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

  // Color grading — tint shadows / midtones / highlights (+ a global cast) by
  // luminance region. Balance biases the shadow↔highlight split; Blending widens
  // the overlap so the regions cross-fade rather than band.
  if (uCgActive > 0.5) {
    float Lg = clamp(dot(col, LUM), 0.0, 1.0);
    float bal = uCgParams.y * 0.28;      // shift the split point
    float blend = mix(0.16, 0.42, uCgParams.x); // transition half-width
    float wSh = 1.0 - smoothstep(0.0, 0.5 + bal + blend, Lg);
    float wHi = smoothstep(0.5 + bal - blend, 1.0, Lg);
    float wMid = clamp(1.0 - wSh - wHi, 0.0, 1.0);
    vec3 tint = uCgSh.rgb * wSh + uCgMid.rgb * wMid + uCgHi.rgb * wHi + uCgGlobal.rgb;
    col += tint * 0.55;
    float dl = uCgSh.a * wSh + uCgMid.a * wMid + uCgHi.a * wHi + uCgGlobal.a;
    col += dl * 0.18;
    col = clamp(col, 0.0, 1.0);
  }

  float lum = dot(col, LUM);
  float sat = max(max(col.r, col.g), col.b) - min(min(col.r, col.g), col.b);
  float vibAmt = uVibrance * (1.0 - sat);
  col = mix(vec3(lum), col, 1.0 + vibAmt + uSaturation);

  col = clamp(col, 0.0, 1.0);
  return col;
}

// Selection of a source-evaluated range: luminance (geoA = lo,hi,fLo,fHi) when
// kind < 3.5, else color (geoA = okLab,tolerance · geoB.x = feather). Shared by
// the primary lum/color branches and the refinement fold.
float rangeShape(float kindV, vec4 ga, vec4 gb, vec2 uv) {
  if (kindV < 3.5) {
    float l = dot(sampleSource(uv), LUM);
    float rise = smoothstep(ga.x - max(ga.z, 1e-4), ga.x, l);
    float fall = 1.0 - smoothstep(ga.y, ga.y + max(ga.w, 1e-4), l);
    return rise * fall;
  }
  float d = distance(srgb2oklab(sampleSource(uv)), ga.xyz);
  return 1.0 - smoothstep(ga.w, ga.w + max(gb.x, 1e-3), d);
}

// Coverage of mask i at uv (0..1), in the displayed (post-crop) view space:
// primary shape → refinements (add = union, subtract, intersect) → density.
float maskWeight(int i, vec2 uv) {
  for (int k = 0; k < 16; k++) {
    if (k != i) continue;
    vec4 g = uMGeoA[k];
    float w = 0.0;
    if (uMKind[k] < 0.5) {
      // Radial ellipse: 1 inside, feathered to 0 at the rim.
      vec2 d = (uv - g.xy) / max(g.zw, vec2(1e-4));
      float r = length(d);
      float feather = max(uMGeoB[k].x, 0.001);
      float m = 1.0 - smoothstep(1.0 - feather, 1.0, r);
      w = uMGeoB[k].y > 0.5 ? 1.0 - m : m;
    } else if (uMKind[k] < 1.5) {
      // Linear gradient: 0 at p1 ramping to 1 at p2 (the span IS the falloff).
      vec2 dir = g.zw - g.xy;
      float t = dot(uv - g.xy, dir) / max(dot(dir, dir), 1e-6);
      w = clamp(t, 0.0, 1.0);
    } else if (uMKind[k] < 2.5) {
      // Brush: coverage from the packed brush texture channel.
      w = clamp(dot(texture2D(uBrushTex, uv), uMBrushSel[k]), 0.0, 1.0);
    } else if (uMKind[k] < 4.5) {
      // Luminance / color range, evaluated on the pre-develop source so
      // coverage doesn't shift while the mask's own adjustments are dragged.
      w = rangeShape(uMKind[k], g, uMGeoB[k], uv);
    } else {
      vec2 sourceUV = mapUnclampedCoord(uv);
      if (sourceUV.x >= 0.0 && sourceUV.x <= 1.0 && sourceUV.y >= 0.0 && sourceUV.y <= 1.0) {
        vec2 halfTexel = 0.5 * uMGeoB[k].xy;
        vec2 sampleUV = clamp(sourceUV, halfTexel, vec2(1.0) - halfTexel);
        w = texture2D(uSemanticTex, g.xy + sampleUV * g.zw).r;
      }
    }

    // Fold in this mask's refinement components from the shared pool.
    vec2 rr = uMRefine[k];
    for (int c = 0; c < 8; c++) {
      float fc = float(c);
      if (fc < rr.x || fc >= rr.x + rr.y) continue;
      float s = rangeShape(uRMeta[c].x, uRGeoA[c], uRGeoB[c], uv);
      if (uRMeta[c].z > 0.5) s = 1.0 - s;
      if (uRMeta[c].y < 0.5) w = w + s - w * s;     // add (union)
      else if (uRMeta[c].y < 1.5) w = w * (1.0 - s); // subtract
      else w = w * s;                                // intersect
    }
    return w * uMGeoB[k].z; // density
  }
  return 0.0;
}

// Apply mask i's local adjustments to col, scaled by coverage w. hi = local
// contrast (for clarity), computed once in main.
vec3 applyLocalMask(int i, vec3 c, float hi, vec2 uv) {
  float w = maskWeight(i, uv);
  if (w <= 0.0) return c;
  vec4 a0 = vec4(0.0), a1 = vec4(0.0), a2 = vec4(0.0);
  for (int k = 0; k < 16; k++) {
    if (k == i) { a0 = uMAdj0[k]; a1 = uMAdj1[k]; a2 = uMAdj2[k]; }
  }
  // The SAME primitives as the global pass, with strengths scaled by coverage.
  vec3 o = adjWhiteBalance(c, a1.z * w, a1.w * w);
  o = adjExposure(o, a0.x * w);
  o = adjContrast(o, a0.y * w);
  o = adjTonal(o, a0.z * w, a0.w * w, a1.x * w, a1.y * w);
  o = adjDehaze(o, a2.z * w);
  o = clamp(o, 0.0, 1.0);
  // Saturation + local contrast (clarity broad, sharpness fine — both reuse
  // the unsharp term computed once in main).
  float lum = dot(o, LUM);
  o = mix(vec3(lum), o, 1.0 + a2.x * w);
  o += hi * (a2.y * 0.8 + a2.w * 1.2) * w;
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
  if (uNeedHi > 0.5) {
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
  for (int i = 0; i < 16; i++) {
    if (i >= uMaskCount) break;
    col = applyLocalMask(i, col, hi, vUv);
  }

  // Coverage overlay for the selected mask (Lightroom-style). Preview only.
  // uOverlayMode: 0 = red over the dimmed image · 1 = white-on-black matte ·
  // 2 = black-on-white matte (cycled with Shift+O).
  if (uMaskPreview >= 0) {
    float w = maskWeight(uMaskPreview, vUv);
    if (uOverlayMode == 1) {
      gl_FragColor = vec4(vec3(w), 1.0);
      return;
    }
    if (uOverlayMode == 2) {
      gl_FragColor = vec4(vec3(1.0 - w), 1.0);
      return;
    }
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

  col = clamp(col, 0.0, 1.0);

  // Clipping zebras (J): diagonal stripes over blown (red) / crushed (blue)
  // pixels of the DEVELOPED image — a shader pass, zero CPU compositing.
  if (uShowClip == 1) {
    float stripe = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
    float mx = max(max(col.r, col.g), col.b);
    if (mx > 0.996) col = mix(col, vec3(1.0, 0.16, 0.3), stripe * 0.85);
    else if (mx < 0.008) col = mix(col, vec3(0.25, 0.5, 1.0), stripe * 0.85);
  }

  gl_FragColor = vec4(col, 1.0);
}
`

export const EDIT_UNIFORMS = [
  'uTex', 'uLut', 'uTexel', 'uExposure', 'uContrast', 'uHighlights', 'uShadows',
  'uWhites', 'uBlacks', 'uTemp', 'uTint', 'uSaturation', 'uVibrance', 'uClarity',
  'uSharpen', 'uVignette', 'uDehaze', 'uTexture', 'uGrain', 'uUseLut', 'uHsl', 'uBandHue',
  'uCgSh', 'uCgMid', 'uCgHi', 'uCgGlobal', 'uCgParams', 'uCgActive', 'uCompare', 'uSplit',
  'uCrop', 'uFlip', 'uRotate', 'uAspect',
  'uMaskCount', 'uMKind', 'uMGeoA', 'uMGeoB', 'uMAdj0', 'uMAdj1', 'uMAdj2',
  'uBrushTex', 'uSemanticTex', 'uMBrushSel', 'uRMeta', 'uRGeoA', 'uRGeoB', 'uMRefine', 'uMaskPreview', 'uOverlayMode', 'uShowClip', 'uNeedHi',
  'uDenoiseTex', 'uDenoiseAmt', 'uHasDenoise'
] as const

export type EditUniforms = Record<string, WebGLUniformLocation | null>

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  // Returns null on a lost/exhausted context — bubble that up as a build failure
  // so the caller degrades, rather than throwing out of a render effect.
  const s = gl.createShader(type)
  if (!s) return null
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
  const prog = gl.createProgram()
  if (!prog) return null
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

// Reused bake scratch (see bakeBrushTexture).
let bakeCanvas: HTMLCanvasElement | null = null
let bakeCtx: CanvasRenderingContext2D | null = null
let combinedBuf: Uint8Array | null = null

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
  // A bake happens on every pointer move while painting. Allocating a 768×H
  // canvas and coverage buffer each time made the brush lag behind the cursor,
  // so both are reused and only re-sized when the aspect actually changes.
  const canvas = bakeCanvas ?? (bakeCanvas = document.createElement('canvas'))
  if (canvas.width !== W || canvas.height !== H) {
    canvas.width = W
    canvas.height = H
    bakeCtx = null
  }
  const ctx = bakeCtx ?? (bakeCtx = canvas.getContext('2d', { willReadFrequently: true })!)
  if (!combinedBuf || combinedBuf.length !== W * H * 4) combinedBuf = new Uint8Array(W * H * 4)
  const combined = combinedBuf
  combined.fill(0)
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
  maskPreview?: number // slot to show as a coverage overlay, or -1/undefined
  overlayMode?: number // 0 red · 1 white-on-black · 2 black-on-white
  showClip?: boolean // zebra-stripe clipped pixels
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
  gl.uniform1i(U.uOverlayMode, opts.overlayMode ?? 0)
  gl.uniform1i(U.uShowClip, opts.showClip ? 1 : 0)
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

  const hsl = SCRATCH.hsl
  const bandHue = SCRATCH.bandHue
  HSL_BANDS.forEach((b, i) => {
    hsl[i * 3] = e.hsl[b].hue / 100
    hsl[i * 3 + 1] = e.hsl[b].sat / 100
    hsl[i * 3 + 2] = e.hsl[b].lum / 100
    bandHue[i] = HSL_BAND_HUE[b]
  })
  gl.uniform3fv(U.uHsl, hsl)
  gl.uniform1fv(U.uBandHue, bandHue)

  // Color grading
  const cg = e.colorGrade
  const sh = gradeVec(cg.shadows)
  const mid = gradeVec(cg.midtones)
  const hi = gradeVec(cg.highlights)
  const glob = gradeVec(cg.global)
  gl.uniform4f(U.uCgSh, sh[0], sh[1], sh[2], sh[3])
  gl.uniform4f(U.uCgMid, mid[0], mid[1], mid[2], mid[3])
  gl.uniform4f(U.uCgHi, hi[0], hi[1], hi[2], hi[3])
  gl.uniform4f(U.uCgGlobal, glob[0], glob[1], glob[2], glob[3])
  gl.uniform2f(U.uCgParams, cg.blending / 100, cg.balance / 100)
  const cgActive = COLOR_GRADE_REGIONS.some((r) => cg[r].sat !== 0 || cg[r].lum !== 0)
  gl.uniform1f(U.uCgActive, cgActive ? 1 : 0)

  const crop = e.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  gl.uniform4f(U.uCrop, crop.x, crop.y, crop.w, crop.h)
  gl.uniform2f(U.uFlip, e.flipH ? -1 : 1, e.flipV ? -1 : 1)
  gl.uniform1f(U.uRotate, (e.rotate * Math.PI) / 180)

  const masksNeedHi = uploadMaskUniforms(gl, U, e)
  // Gate the unsharp taps (4 extra develop() calls per pixel) on real demand.
  const needHi = masksNeedHi || Math.abs(e.clarity) > 0.1 || e.sharpening > 0.1
  gl.uniform1f(U.uNeedHi, needHi ? 1 : 0)
}

const MAX_MASKS = MAX_RENDERED_MASKS
const MAX_REFINE = 8 // shared refinement pool across all masks
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
      (m.kind === 'brush' && m.brush && brushIds.has(m.id)) ||
      (m.kind === 'lumRange' && m.lum) ||
      (m.kind === 'colorRange' && m.color) ||
      (m.kind === 'semantic' && m.semantic)
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
// Returns whether any mask consumes the unsharp term (clarity / sharpness).
function uploadMaskUniforms(gl: WebGLRenderingContext, U: EditUniforms, e: EditState): boolean {
  const { kind, geoA, geoB, adj0, adj1, adj2, brushSel, rMeta, rGeoA, rGeoB, mRefine } = SCRATCH
  // Reused across draws, so clear the slots this pass may not write.
  kind.fill(0)
  geoA.fill(0)
  geoB.fill(0)
  adj0.fill(0)
  adj1.fill(0)
  adj2.fill(0)
  brushSel.fill(0)
  rMeta.fill(0)
  rGeoA.fill(0)
  rGeoB.fill(0)
  mRefine.fill(0)
  let needHi = false
  let pool = 0
  const brushChannel = new Map<string, number>()
  for (const { mask, channel } of assignBrushChannels(e)) brushChannel.set(mask.id, channel)
  const semanticRects = new Map(semanticAtlasLayout(e).tiles.map(tile => [tile.mask.id, tile.rect]))

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
    } else if (m.kind === 'lumRange' && m.lum) {
      kind[n] = 3
      geoA[n * 4] = m.lum.lo
      geoA[n * 4 + 1] = m.lum.hi
      geoA[n * 4 + 2] = m.lum.featherLo
      geoA[n * 4 + 3] = m.lum.featherHi
    } else if (m.kind === 'colorRange' && m.color) {
      kind[n] = 4
      const ok = srgbToOklab(m.color.rgb[0], m.color.rgb[1], m.color.rgb[2])
      geoA[n * 4] = ok[0]
      geoA[n * 4 + 1] = ok[1]
      geoA[n * 4 + 2] = ok[2]
      // Map UI-normalized 0..1 onto perceptual Oklab distances: tolerance up to
      // ~0.35 (distinct hues sit ~0.1–0.3 apart), feather up to ~0.25.
      geoA[n * 4 + 3] = m.color.tolerance * 0.35
      geoB[n * 4] = Math.max(m.color.feather * 0.25, 0.004)
    } else if (m.kind === 'semantic' && m.semantic && semanticRects.has(m.id)) {
      kind[n] = 5
      geoA.set(semanticRects.get(m.id)!, n * 4)
      geoB[n * 4] = 1 / m.semantic.width
      geoB[n * 4 + 1] = 1 / m.semantic.height
    } else {
      continue // malformed / over the brush cap — skip
    }
    geoB[n * 4 + 2] = m.density ?? 1 // density rides the free geoB.z slot

    // Pack this mask's refinements into the shared pool (silently drops past
    // the pool cap — MAX_REFINE total across all masks).
    const start = pool
    for (const r of m.refine ?? []) {
      if (pool >= MAX_REFINE) break
      if (r.kind === 'lumRange' && r.lum) {
        rMeta[pool * 4] = 3
        rGeoA[pool * 4] = r.lum.lo
        rGeoA[pool * 4 + 1] = r.lum.hi
        rGeoA[pool * 4 + 2] = r.lum.featherLo
        rGeoA[pool * 4 + 3] = r.lum.featherHi
      } else if (r.kind === 'colorRange' && r.color) {
        rMeta[pool * 4] = 4
        const ok = srgbToOklab(r.color.rgb[0], r.color.rgb[1], r.color.rgb[2])
        rGeoA[pool * 4] = ok[0]
        rGeoA[pool * 4 + 1] = ok[1]
        rGeoA[pool * 4 + 2] = ok[2]
        rGeoA[pool * 4 + 3] = r.color.tolerance * 0.35
        rGeoB[pool * 4] = Math.max(r.color.feather * 0.25, 0.004)
      } else {
        continue
      }
      rMeta[pool * 4 + 1] = r.mode === 'add' ? 0 : r.mode === 'subtract' ? 1 : 2
      rMeta[pool * 4 + 2] = r.invert ? 1 : 0
      pool++
    }
    mRefine[n * 2] = start
    mRefine[n * 2 + 1] = pool - start

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
    adj2[n * 4 + 2] = (a.dehaze ?? 0) / 100
    adj2[n * 4 + 3] = (a.sharpness ?? 0) / 100
    if (a.clarity !== 0 || (a.sharpness ?? 0) !== 0) needHi = true
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
  gl.uniform4fv(U.uRMeta, rMeta)
  gl.uniform4fv(U.uRGeoA, rGeoA)
  gl.uniform4fv(U.uRGeoB, rGeoB)
  gl.uniform2fv(U.uMRefine, mRefine)
  gl.uniform1i(U.uBrushTex, 2) // texture unit 2
  gl.uniform1i(U.uSemanticTex, 4)
  return needHi
}

// Uniform staging buffers. These are rewritten on every draw (twice a frame,
// counting the histogram pass) — allocating them per call churned ~11 typed
// arrays a frame for the GC to sweep.
const SCRATCH = {
  hsl: new Float32Array(24),
  bandHue: new Float32Array(8),
  kind: new Float32Array(MAX_MASKS),
  geoA: new Float32Array(MAX_MASKS * 4),
  geoB: new Float32Array(MAX_MASKS * 4),
  adj0: new Float32Array(MAX_MASKS * 4),
  adj1: new Float32Array(MAX_MASKS * 4),
  adj2: new Float32Array(MAX_MASKS * 4),
  brushSel: new Float32Array(MAX_MASKS * 4),
  rMeta: new Float32Array(MAX_REFINE * 4),
  rGeoA: new Float32Array(MAX_REFINE * 4),
  rGeoB: new Float32Array(MAX_REFINE * 4),
  mRefine: new Float32Array(MAX_MASKS * 2)
}
