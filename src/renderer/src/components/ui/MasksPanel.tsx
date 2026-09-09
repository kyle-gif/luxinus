import { useState } from 'react'
import { useStore } from '../../store/useStore'
import { MASK_ADJUST_KEYS, type Mask, type MaskKind } from '../../../../shared/edits'
import { Slider } from './Slider'
import { RangeSlider } from './RangeSlider'

// The Masking panel. Intuition-first: big labelled type cards to add a mask, a
// live red coverage overlay you can toggle, a clear list, and a focused editor
// for the selected mask. The interactive geometry lives on the stage.

const KIND_ICON: Record<MaskKind, JSX.Element> = {
  radial: <circle cx="8" cy="8" r="5.5" />,
  linear: (
    <>
      <path d="M2 5h12" />
      <path d="M2 8h12" opacity="0.55" />
      <path d="M2 11h12" opacity="0.25" />
    </>
  ),
  brush: <path d="M11.5 3.2 6 8.7m-1.2 3.9c1.2.3 2.6-.2 3-1.6.3-1.2-.6-2-1.6-2-1.2 0-2 1-1.9 2.3.1.9-.3 1.2-.9 1.4.5.1 1 .1 1.4-.1Z" />,
  lumRange: (
    // A tonal ramp with a selected band — "pick a luminance range".
    <>
      <path d="M2 12.5c2.2 0 2.6-9 5-9s2.8 9 7 9" />
      <path d="M6.2 3.5v9M9.8 3.5v9" opacity="0.45" />
    </>
  ),
  colorRange: (
    // An eyedropper over a swatch — "sample a color".
    <>
      <path d="M10.5 2.5 13.5 5.5M12 4 6.5 9.5 4 12l-1.5.5L3 11l2.5-2.5L11 3" />
      <circle cx="12" cy="12.5" r="1.6" opacity="0.55" />
    </>
  )
}
const KIND_HINT: Record<MaskKind, string> = {
  radial: 'Ellipse',
  linear: 'Gradient',
  brush: 'Paint',
  lumRange: 'Tones',
  colorRange: 'Sample'
}
const KIND_LABEL: Record<MaskKind, string> = {
  radial: 'Radial',
  linear: 'Linear',
  brush: 'Brush',
  lumRange: 'Luminance',
  colorRange: 'Color'
}

const ADJUST_META: {
  key: (typeof MASK_ADJUST_KEYS)[number]
  label: string
  gradient?: 'temp' | 'tint' | 'sat'
  min?: number
  max?: number
}[] = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'whites', label: 'Whites' },
  { key: 'blacks', label: 'Blacks' },
  { key: 'temperature', label: 'Temperature', gradient: 'temp' },
  { key: 'tint', label: 'Tint', gradient: 'tint' },
  { key: 'saturation', label: 'Saturation', gradient: 'sat' },
  { key: 'clarity', label: 'Clarity' },
  { key: 'dehaze', label: 'Dehaze' },
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100 }
]

function KindGlyph({ kind, className }: { kind: MaskKind; className?: string }): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {KIND_ICON[kind]}
    </svg>
  )
}

export function MasksPanel(): JSX.Element {
  const masks = useStore((s) => s.edit.masks)
  const selectedId = useStore((s) => s.selectedMaskId)
  const addMask = useStore((s) => s.addMask)
  const addQuickMask = useStore((s) => s.addQuickMask)
  const selectMask = useStore((s) => s.selectMask)
  const removeMask = useStore((s) => s.removeMask)
  const updateMask = useStore((s) => s.updateMask)
  const showOverlay = useStore((s) => s.showMaskOverlay)
  const setShowOverlay = useStore((s) => s.setShowMaskOverlay)
  const overlayMode = useStore((s) => s.maskOverlayMode)
  const cycleOverlayMode = useStore((s) => s.cycleMaskOverlayMode)

  const selected = masks.find((m) => m.id === selectedId) ?? null

  return (
    <div className="space-y-3">
      {/* Add a mask — big, labelled cards. */}
      <div className="grid grid-cols-2 gap-2">
        {(['lumRange', 'colorRange', 'radial', 'linear', 'brush'] as MaskKind[]).map((k) => (
          <button
            key={k}
            onClick={() => addMask(k)}
            className={`flex flex-col items-center gap-1.5 rounded-xl border border-glass bg-white/[0.02] py-2.5 text-muted transition-colors hover:border-accent/50 hover:text-ink ${
              k === 'brush' ? 'col-span-2' : ''
            }`}
          >
            <KindGlyph kind={k} />
            <span className="text-[11px] font-medium text-ink">{KIND_LABEL[k]}</span>
            <span className="text-[9px] text-faint">{KIND_HINT[k]}</span>
          </button>
        ))}
      </div>

      {/* One-click dynamic-range selections — pre-aimed luminance ranges. */}
      <div className="space-y-1.5">
        <span className="lx-eyebrow px-0.5">Quick select</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => addQuickMask('blown')}
            className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[10.5px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <span className="h-2 w-2 rounded-full border border-white/40 bg-white" />
            Blown highlights
          </button>
          <button
            onClick={() => addQuickMask('crushed')}
            className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[10.5px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <span className="h-2 w-2 rounded-full border border-white/40 bg-black" />
            Crushed shadows
          </button>
        </div>
      </div>

      {masks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="lx-eyebrow">Masks · {masks.length}</span>
            <div className="flex items-center gap-2">
              {showOverlay && (
                <button
                  onClick={cycleOverlayMode}
                  title="Cycle overlay rendering (Shift+O)"
                  className="lx-num rounded border border-glass px-1.5 py-0.5 text-[9px] text-muted transition-colors hover:border-accent/40 hover:text-ink"
                >
                  {overlayMode === 0 ? 'red' : overlayMode === 1 ? 'w/b' : 'b/w'}
                </button>
              )}
              <button
                onClick={() => setShowOverlay(!showOverlay)}
                title={showOverlay ? 'Hide coverage overlay (O)' : 'Show coverage overlay (O)'}
                className={`flex items-center gap-1 text-[10px] transition-colors ${showOverlay ? 'text-accent-soft' : 'text-faint hover:text-muted'}`}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="8" cy="8" r="1.9" />
                  {!showOverlay && <path d="M3 13 13 3" strokeLinecap="round" />}
                </svg>
                Overlay
              </button>
            </div>
          </div>
          {masks.map((m) => (
            <MaskRow
              key={m.id}
              mask={m}
              selected={m.id === selectedId}
              onSelect={() => selectMask(m.id === selectedId ? null : m.id)}
              onToggle={() => updateMask(m.id, { enabled: !m.enabled })}
              onDelete={() => removeMask(m.id)}
            />
          ))}
        </div>
      )}

      {selected && <MaskEditor key={selected.id} mask={selected} />}
    </div>
  )
}

function MaskRow({
  mask,
  selected,
  onSelect,
  onToggle,
  onDelete
}: {
  mask: Mask
  selected: boolean
  onSelect: () => void
  onToggle: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div
      className={`group flex items-center gap-2 rounded-control border px-2.5 py-2 transition-colors ${
        selected ? 'border-accent/50 bg-accent/[0.07]' : 'border-glass hover:border-white/15'
      }`}
    >
      <button onClick={onSelect} className="flex flex-1 items-center gap-2.5 text-left">
        <KindGlyph kind={mask.kind} className={selected ? 'text-accent-soft' : 'text-muted'} />
        <span className={`text-[12px] ${selected ? 'text-ink' : 'text-muted'}`}>{mask.name}</span>
      </button>
      <button
        onClick={onToggle}
        title={mask.enabled ? 'Hide mask' : 'Show mask'}
        className={`text-[12px] transition-colors ${mask.enabled ? 'text-muted hover:text-ink' : 'text-faint hover:text-muted'}`}
      >
        {mask.enabled ? '◉' : '○'}
      </button>
      <button
        onClick={onDelete}
        title="Delete mask"
        className="text-[11px] text-faint opacity-0 transition-opacity hover:text-accent-soft group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )
}

function MaskEditor({ mask }: { mask: Mask }): JSX.Element {
  const updateMaskAdjust = useStore((s) => s.updateMaskAdjust)
  const updateMask = useStore((s) => s.updateMask)
  const setSuppress = useStore((s) => s.setSuppressMaskOverlay)
  return (
    <div className="lx-fade-in space-y-3.5 rounded-xl border border-accent/25 bg-accent/[0.03] p-3">
      <div className="flex items-center gap-2">
        <KindGlyph kind={mask.kind} className="text-accent-soft" />
        <span className="text-[12px] font-medium text-ink">{mask.name}</span>
        <span className="lx-rule flex-1" />
        <span className="text-[9px] uppercase tracking-wider text-faint">Editing</span>
      </div>

      {mask.kind === 'brush' && <BrushControls mask={mask} />}
      {mask.kind === 'radial' && mask.radial && (
        <div className="space-y-3">
          <Slider
            label="Feather"
            min={0}
            max={100}
            value={Math.round(mask.radial.feather * 100)}
            onChange={(v) => updateMask(mask.id, { radial: { ...mask.radial!, feather: v / 100 } })}
          />
          <button
            onClick={() => updateMask(mask.id, { radial: { ...mask.radial!, invert: !mask.radial!.invert } })}
            className={`w-full rounded-control border py-1.5 text-[11px] transition-colors ${
              mask.radial.invert ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
            }`}
          >
            {mask.radial.invert ? 'Inverted (outside)' : 'Invert mask'}
          </button>
          <div className="lx-rule" />
        </div>
      )}

      {mask.kind === 'lumRange' && mask.lum && (
        <>
          <LumControls lum={mask.lum} onChange={(lum) => updateMask(mask.id, { lum })} />
          <div className="lx-rule" />
        </>
      )}

      {mask.kind === 'colorRange' && mask.color && (
        <>
          <ColorControls color={mask.color} onChange={(color) => updateMask(mask.id, { color })} />
          <div className="lx-rule" />
        </>
      )}

      <RefineSection mask={mask} />

      {/* Density = the mask's max opacity. Overlay stays live so you can see it. */}
      <Slider
        label="Density"
        min={0}
        max={100}
        value={Math.round((mask.density ?? 1) * 100)}
        onChange={(v) => updateMask(mask.id, { density: v / 100 })}
      />
      <div className="lx-rule" />

      {ADJUST_META.map((a) => (
        <Slider
          key={a.key}
          label={a.label}
          gradient={a.gradient}
          min={a.min}
          max={a.max}
          value={mask.adjust[a.key] ?? 0}
          onChange={(v) => updateMaskAdjust(mask.id, { [a.key]: v })}
          onDragChange={setSuppress}
        />
      ))}
    </div>
  )
}

// Luminance-range controls, shared by primary masks and refinements. The
// overlay intentionally stays LIVE while these drag (no suppress) — watching
// coverage move is how you aim a range mask.
function LumControls({
  lum,
  onChange
}: {
  lum: NonNullable<Mask['lum']>
  onChange: (lum: NonNullable<Mask['lum']>) => void
}): JSX.Element {
  return (
    <div className="space-y-3">
      <RangeSlider
        label="Range"
        track="lum"
        lo={Math.round(lum.lo * 100)}
        hi={Math.round(lum.hi * 100)}
        onChange={(lo, hi) => onChange({ ...lum, lo: lo / 100, hi: hi / 100 })}
      />
      <Slider
        label="Falloff below"
        min={0}
        max={50}
        value={Math.round(lum.featherLo * 100)}
        onChange={(v) => onChange({ ...lum, featherLo: v / 100 })}
      />
      <Slider
        label="Falloff above"
        min={0}
        max={50}
        value={Math.round(lum.featherHi * 100)}
        onChange={(v) => onChange({ ...lum, featherHi: v / 100 })}
      />
    </div>
  )
}

// Color-range controls, shared by primary masks and refinements. The eyedropper
// routing (primary vs. selected refinement) lives in the store.
function ColorControls({
  color,
  onChange
}: {
  color: NonNullable<Mask['color']>
  onChange: (color: NonNullable<Mask['color']>) => void
}): JSX.Element {
  const colorPicking = useStore((s) => s.colorPicking)
  const setColorPicking = useStore((s) => s.setColorPicking)
  const [r, g, b] = color.rgb
  return (
    <div className="space-y-3">
      <button
        onClick={() => setColorPicking(!colorPicking)}
        className={`flex w-full items-center gap-2.5 rounded-control border px-2.5 py-2 text-[11px] transition-colors ${
          colorPicking
            ? 'border-accent/60 bg-accent/10 text-accent-soft'
            : 'border-glass text-muted hover:text-ink'
        }`}
      >
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-white/30"
          style={{ background: `rgb(${r},${g},${b})` }}
        />
        {colorPicking ? 'Click a color on the photo…' : 'Resample color'}
        <span className="lx-num ml-auto text-[9px] text-faint">
          {r},{g},{b}
        </span>
      </button>
      <Slider
        label="Tolerance"
        min={0}
        max={100}
        value={Math.round(color.tolerance * 100)}
        onChange={(v) => onChange({ ...color, tolerance: v / 100 })}
      />
      <Slider
        label="Feather"
        min={0}
        max={100}
        value={Math.round(color.feather * 100)}
        onChange={(v) => onChange({ ...color, feather: v / 100 })}
      />
    </div>
  )
}

const MODE_GLYPH: Record<'add' | 'subtract' | 'intersect', string> = {
  add: '＋',
  subtract: '−',
  intersect: '∩'
}

// Combine further selections onto the mask's primary shape (Lightroom's
// "Add / Subtract / Intersect" refinement model).
function RefineSection({ mask }: { mask: Mask }): JSX.Element {
  const selectedRefineId = useStore((s) => s.selectedRefineId)
  const selectRefine = useStore((s) => s.selectRefine)
  const addRefine = useStore((s) => s.addRefine)
  const updateRefine = useStore((s) => s.updateRefine)
  const removeRefine = useStore((s) => s.removeRefine)
  const [pendingMode, setPendingMode] = useState<'add' | 'subtract' | 'intersect' | null>(null)

  const refinements = mask.refine ?? []
  const selected = refinements.find((r) => r.id === selectedRefineId) ?? null

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-2">
        <span className="lx-eyebrow">Refine</span>
        <span className="lx-rule flex-1" />
        {(['add', 'subtract', 'intersect'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setPendingMode(pendingMode === mode ? null : mode)}
            title={`${mode[0].toUpperCase()}${mode.slice(1)} a selection`}
            className={`lx-num rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
              pendingMode === mode
                ? 'border-accent/60 bg-accent/10 text-accent-soft'
                : 'border-glass text-muted hover:border-accent/40 hover:text-ink'
            }`}
          >
            {MODE_GLYPH[mode]}
          </button>
        ))}
      </div>

      {/* Pick the kind for a pending refinement. */}
      {pendingMode && (
        <div className="lx-fade-in grid grid-cols-2 gap-2">
          {(['lumRange', 'colorRange'] as const).map((k) => (
            <button
              key={k}
              onClick={() => {
                addRefine(mask.id, k, pendingMode)
                setPendingMode(null)
              }}
              className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[10.5px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
            >
              <KindGlyph kind={k} />
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
      )}

      {/* Existing refinements as chips. */}
      {refinements.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {refinements.map((r) => (
            <span
              key={r.id}
              className={`group/chip flex items-center gap-1 rounded-full border py-0.5 pl-1.5 pr-1 text-[10px] transition-colors ${
                r.id === selectedRefineId
                  ? 'border-accent/60 bg-accent/[0.08] text-accent-soft'
                  : 'border-glass text-muted hover:border-white/20'
              }`}
            >
              <button onClick={() => selectRefine(r.id === selectedRefineId ? null : r.id)} className="flex items-center gap-1">
                <span className="lx-num">{MODE_GLYPH[r.mode]}</span>
                <KindGlyph kind={r.kind} className="scale-90" />
                {r.invert && <span className="lx-num text-[8px]">inv</span>}
              </button>
              <button
                onClick={() => removeRefine(mask.id, r.id)}
                title="Remove refinement"
                className="px-0.5 text-faint opacity-0 transition-opacity hover:text-accent-soft group-hover/chip:opacity-100"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Editor for the selected refinement. */}
      {selected && (
        <div className="lx-fade-in space-y-3 rounded-control border border-glass bg-black/20 p-2.5">
          <div className="flex items-center gap-1.5">
            {(['add', 'subtract', 'intersect'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => updateRefine(mask.id, selected.id, { mode })}
                className={`lx-num flex-1 rounded border py-1 text-[10px] transition-colors ${
                  selected.mode === mode
                    ? 'border-accent/60 bg-accent/10 text-accent-soft'
                    : 'border-glass text-muted hover:text-ink'
                }`}
              >
                {MODE_GLYPH[mode]} {mode}
              </button>
            ))}
            <button
              onClick={() => updateRefine(mask.id, selected.id, { invert: !selected.invert })}
              className={`lx-num rounded border px-2 py-1 text-[10px] transition-colors ${
                selected.invert
                  ? 'border-accent/60 bg-accent/10 text-accent-soft'
                  : 'border-glass text-muted hover:text-ink'
              }`}
            >
              inv
            </button>
          </div>
          {selected.kind === 'lumRange' && selected.lum && (
            <LumControls lum={selected.lum} onChange={(lum) => updateRefine(mask.id, selected.id, { lum })} />
          )}
          {selected.kind === 'colorRange' && selected.color && (
            <ColorControls color={selected.color} onChange={(color) => updateRefine(mask.id, selected.id, { color })} />
          )}
        </div>
      )}

      <div className="lx-rule" />
    </div>
  )
}

function BrushControls({ mask }: { mask: Mask }): JSX.Element {
  const brushRadius = useStore((s) => s.brushRadius)
  const brushErase = useStore((s) => s.brushErase)
  const setBrushRadius = useStore((s) => s.setBrushRadius)
  const setBrushErase = useStore((s) => s.setBrushErase)
  const clearBrush = useStore((s) => s.clearBrush)
  const empty = !mask.brush || mask.brush.strokes.length === 0
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-control border border-glass bg-black/20 px-2.5 py-1.5 text-[10px] text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        Paint on the photo to build this mask.
      </div>
      <Slider
        label="Brush size"
        min={1}
        max={40}
        value={Math.round(brushRadius * 200)}
        onChange={(v) => setBrushRadius(v / 200)}
      />
      <div className="flex gap-2">
        <button
          onClick={() => setBrushErase(false)}
          className={`flex-1 rounded-control border py-1.5 text-[11px] transition-colors ${
            !brushErase ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
          }`}
        >
          Paint
        </button>
        <button
          onClick={() => setBrushErase(true)}
          className={`flex-1 rounded-control border py-1.5 text-[11px] transition-colors ${
            brushErase ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
          }`}
        >
          Erase
        </button>
        <button
          onClick={() => clearBrush(mask.id)}
          disabled={empty}
          className="rounded-control border border-glass px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:text-accent-soft disabled:opacity-40"
        >
          Clear
        </button>
      </div>
      <div className="lx-rule" />
    </div>
  )
}
