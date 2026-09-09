import { useStore } from '../store/useStore'
import { defaultEditState, zeroMaskAdjust, type PhotoVM } from '../types'
// Bundled only when this dev module is included (tree-shaken from production).
import testPhoto from './test-photo.jpg?url'

// DEV-ONLY design preview. Imported dynamically behind `import.meta.env.DEV`, so
// Vite tree-shakes this whole module out of the production bundle. In a plain
// browser (no preload bridge) it seeds sample photos so the populated UI —
// sliders, mode switch, liquid glass — can be reviewed. Never runs in the app.
export function enablePreview(): void {
  if (typeof window === 'undefined') return
  if ((window as { luxinus?: unknown }).luxinus) return
  const search = window.location.search
  // Handle for the design-review harness to drive the store from the outside.
  ;(window as unknown as { __lxStore?: unknown }).__lxStore = useStore
  if (search.includes('empty')) return
  const photos: PhotoVM[] = Array.from({ length: 9 }, (_, i) => ({
    filePath: `/Pictures/2026-07/IMG_${2040 + i}.RAW`,
    fileName: `IMG_${2040 + i}.RAW`,
    ext: '.raw',
    isRaw: true,
    mtimeMs: 0,
    size: 0,
    meta: { width: 1200, height: 800, cameraModel: 'ILCE-7M4', iso: 400 },
    rating: i === 0 ? 4 : 0,
    flagged: i === 1,
    thumbUrl: testPhoto
  }))
  useStore.setState({
    folderPath: '/Pictures/2026-07',
    photos,
    selectedPath: photos[0].filePath,
    // Feed a real image straight into the develop pipeline (no preload here).
    proxy: { filePath: photos[0].filePath, url: testPhoto, status: 'ready', message: null }
  })
  if (search.includes('expert')) useStore.getState().setMode('expert')
  // Optional query params to preview specific edits: e.g. ?expert&exposure=60&contrast=40
  const params = new URLSearchParams(search)
  const patch: Record<string, number> = {}
  for (const k of ['exposure', 'contrast', 'highlights', 'shadows', 'temperature', 'saturation', 'vibrance', 'vignette', 'clarity', 'dehaze', 'texture', 'grain']) {
    const v = params.get(k)
    if (v !== null) patch[k] = Number(v)
  }
  if (Object.keys(patch).length) useStore.getState().setEdit(patch)

  // ?export — open the export dialog (optionally &frame for Frame mode).
  if (search.includes('export')) {
    useStore.getState().setExportOpen(true)
  }

  // ?crop — sample inset crop (dev only). &applied shows the cropped result
  // (crop mode off) so the display-aspect handling can be reviewed.
  if (search.includes('crop')) {
    useStore.getState().setEdit({ crop: { x: 0.12, y: 0.1, w: 0.66, h: 0.62 } })
    useStore.getState().setCropMode(!search.includes('applied'))
  }

  // ?mask — inject sample radial + linear masks (dev only) to review shader output.
  if (search.includes('mask')) {
    const zero = zeroMaskAdjust()
    useStore.getState().setEdit({
      masks: [
        {
          id: 'm1', kind: 'radial', name: 'Radial', enabled: true,
          adjust: { ...zero, exposure: -60, saturation: -40 },
          radial: { cx: 0.68, cy: 0.32, rx: 0.22, ry: 0.28, feather: 0.5, invert: false }
        },
        {
          id: 'm2', kind: 'linear', name: 'Sky', enabled: true,
          adjust: { ...zero, exposure: -30, temperature: -40, saturation: 30 },
          linear: { x1: 0.5, y1: 0.05, x2: 0.5, y2: 0.5 }
        }
      ]
    })
    // Select one so its interactive overlay renders for review.
    useStore.getState().selectMask(search.includes('linear') ? 'm2' : 'm1')
    if (search.includes('maskmode')) useStore.getState().setMaskMode(true)
  }

  // ?brush — inject a brush mask with a painted stroke (dev only) to review the
  // brush coverage texture + painting overlay.
  if (search.includes('brush')) {
    const zero = zeroMaskAdjust()
    const pts = Array.from({ length: 12 }, (_, i) => ({ x: 0.25 + i * 0.04, y: 0.55 + Math.sin(i * 0.6) * 0.08 }))
    useStore.getState().setEdit({
      masks: [
        {
          id: 'b1', kind: 'brush', name: 'Brush 1', enabled: true,
          adjust: { ...zero, exposure: 70, saturation: 50 },
          brush: { strokes: [{ points: pts, radius: 0.06, erase: false }] }
        }
      ]
    })
    useStore.getState().selectMask('b1')
  }

  // ?lumrange — inject a luminance-range mask pulling highlights down (the DR
  // recovery case) so the shader branch + range UI can be reviewed (dev only).
  // &wb / &bw switch the overlay to white-on-black / black-on-white.
  if (search.includes('lumrange')) {
    const zero = zeroMaskAdjust()
    const density = params.get('density') ? Number(params.get('density')) / 100 : undefined
    useStore.getState().setEdit({
      masks: [
        {
          id: 'lr1', kind: 'lumRange', name: 'Luminance 1', enabled: true, density,
          adjust: { ...zero, exposure: -55, highlights: -60, saturation: 15 },
          lum: { lo: 0.72, hi: 1, featherLo: 0.18, featherHi: 0.02 }
        }
      ]
    })
    useStore.getState().selectMask('lr1')
    useStore.getState().setMaskMode(true)
    if (search.includes('wb')) useStore.setState({ maskOverlayMode: 1 })
    if (search.includes('bw')) useStore.setState({ maskOverlayMode: 2 })
    if (search.includes('nooverlay')) useStore.getState().setShowMaskOverlay(false)
  }

  // ?refine — a combined mask: bright tones MINUS the sky blue → isolates the
  // sun/moon discs. Verifies the refinement fold (dev only).
  if (search.includes('refine')) {
    const zero = zeroMaskAdjust()
    useStore.getState().setEdit({
      masks: [
        {
          id: 'rf1', kind: 'lumRange', name: 'Luminance 1', enabled: true,
          adjust: { ...zero, exposure: -70 },
          lum: { lo: 0.6, hi: 1, featherLo: 0.1, featherHi: 0.02 },
          refine: [
            {
              id: 'rf1a', kind: 'colorRange', mode: 'subtract', invert: false,
              color: { rgb: [120, 165, 230], tolerance: 0.45, feather: 0.3 }
            }
          ]
        }
      ]
    })
    useStore.getState().selectMask('rf1')
    useStore.getState().selectRefine('rf1a')
    useStore.getState().setMaskMode(true)
    if (search.includes('nooverlay')) useStore.getState().setShowMaskOverlay(false)
  }

  // ?colorrange — inject a color-range mask sampled on the sky blue so the
  // Oklab distance branch + controls can be reviewed (dev only).
  if (search.includes('colorrange')) {
    const zero = zeroMaskAdjust()
    useStore.getState().setEdit({
      masks: [
        {
          id: 'cr1', kind: 'colorRange', name: 'Color 1', enabled: true,
          adjust: { ...zero, saturation: -70, exposure: 20 },
          color: { rgb: [80, 140, 225], tolerance: 0.35, feather: 0.3 }
        }
      ]
    })
    useStore.getState().selectMask('cr1')
    useStore.getState().setMaskMode(true)
    if (search.includes('nooverlay')) useStore.getState().setShowMaskOverlay(false)
  }

  // ?zebra — enable the clipping zebra overlays (dev only).
  if (search.includes('zebra')) useStore.getState().setShowClipping(true)

  // ?grade — seed a teal-shadow / warm-highlight color grade to verify the
  // color-grading shader pass + wheels (dev only).
  if (search.includes('grade')) {
    useStore.getState().setEdit({
      colorGrade: {
        shadows: { hue: 200, sat: 45, lum: -10 },
        midtones: { hue: 40, sat: 20, lum: 0 },
        highlights: { hue: 45, sat: 40, lum: 8 },
        global: { hue: 0, sat: 0, lum: 0 },
        blending: 50,
        balance: 0
      }
    })
  }

  // Seed sample presets so the Presets panel + thumbnails render in browser preview.
  {
    const d = defaultEditState()
    useStore.setState({
      presets: [
        { id: 'p1', name: 'Warm Film', origin: 'native', createdAt: '', edits: { ...d, temperature: 30, contrast: 20, saturation: -10, vibrance: 20, vignette: -25 } },
        { id: 'p2', name: 'Cool Matte', origin: 'native', createdAt: '', edits: { ...d, temperature: -25, shadows: 30, blacks: 20, contrast: -15, saturation: -20 } },
        { id: 'p3', name: 'Punch', origin: 'xmp', createdAt: '', edits: { ...d, contrast: 40, clarity: 30, vibrance: 35, exposure: 10 } },
        { id: 'p4', name: 'B&W', origin: 'native', createdAt: '', edits: { ...d, saturation: -100, contrast: 25, clarity: 20 } }
      ]
    })
  }

  // ?showcase — drive a dramatic curve + HSL + split so the advanced controls
  // can be verified in a screenshot (dev only).
  if (search.includes('showcase')) {
    const st = useStore.getState()
    st.setCurve('rgb', [
      { x: 0, y: 0.06 },
      { x: 0.28, y: 0.16 },
      { x: 0.72, y: 0.86 },
      { x: 1, y: 0.96 }
    ])
    st.setHsl('blue', { hue: -30, sat: 40, lum: 20 })
    st.setHsl('green', { hue: 20, sat: -40, lum: -20 })
    st.setEdit({ vignette: -35, clarity: 30 })
    st.setSplit(true)
    st.setSplitPos(0.5)
  }
}
