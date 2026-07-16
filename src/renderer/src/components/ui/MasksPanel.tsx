import { useStore } from '../../store/useStore'
import { MASK_ADJUST_KEYS, type Mask, type MaskKind } from '../../../../shared/edits'
import { Slider } from './Slider'

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
  brush: <path d="M11.5 3.2 6 8.7m-1.2 3.9c1.2.3 2.6-.2 3-1.6.3-1.2-.6-2-1.6-2-1.2 0-2 1-1.9 2.3.1.9-.3 1.2-.9 1.4.5.1 1 .1 1.4-.1Z" />
}
const KIND_HINT: Record<MaskKind, string> = { radial: 'Ellipse', linear: 'Gradient', brush: 'Paint' }

const ADJUST_META: { key: (typeof MASK_ADJUST_KEYS)[number]; label: string; gradient?: 'temp' | 'tint' | 'sat' }[] = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'whites', label: 'Whites' },
  { key: 'blacks', label: 'Blacks' },
  { key: 'temperature', label: 'Temperature', gradient: 'temp' },
  { key: 'tint', label: 'Tint', gradient: 'tint' },
  { key: 'saturation', label: 'Saturation', gradient: 'sat' },
  { key: 'clarity', label: 'Clarity' }
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
  const selectMask = useStore((s) => s.selectMask)
  const removeMask = useStore((s) => s.removeMask)
  const updateMask = useStore((s) => s.updateMask)
  const showOverlay = useStore((s) => s.showMaskOverlay)
  const setShowOverlay = useStore((s) => s.setShowMaskOverlay)

  const selected = masks.find((m) => m.id === selectedId) ?? null

  return (
    <div className="space-y-3">
      {/* Add a mask — big, labelled cards. */}
      <div className="grid grid-cols-3 gap-2">
        {(['radial', 'linear', 'brush'] as MaskKind[]).map((k) => (
          <button
            key={k}
            onClick={() => addMask(k)}
            className="flex flex-col items-center gap-1.5 rounded-xl border border-glass bg-white/[0.02] py-2.5 text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <KindGlyph kind={k} />
            <span className="text-[11px] font-medium capitalize text-ink">{k}</span>
            <span className="text-[9px] text-faint">{KIND_HINT[k]}</span>
          </button>
        ))}
      </div>

      {masks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="lx-eyebrow">Masks · {masks.length}</span>
            <button
              onClick={() => setShowOverlay(!showOverlay)}
              title={showOverlay ? 'Hide coverage overlay' : 'Show coverage overlay'}
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

      {ADJUST_META.map((a) => (
        <Slider
          key={a.key}
          label={a.label}
          gradient={a.gradient}
          value={mask.adjust[a.key]}
          onChange={(v) => updateMaskAdjust(mask.id, { [a.key]: v })}
          onDragChange={setSuppress}
        />
      ))}
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
