import { create } from 'zustand'
import {
  DEFAULT_FILTER,
  coerceEditState,
  defaultEditState,
  isEdited,
  zeroMaskAdjust,
  type ColorGradeRegion,
  type ColorGradeRegionKey,
  type CurveChannel,
  type CurvePoint,
  type EditState,
  type EditorMode,
  type FilterState,
  type HslBand,
  type Mask,
  type MaskAdjust,
  type MaskKind,
  type PhotoMeta,
  type PhotoVM,
  type ProxyState
} from '../types'
import { applyPreset, type Preset } from '../../../shared/presets'

function webpToUrl(bytes: Uint8Array): string {
  // Copy into a fresh ArrayBuffer so the Blob owns its memory.
  const copy = new Uint8Array(bytes)
  return URL.createObjectURL(new Blob([copy], { type: 'image/webp' }))
}

const clampWb = (v: number): number => Math.round(Math.min(100, Math.max(-100, v)))

// A named saved edit state for a photo (Lightroom-style snapshot).
export interface Snapshot {
  id: string
  name: string
  edit: EditState
  createdAt: string
}

function loadImageEl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = url
  })
}

const IDLE_PROXY: ProxyState = { filePath: null, url: null, status: 'idle', message: null }

// Debounced sidecar autosave — coalesces rapid slider changes into one write.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
function scheduleSave(filePath: string, edit: EditState): void {
  if (!window.luxinus) return
  const prev = saveTimers.get(filePath)
  if (prev) clearTimeout(prev)
  saveTimers.set(
    filePath,
    setTimeout(() => {
      saveTimers.delete(filePath)
      window.luxinus.edits.save(filePath, edit).catch(() => {})
    }, 450)
  )
}

// Resizable panel widths (px), persisted between sessions.
const DRAWER_MIN = 220
const DRAWER_MAX = 460
const PANEL_MIN = 288
const PANEL_MAX = 560
const clampPx = (v: number, lo: number, hi: number): number => Math.round(Math.min(hi, Math.max(lo, v)))
function readWidth(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : fallback
  } catch {
    return fallback
  }
}
function persistWidth(key: string, v: number): void {
  try {
    localStorage.setItem(key, String(v))
  } catch {
    /* storage unavailable — widths stay session-only */
  }
}

interface LuxinusState {
  // UI
  mode: EditorMode
  drawerCollapsed: boolean
  setMode: (mode: EditorMode) => void
  toggleDrawer: () => void

  // Resizable layout — the drawer (left) and edit panel (right) widths, in px.
  drawerWidth: number
  panelWidth: number
  setDrawerWidth: (w: number) => void
  setPanelWidth: (w: number) => void

  // Crop editing (transient UI state — the crop itself lives in edit.crop)
  cropMode: boolean
  cropAspect: number | null // locked aspect ratio (w/h), or null for free
  setCropMode: (v: boolean) => void
  setCropAspect: (a: number | null) => void

  // Show the alignment grid while the Straighten slider is being dragged.
  straightening: boolean
  setStraightening: (v: boolean) => void

  // White-balance eyedropper: click a neutral area to auto-set Temperature/Tint.
  wbPicking: boolean
  setWbPicking: (v: boolean) => void
  pickWhiteBalance: (r: number, g: number, b: number) => void

  // Masking is a dedicated workspace (like Lightroom), toggled on/off.
  maskMode: boolean
  setMaskMode: (v: boolean) => void
  // Local masks (the masks themselves live in edit.masks; selection is UI state)
  selectedMaskId: string | null
  selectMask: (id: string | null) => void
  addMask: (kind: MaskKind) => void
  updateMask: (id: string, patch: Partial<Mask>) => void
  updateMaskAdjust: (id: string, patch: Partial<MaskAdjust>) => void
  removeMask: (id: string) => void
  // Mask coverage overlay (red preview of the selected mask's reach)
  showMaskOverlay: boolean
  setShowMaskOverlay: (v: boolean) => void
  suppressMaskOverlay: boolean // transient: hide overlay while dragging an adjustment
  setSuppressMaskOverlay: (v: boolean) => void
  // Brush painting
  brushRadius: number // normalized (fraction of image width)
  brushErase: boolean
  setBrushRadius: (r: number) => void
  setBrushErase: (v: boolean) => void
  startBrushStroke: (id: string, pt: { x: number; y: number }) => void
  extendBrushStroke: (id: string, pt: { x: number; y: number }) => void
  clearBrush: (id: string) => void

  // Library
  folderPath: string | null
  photos: PhotoVM[]
  selectedPath: string | null
  loadingLibrary: boolean
  filter: FilterState
  setFilter: (patch: Partial<FilterState>) => void
  editedPaths: Set<string> // photos with non-default edits (thumbnail badge)

  openFolder: () => Promise<void>
  applyThumbnail: (filePath: string, bytes: Uint8Array, meta: PhotoMeta) => void
  selectPhoto: (filePath: string) => void
  setRating: (filePath: string, rating: number) => void
  setFlag: (filePath: string, flagged: boolean) => void

  // Multi-selection for batch operations (the active photo — selectedPath — is
  // always a member). Cmd/Ctrl toggles, Shift extends a range.
  selection: Set<string>
  pickPhoto: (filePath: string, mods: { meta: boolean; shift: boolean }) => void
  clearSelection: () => void
  // Copy the current develop settings (minus framing) onto every selected photo's
  // sidecar. Returns how many were written.
  syncing: boolean
  syncEditToSelection: () => Promise<number>

  // Proxy (selected photo, rendered on the stage)
  proxy: ProxyState

  // Edit state (non-destructive; autosaved to a sidecar)
  edit: EditState
  setEdit: (patch: Partial<EditState>) => void
  setHsl: (band: HslBand, patch: Partial<{ hue: number; sat: number; lum: number }>) => void
  setColorGrade: (region: ColorGradeRegionKey, patch: Partial<ColorGradeRegion>) => void
  setColorGradeParam: (patch: Partial<{ blending: number; balance: number }>) => void
  setCurve: (channel: CurveChannel, points: CurvePoint[]) => void
  applyEdit: (edit: EditState) => void // wholesale replace (Auto Enhance)
  resetEdit: () => void

  // Copy/paste develop settings across photos (geometry stays photo-specific)
  clipboard: EditState | null
  copyEdit: () => void
  pasteEdit: () => void

  // Undo / redo (per-photo; a continuous drag coalesces into one step)
  undoStack: EditState[]
  redoStack: EditState[]
  undo: () => void
  redo: () => void
  // Jump to an absolute point in the combined history timeline (index into
  // [...undoStack, edit, ...redoStack reversed]).
  jumpToHistory: (index: number) => void

  // Snapshots — named saved edit states for the current photo (session-scoped).
  snapshots: Snapshot[]
  saveSnapshot: (name: string) => void
  applySnapshot: (id: string) => void
  renameSnapshot: (id: string, name: string) => void
  deleteSnapshot: (id: string) => void

  // AI denoise — a restored copy of the current proxy the develop shader blends
  // in by the Denoise slider. Computed on demand (slow), cached per photo.
  denoiseProxy: {
    filePath: string | null
    url: string | null
    status: 'idle' | 'running' | 'ready' | 'error'
    progress: number
    message: string | null
  }
  runDenoise: () => Promise<void>
  clearDenoise: () => void

  // Live RGB+luma histogram of the developed preview (computed by EditCanvas)
  histogram: { r: number[]; g: number[]; b: number[]; lum: number[] } | null
  setHistogram: (h: { r: number[]; g: number[]; b: number[]; lum: number[] }) => void

  // Before/after compare
  showBefore: boolean
  setShowBefore: (v: boolean) => void
  splitCompare: boolean
  splitPos: number // 0..1 divider position
  setSplit: (on: boolean) => void
  setSplitPos: (p: number) => void

  // Export dialog
  exportOpen: boolean
  setExportOpen: (v: boolean) => void

  // Presets
  presets: Preset[]
  loadPresets: () => Promise<void>
  savePreset: (name: string) => Promise<void>
  deletePreset: (id: string) => Promise<void>
  applyPresetToCurrent: (preset: Preset) => void
}

export const useStore = create<LuxinusState>((set, get) => {
  // ── Undo/redo history ──────────────────────────────────────────────────────
  // A drag fires commitEdit on every tick; we don't want 100 undo steps per
  // drag. So we hold a `baseline` (the state at the last checkpoint) and only
  // push it onto the undo stack once edits go quiet for a beat — one drag = one
  // step. Switching photos resets the baseline (history is per-photo).
  let histBaseline: EditState = defaultEditState()
  let histTimer: ReturnType<typeof setTimeout> | null = null
  function checkpointNow(): void {
    if (histTimer) {
      clearTimeout(histTimer)
      histTimer = null
    }
    const cur = get().edit
    if (JSON.stringify(cur) === JSON.stringify(histBaseline)) return
    set((s) => ({ undoStack: [...s.undoStack, histBaseline].slice(-100), redoStack: [] }))
    histBaseline = cur
  }
  function scheduleCheckpoint(): void {
    if (histTimer) clearTimeout(histTimer)
    histTimer = setTimeout(checkpointNow, 450)
  }
  function resetHistory(edit: EditState): void {
    if (histTimer) {
      clearTimeout(histTimer)
      histTimer = null
    }
    histBaseline = edit
    set({ undoStack: [], redoStack: [] })
  }

  // Snapshots persist per-photo for the life of the session.
  const snapshotStore = new Map<string, Snapshot[]>()

  // Write an edit into state: recompute the edited badge + schedule a save.
  function writeEdit(edit: EditState): void {
    const path = get().selectedPath
    if (!path) return
    set((s) => {
      const next = new Set(s.editedPaths)
      if (isEdited(edit)) next.add(path)
      else next.delete(path)
      return { edit, editedPaths: next }
    })
    scheduleSave(path, edit)
  }

  // After a user edit: write it, then schedule a coalesced history checkpoint.
  function commitEdit(edit: EditState): void {
    if (!get().selectedPath) return
    writeEdit(edit)
    scheduleCheckpoint()
  }

  return {
    mode: 'simple',
    drawerCollapsed: false,
    setMode: (mode) => set({ mode }),
    toggleDrawer: () => set((s) => ({ drawerCollapsed: !s.drawerCollapsed })),

    drawerWidth: readWidth('lx-drawer-w', 288),
    panelWidth: readWidth('lx-panel-w', 320),
    setDrawerWidth: (w) => {
      const v = clampPx(w, DRAWER_MIN, DRAWER_MAX)
      persistWidth('lx-drawer-w', v)
      set({ drawerWidth: v })
    },
    setPanelWidth: (w) => {
      const v = clampPx(w, PANEL_MIN, PANEL_MAX)
      persistWidth('lx-panel-w', v)
      set({ panelWidth: v })
    },

    cropMode: false,
    cropAspect: null,
    setCropMode: (v) => set((s) => ({ cropMode: v, maskMode: v ? false : s.maskMode })),
    setCropAspect: (a) => set({ cropAspect: a }),

    straightening: false,
    setStraightening: (v) => set({ straightening: v }),

    wbPicking: false,
    setWbPicking: (v) => set({ wbPicking: v }),
    pickWhiteBalance: (r, g, b) => {
      // Solve the shader's WB model so the sampled pixel becomes neutral.
      // Temp warms/cools (R↔B); Tint balances G against the R/B average.
      const rr = Math.max(1, r)
      const gg = Math.max(1, g)
      const bb = Math.max(1, b)
      const temperature = clampWb((100 * (bb - rr)) / (0.35 * (rr + bb)))
      const kt = (temperature / 100) * 0.35
      const rp = rr * (1 + kt)
      const bp = bb * (1 - kt)
      const target = (rp + bp) / 2
      const tint = clampWb((100 * (1 - target / gg)) / 0.22)
      get().setEdit({ temperature, tint })
      set({ wbPicking: false })
    },

    maskMode: false,
    setMaskMode: (v) =>
      set((s) => ({
        maskMode: v,
        cropMode: v ? false : s.cropMode, // the two tools are mutually exclusive
        selectedMaskId: v ? s.selectedMaskId : null // clear overlay when leaving
      })),
    selectedMaskId: null,
    selectMask: (id) => set({ selectedMaskId: id }),
    addMask: (kind) => {
      const geom =
        kind === 'radial'
          ? { radial: { cx: 0.5, cy: 0.5, rx: 0.28, ry: 0.34, feather: 0.5, invert: false } }
          : kind === 'linear'
            ? { linear: { x1: 0.5, y1: 0.18, x2: 0.5, y2: 0.6 } }
            : { brush: { strokes: [] } }
      const e = get().edit
      const count = e.masks.filter((m) => m.kind === kind).length + 1
      const label = kind === 'radial' ? 'Radial' : kind === 'linear' ? 'Linear' : 'Brush'
      const mask: Mask = {
        id: crypto.randomUUID(),
        kind,
        name: `${label} ${count}`,
        enabled: true,
        adjust: zeroMaskAdjust(),
        ...geom
      }
      commitEdit({ ...e, masks: [...e.masks, mask] })
      set({ selectedMaskId: mask.id })
    },
    updateMask: (id, patch) => {
      const e = get().edit
      commitEdit({ ...e, masks: e.masks.map((m) => (m.id === id ? { ...m, ...patch } : m)) })
    },
    updateMaskAdjust: (id, patch) => {
      const e = get().edit
      commitEdit({
        ...e,
        masks: e.masks.map((m) => (m.id === id ? { ...m, adjust: { ...m.adjust, ...patch } } : m))
      })
    },
    removeMask: (id) => {
      const e = get().edit
      commitEdit({ ...e, masks: e.masks.filter((m) => m.id !== id) })
      if (get().selectedMaskId === id) set({ selectedMaskId: null })
    },

    showMaskOverlay: true,
    setShowMaskOverlay: (v) => set({ showMaskOverlay: v }),
    suppressMaskOverlay: false,
    setSuppressMaskOverlay: (v) => set({ suppressMaskOverlay: v }),
    brushRadius: 0.05,
    brushErase: false,
    setBrushRadius: (r) => set({ brushRadius: r }),
    setBrushErase: (v) => set({ brushErase: v }),
    startBrushStroke: (id, pt) => {
      const e = get().edit
      const { brushRadius, brushErase } = get()
      commitEdit({
        ...e,
        masks: e.masks.map((m) =>
          m.id === id && m.brush
            ? { ...m, brush: { strokes: [...m.brush.strokes, { points: [pt], radius: brushRadius, erase: brushErase }] } }
            : m
        )
      })
    },
    extendBrushStroke: (id, pt) => {
      const e = get().edit
      commitEdit({
        ...e,
        masks: e.masks.map((m) => {
          if (m.id !== id || !m.brush || m.brush.strokes.length === 0) return m
          const strokes = m.brush.strokes.slice()
          const last = strokes[strokes.length - 1]
          strokes[strokes.length - 1] = { ...last, points: [...last.points, pt] }
          return { ...m, brush: { strokes } }
        })
      })
    },
    clearBrush: (id) => {
      const e = get().edit
      commitEdit({
        ...e,
        masks: e.masks.map((m) => (m.id === id && m.brush ? { ...m, brush: { strokes: [] } } : m))
      })
    },

    folderPath: null,
    photos: [],
    selectedPath: null,
    loadingLibrary: false,
    filter: { ...DEFAULT_FILTER },
    setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
    editedPaths: new Set(),

    openFolder: async () => {
      if (!window.luxinus) return
      set({ loadingLibrary: true })
      try {
        const res = await window.luxinus.library.openFolder()
        if (res.canceled) return
        for (const p of get().photos) if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl)
        const proxy = get().proxy
        if (proxy.url) URL.revokeObjectURL(proxy.url)

        const photos: PhotoVM[] = res.photos.map((p) => ({ ...p, thumbUrl: null }))
        set({
          folderPath: res.folderPath,
          photos,
          selectedPath: null,
          selection: new Set(),
          filter: { ...DEFAULT_FILTER },
          proxy: { ...IDLE_PROXY },
          edit: defaultEditState(),
          editedPaths: new Set()
        })
        if (photos[0]) get().selectPhoto(photos[0].filePath)
        // Mark which photos already have a sidecar (edited badge).
        window.luxinus.edits
          .editedList(photos.map((p) => p.filePath))
          .then((edited) => set({ editedPaths: new Set(edited) }))
          .catch(() => {})
      } finally {
        set({ loadingLibrary: false })
      }
    },

    applyThumbnail: (filePath, bytes, meta) =>
      set((s) => ({
        photos: s.photos.map((p) => {
          if (p.filePath !== filePath) return p
          if (p.thumbUrl) URL.revokeObjectURL(p.thumbUrl)
          return { ...p, thumbUrl: webpToUrl(bytes), meta: p.meta ?? meta }
        })
      })),

    selectPhoto: (filePath) => {
      const cur = get()
      if (cur.selectedPath === filePath && cur.proxy.status !== 'idle') return
      const photo = cur.photos.find((p) => p.filePath === filePath)
      if (cur.proxy.url) URL.revokeObjectURL(cur.proxy.url)
      set({
        selectedPath: filePath,
        selection: new Set([filePath]),
        edit: defaultEditState(),
        proxy: { filePath, url: null, status: 'loading', message: null },
        cropMode: false,
        maskMode: false,
        selectedMaskId: null,
        snapshots: snapshotStore.get(filePath) ?? [],
        denoiseProxy: { filePath: null, url: null, status: 'idle', progress: 0, message: null }
      })
      resetHistory(defaultEditState())
      if (!window.luxinus || !photo) return

      // Load this photo's saved edits (sidecar) — ignore if user moves on.
      window.luxinus.edits
        .load(filePath)
        .then((loaded) => {
          if (get().selectedPath !== filePath || !loaded) return
          const edit = coerceEditState(loaded)
          set((s) => {
            const next = new Set(s.editedPaths)
            if (isEdited(edit)) next.add(filePath)
            return { edit, editedPaths: next }
          })
          // Loaded sidecar becomes the history baseline for this photo.
          resetHistory(edit)
        })
        .catch(() => {})

      window.luxinus.library
        .requestProxy(filePath, photo.mtimeMs)
        .then((res) => {
          if (get().selectedPath !== filePath) return
          set({ proxy: { filePath, url: webpToUrl(res.webp), status: 'ready', message: null } })
        })
        .catch((err: Error) => {
          if (get().selectedPath !== filePath) return
          set({
            proxy: { filePath, url: null, status: 'error', message: friendlyDecodeError(err.message) }
          })
        })
    },

    setRating: (filePath, rating) => {
      set((s) => ({
        photos: s.photos.map((p) => (p.filePath === filePath ? { ...p, rating } : p))
      }))
      window.luxinus?.library.setRating(filePath, rating).catch(() => {})
    },

    setFlag: (filePath, flagged) => {
      set((s) => ({
        photos: s.photos.map((p) => (p.filePath === filePath ? { ...p, flagged } : p))
      }))
      window.luxinus?.library.setFlag(filePath, flagged).catch(() => {})
    },

    selection: new Set(),
    pickPhoto: (filePath, mods) => {
      const s = get()
      if (mods.shift && s.selectedPath) {
        // Range-select from the active photo to the clicked one (filtered order).
        const order = selectFilteredPhotos(s).map((p) => p.filePath)
        const a = order.indexOf(s.selectedPath)
        const b = order.indexOf(filePath)
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          const next = new Set(order.slice(lo, hi + 1))
          next.add(s.selectedPath)
          set({ selection: next })
          return
        }
      }
      if (mods.meta) {
        // Toggle membership without changing the active (source) photo.
        const next = new Set(s.selection)
        if (next.has(filePath) && filePath !== s.selectedPath) next.delete(filePath)
        else next.add(filePath)
        if (s.selectedPath) next.add(s.selectedPath)
        set({ selection: next })
        return
      }
      // Plain click: single-select + make active.
      get().selectPhoto(filePath)
    },
    clearSelection: () => {
      const p = get().selectedPath
      set({ selection: p ? new Set([p]) : new Set() })
    },
    syncing: false,
    syncEditToSelection: async () => {
      const s = get()
      if (!window.luxinus || !s.selectedPath) return 0
      // Everything but this photo's own framing — a look, not a crop.
      const look = { ...s.edit, crop: null, rotate: 0, flipH: false, flipV: false }
      const targets = [...s.selection].filter((p) => p !== s.selectedPath)
      if (targets.length === 0) return 0
      set({ syncing: true })
      try {
        const written = new Set<string>()
        await Promise.all(
          targets.map(async (path) => {
            // Preserve each target's existing framing if it has a sidecar.
            const existing = await window.luxinus.edits.load(path).catch(() => null)
            const merged = existing
              ? { ...look, crop: existing.crop, rotate: existing.rotate, flipH: existing.flipH, flipV: existing.flipV }
              : look
            const ok = await window.luxinus.edits.save(path, merged).catch(() => false)
            if (ok) written.add(path)
          })
        )
        set((st) => {
          const badge = new Set(st.editedPaths)
          for (const p of written) badge.add(p)
          return { editedPaths: badge }
        })
        return written.size
      } finally {
        set({ syncing: false })
      }
    },

    proxy: { ...IDLE_PROXY },

    edit: defaultEditState(),
    setEdit: (patch) => commitEdit({ ...get().edit, ...patch }),
    setHsl: (band, patch) => {
      const e = get().edit
      commitEdit({ ...e, hsl: { ...e.hsl, [band]: { ...e.hsl[band], ...patch } } })
    },
    setColorGrade: (region, patch) => {
      const e = get().edit
      commitEdit({
        ...e,
        colorGrade: { ...e.colorGrade, [region]: { ...e.colorGrade[region], ...patch } }
      })
    },
    setColorGradeParam: (patch) => {
      const e = get().edit
      commitEdit({ ...e, colorGrade: { ...e.colorGrade, ...patch } })
    },
    setCurve: (channel, points) => {
      const e = get().edit
      commitEdit({ ...e, curves: { ...e.curves, [channel]: points } })
    },
    applyEdit: (edit) => commitEdit(edit),
    resetEdit: () => commitEdit(defaultEditState()),

    clipboard: null,
    copyEdit: () => set({ clipboard: get().edit }),
    pasteEdit: () => {
      const c = get().clipboard
      if (!c || !get().selectedPath) return
      const e = get().edit
      // Paste the look; keep this photo's own framing (like Lightroom).
      commitEdit({ ...c, crop: e.crop, rotate: e.rotate, flipH: e.flipH, flipV: e.flipV })
    },

    undoStack: [],
    redoStack: [],
    undo: () => {
      checkpointNow() // flush any in-flight drag into history first
      const s = get()
      if (!s.undoStack.length) return
      const prev = s.undoStack[s.undoStack.length - 1]
      set((st) => ({ undoStack: st.undoStack.slice(0, -1), redoStack: [...st.redoStack, st.edit] }))
      histBaseline = prev
      writeEdit(prev)
    },
    redo: () => {
      const s = get()
      if (!s.redoStack.length) return
      const next = s.redoStack[s.redoStack.length - 1]
      set((st) => ({ redoStack: st.redoStack.slice(0, -1), undoStack: [...st.undoStack, st.edit] }))
      histBaseline = next
      writeEdit(next)
    },
    jumpToHistory: (index) => {
      checkpointNow() // flush any in-flight drag so the timeline is complete
      const s = get()
      const timeline = [...s.undoStack, s.edit, ...[...s.redoStack].reverse()]
      const i = Math.max(0, Math.min(timeline.length - 1, index))
      const target = timeline[i]
      const undoStack = timeline.slice(0, i)
      const redoStack = timeline.slice(i + 1).reverse()
      set({ undoStack, redoStack })
      histBaseline = target
      writeEdit(target)
    },

    snapshots: [],
    saveSnapshot: (name) => {
      const path = get().selectedPath
      if (!path) return
      const snap: Snapshot = {
        id: crypto.randomUUID(),
        name: name.trim() || `Snapshot ${(snapshotStore.get(path)?.length ?? 0) + 1}`,
        edit: get().edit,
        createdAt: new Date().toISOString()
      }
      const list = [...(snapshotStore.get(path) ?? []), snap]
      snapshotStore.set(path, list)
      set({ snapshots: list })
    },
    applySnapshot: (id) => {
      const snap = get().snapshots.find((x) => x.id === id)
      if (!snap) return
      // Keep the current framing (like paste/preset), swap in the saved look.
      const e = get().edit
      commitEdit({ ...snap.edit, crop: e.crop, rotate: e.rotate, flipH: e.flipH, flipV: e.flipV })
    },
    renameSnapshot: (id, name) => {
      const path = get().selectedPath
      if (!path) return
      const list = (snapshotStore.get(path) ?? []).map((x) => (x.id === id ? { ...x, name } : x))
      snapshotStore.set(path, list)
      set({ snapshots: list })
    },
    deleteSnapshot: (id) => {
      const path = get().selectedPath
      if (!path) return
      const list = (snapshotStore.get(path) ?? []).filter((x) => x.id !== id)
      snapshotStore.set(path, list)
      set({ snapshots: list })
    },

    denoiseProxy: { filePath: null, url: null, status: 'idle', progress: 0, message: null },
    runDenoise: async () => {
      const st = get()
      if (!window.luxinus || st.proxy.status !== 'ready' || !st.proxy.url || !st.selectedPath) return
      const path = st.selectedPath
      const proxyUrl = st.proxy.url
      set({ denoiseProxy: { filePath: path, url: null, status: 'running', progress: 0, message: null } })
      const off = window.luxinus.ai.onProgress(({ progress }) => {
        if (get().denoiseProxy.filePath === path && get().denoiseProxy.status === 'running') {
          set((s) => ({ denoiseProxy: { ...s.denoiseProxy, progress } }))
        }
      })
      try {
        const img = await loadImageEl(proxyUrl)
        // Denoise a downscaled preview so it stays responsive (inference cost
        // scales with pixels); the develop shader upsamples it. Full-res denoise
        // is an export-time concern.
        const PREVIEW_MAX = 1600
        const scale = Math.min(1, PREVIEW_MAX / Math.max(img.naturalWidth, img.naturalHeight))
        const c = document.createElement('canvas')
        c.width = Math.max(1, Math.round(img.naturalWidth * scale))
        c.height = Math.max(1, Math.round(img.naturalHeight * scale))
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0, c.width, c.height)
        const rgba = new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer)
        const res = await window.luxinus.ai.denoise({ rgba, width: c.width, height: c.height, strength: 100 })
        if (get().selectedPath !== path) return
        if (!res.ok || !res.rgba || !res.width || !res.height) {
          set((s) => ({ denoiseProxy: { ...s.denoiseProxy, status: 'error', message: res.message ?? 'Denoise unavailable.' } }))
          return
        }
        ctx.putImageData(new ImageData(new Uint8ClampedArray(res.rgba), res.width, res.height), 0, 0)
        const url = c.toDataURL('image/png')
        set({ denoiseProxy: { filePath: path, url, status: 'ready', progress: 1, message: null } })
        // Give the slider a sensible starting strength if it's still at zero.
        if (get().edit.denoise === 0) get().setEdit({ denoise: 60 })
      } catch {
        set((s) => ({ denoiseProxy: { ...s.denoiseProxy, status: 'error', message: 'Denoise failed.' } }))
      } finally {
        off()
      }
    },
    clearDenoise: () =>
      set({ denoiseProxy: { filePath: null, url: null, status: 'idle', progress: 0, message: null } }),

    histogram: null,
    setHistogram: (h) => set({ histogram: h }),

    showBefore: false,
    setShowBefore: (v) => set({ showBefore: v }),
    splitCompare: false,
    splitPos: 0.5,
    setSplit: (on) => set({ splitCompare: on }),
    setSplitPos: (p) => set({ splitPos: Math.min(1, Math.max(0, p)) }),

    exportOpen: false,
    setExportOpen: (v) => set({ exportOpen: v }),

    presets: [],
    loadPresets: async () => {
      if (!window.luxinus) return
      const presets = await window.luxinus.presets.list().catch(() => [])
      set({ presets })
    },
    savePreset: async (name) => {
      if (!window.luxinus) return
      // Capture the current edit sans geometry (handled by main-side default).
      const edit = { ...get().edit, crop: null, rotate: 0, flipH: false, flipV: false }
      const preset = await window.luxinus.presets.save(name, edit)
      set((s) => ({ presets: [...s.presets, preset].sort((a, b) => a.name.localeCompare(b.name)) }))
    },
    deletePreset: async (id) => {
      if (!window.luxinus) return
      await window.luxinus.presets.delete(id)
      set((s) => ({ presets: s.presets.filter((p) => p.id !== id) }))
    },
    applyPresetToCurrent: (preset) => {
      const next = applyPreset(get().edit, preset)
      commitEdit(next)
    }
  }
})

// Turn a raw decoder error into one plain sentence: cause + fix.
function friendlyDecodeError(raw: string): string {
  if (/no pixels|decode|unsupported|format/i.test(raw)) {
    return "This file couldn't be decoded — it may be an unsupported RAW variant. Try another photo."
  }
  return "This photo couldn't be opened. The file may be missing or unreadable."
}

// Derived selector: apply the active filter (filename, extension, rating, flag).
export function selectFilteredPhotos(s: LuxinusState): PhotoVM[] {
  const { text, ext, minRating, flaggedOnly } = s.filter
  const needle = text.trim().toLowerCase()
  return s.photos.filter((p) => {
    if (needle && !p.fileName.toLowerCase().includes(needle)) return false
    if (ext !== 'all' && p.ext !== ext) return false
    if (minRating > 0 && p.rating < minRating) return false
    if (flaggedOnly && !p.flagged) return false
    return true
  })
}
