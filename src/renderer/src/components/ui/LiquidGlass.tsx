import { useEffect, useRef } from 'react'

// Real Liquid Glass, rendered in WebGL.
//
// A single full-viewport canvas sits behind all UI. It renders a subtle, slowly
// flowing ambient field, then — for every `.lx-glass` panel on screen — refracts
// and chromatically disperses that field through the panel's rounded-rect lens,
// adds a specular highlight and a liquid bulge that track the cursor, and a
// shimmering chromatic rim. The panels themselves are transparent DOM laid on
// top; this canvas is their living glass material.
//
// CSS `backdrop-filter` cannot bend light in Chromium, which is why the glass is
// a shader. On WebGL failure we set nothing and the CSS fallback on `.lx-glass`
// takes over.

const MAXP = 8

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `
precision highp float;
uniform vec2 uRes;      // CSS px
uniform float uDpr;
uniform float uTime;
uniform vec2 uMouse;    // CSS px, top-left origin
uniform vec4 uRect[${MAXP}];   // x, y, w, h  (CSS px, top-left)
uniform float uRad[${MAXP}];
uniform int uCount;

// Subtle, slowly flowing ambient field. Mostly near-black so the UI stays a pro
// dark tool; gentle colour gives the glass something to refract.
vec3 ambient(vec2 px) {
  vec2 uv = px / uRes;
  float t = uTime * 0.035;
  // Subtle vertical depth — a touch lighter at the top, deeper toward the base.
  vec3 c = mix(vec3(0.03, 0.03, 0.039), vec3(0.052, 0.048, 0.064), 1.0 - uv.y);
  vec2 a = vec2(0.14 + 0.05 * sin(t), 0.18 + 0.04 * cos(t * 1.1));
  vec2 b = vec2(0.88 + 0.05 * cos(t * 0.8), 0.82 + 0.05 * sin(t * 0.9));
  // Whisper-faint tint so the glass has something to refract — not glowing orbs.
  // A hair of warm on one corner, cool on the other; near-monochrome overall.
  c += vec3(1.0, 0.30, 0.52) * smoothstep(0.46, 0.0, distance(uv, a)) * 0.045;
  c += vec3(0.30, 0.40, 0.62) * smoothstep(0.52, 0.0, distance(uv, b)) * 0.04;
  return c;
}

float sdRound(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

void main() {
  vec2 px = gl_FragCoord.xy / uDpr;
  px.y = uRes.y - px.y; // top-left origin
  vec3 col = ambient(px);

  for (int i = 0; i < ${MAXP}; i++) {
    if (i >= uCount) break;
    vec4 r = uRect[i];
    vec2 c = r.xy + r.zw * 0.5;
    vec2 hb = r.zw * 0.5;
    float rad = min(uRad[i], min(hb.x, hb.y)); // clamp so pill shapes render right
    vec2 lp = px - c;
    float dist = sdRound(lp, hb, rad);
    if (dist < 0.0) {
      float e = 1.5;
      vec2 n = normalize(vec2(
        sdRound(lp + vec2(e, 0.0), hb, rad) - sdRound(lp - vec2(e, 0.0), hb, rad),
        sdRound(lp + vec2(0.0, e), hb, rad) - sdRound(lp - vec2(0.0, e), hb, rad)
      ) + 1e-6);

      // Refraction strongest at the rim (thick glass bends most at the edge).
      float edgeF = 1.0 - smoothstep(-32.0, -2.0, dist);
      float amt = edgeF * 24.0;

      // Chromatic dispersion: sample the field at 3 offsets per channel.
      vec3 refr;
      refr.r = ambient(px + n * amt * 1.55).r;
      refr.g = ambient(px + n * amt * 1.0).g;
      refr.b = ambient(px + n * amt * 0.55).b;

      // Half-translucent glass — a real sheet you see the field through, not a
      // dark slab. A lighter tint + lower opacity so the refracted ambient reads.
      vec3 glass = mix(refr, vec3(0.095, 0.088, 0.106), 0.42) * 1.07;

      // Refined edge-light: a soft, near-neutral rim (barely-there warm bias).
      float rim = smoothstep(2.4, 0.0, abs(dist));
      glass += vec3(0.9, 0.82, 0.86) * rim * 0.12;

      // Barely-there chromatic split, exactly at the edge only — a hint of
      // dispersion, not a rainbow fringe.
      float split = smoothstep(1.1, 0.0, abs(dist));
      glass += mix(vec3(0.0, 0.28, 0.5), vec3(0.5, 0.0, 0.2), 0.5 + 0.5 * n.x) * split * 0.035;

      col = glass;
    }
  }
  gl_FragColor = vec4(col, 1.0);
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type)
  if (!s) return null
  gl.shaderSource(s, src)
  gl.compileShader(s)
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[liquid-glass] shader error:', gl.getShaderInfoLog(s))
    gl.deleteShader(s)
    return null
  }
  return s
}

export function LiquidGlass(): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const cv = canvasRef.current
    if (!cv) return
    const canvas = cv // non-null for the closures below
    const ctx = canvas.getContext('webgl', { premultipliedAlpha: false, antialias: false })
    if (!ctx) return // CSS fallback on .lx-glass takes over
    const gl = ctx // non-null for the closures below

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) return
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[liquid-glass] link error:', gl.getProgramInfoLog(prog))
      return
    }
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const U = {
      res: gl.getUniformLocation(prog, 'uRes'),
      dpr: gl.getUniformLocation(prog, 'uDpr'),
      time: gl.getUniformLocation(prog, 'uTime'),
      mouse: gl.getUniformLocation(prog, 'uMouse'),
      rect: gl.getUniformLocation(prog, 'uRect'),
      rad: gl.getUniformLocation(prog, 'uRad'),
      count: gl.getUniformLocation(prog, 'uCount')
    }

    // WebGL works — let CSS drop the fallback glass background.
    document.documentElement.dataset.webgl = 'ok'

    let dpr = Math.min(window.devicePixelRatio || 1, 2)
    function resize(): void {
      dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()
    window.addEventListener('resize', resize)

    const mouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 }
    const target = { ...mouse }
    function onMove(e: MouseEvent): void {
      target.x = e.clientX
      target.y = e.clientY
    }
    window.addEventListener('mousemove', onMove)

    const rectData = new Float32Array(MAXP * 4)
    const radData = new Float32Array(MAXP)
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const start = performance.now()
    let raf = 0
    // getComputedStyle is expensive; corner radius rarely changes, so read it at
    // most a few times per second and cache per element.
    const radiusCache = new WeakMap<Element, number>()
    let radiusTick = 0

    function frame(now: number): void {
      // Smoothly ease the light/bulge toward the cursor for a liquid feel.
      mouse.x += (target.x - mouse.x) * 0.12
      mouse.y += (target.y - mouse.y) * 0.12

      const refreshRadii = radiusTick++ % 20 === 0
      const panels = document.querySelectorAll<HTMLElement>('.lx-glass')
      let count = 0
      for (let i = 0; i < panels.length && count < MAXP; i++) {
        const el = panels[i]
        const r = el.getBoundingClientRect()
        if (r.width < 2 || r.height < 2) continue
        let radius = radiusCache.get(el)
        if (radius === undefined || refreshRadii) {
          radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 16
          radiusCache.set(el, radius)
        }
        rectData[count * 4] = r.left
        rectData[count * 4 + 1] = r.top
        rectData[count * 4 + 2] = r.width
        rectData[count * 4 + 3] = r.height
        radData[count] = radius
        count++
      }

      gl.uniform2f(U.res, window.innerWidth, window.innerHeight)
      gl.uniform1f(U.dpr, dpr)
      gl.uniform1f(U.time, reduceMotion ? 0 : (now - start) / 1000)
      gl.uniform2f(U.mouse, mouse.x, mouse.y)
      gl.uniform4fv(U.rect, rectData)
      gl.uniform1fv(U.rad, radData)
      gl.uniform1i(U.count, count)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMove)
      delete document.documentElement.dataset.webgl
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0"
      style={{ display: 'block' }}
    />
  )
}
