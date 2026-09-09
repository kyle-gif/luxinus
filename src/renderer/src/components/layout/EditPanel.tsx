import { useEffect, useState } from 'react'
import { useStore } from '../../store/useStore'
import { Button } from '../ui/Button'
import { Slider } from '../ui/Slider'
import { Histogram } from '../ui/Histogram'
import { ToneCurve } from '../ui/ToneCurve'
import { HslMixer } from '../ui/HslMixer'
import { ColorGradePanel } from '../ui/ColorGradePanel'
import { MasksPanel } from '../ui/MasksPanel'
import { PresetsPanel } from '../ui/PresetsPanel'
import { HistoryPanel } from '../ui/HistoryPanel'
import { ResizeHandle } from '../ui/ResizeHandle'
import { autoEnhance, computeAutoEnhance } from '../../lib/autoEnhance'
import type { EditState } from '../../types'

// RIGHT edit panel. Simple mode: Auto Enhance + 4 large controls. Expert mode:
// the full develop stack in collapsible sections, all driving the WebGL preview.
export function EditPanel(): JSX.Element {
  const mode = useStore((s) => s.mode)
  const hasPhoto = useStore((s) => s.selectedPath !== null)
  const edit = useStore((s) => s.edit)
  const setEdit = useStore((s) => s.setEdit)
  const resetEdit = useStore((s) => s.resetEdit)
  const undo = useStore((s) => s.undo)
  const redo = useStore((s) => s.redo)
  const canUndo = useStore((s) => s.undoStack.length > 0)
  const canRedo = useStore((s) => s.redoStack.length > 0)
  const maskMode = useStore((s) => s.maskMode)
  const setMaskMode = useStore((s) => s.setMaskMode)
  const panelWidth = useStore((s) => s.panelWidth)
  const setPanelWidth = useStore((s) => s.setPanelWidth)

  const set = (key: keyof EditState) => (v: number) => setEdit({ [key]: v })
  const title = maskMode ? 'Masking' : mode === 'simple' ? 'Adjust' : 'Develop'

  return (
    <aside
      className="lx-glass lx-fade-in absolute bottom-0 right-0 top-12 z-20 flex flex-col rounded-none border-y-0 border-r-0"
      style={{ width: panelWidth, animationDelay: '90ms' }}
    >
      <ResizeHandle
        side="left"
        compute={(x) => (isNaN(x) ? 320 : window.innerWidth - x)}
        onResize={setPanelWidth}
      />
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="lx-display text-[13px] font-semibold text-ink">{title}</span>
        <div className="flex items-center gap-1">
          {maskMode ? (
            <button
              onClick={() => setMaskMode(false)}
              className="rounded-control border border-accent/60 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent-soft transition-colors hover:bg-accent/[0.16]"
            >
              Done
            </button>
          ) : (
            <>
              <HeaderIconButton label="Undo (⌘Z)" disabled={!canUndo} onClick={undo}>
                <path d="M4 7h6.5a3.5 3.5 0 0 1 0 7H6" />
                <path d="M6.5 4.5L4 7l2.5 2.5" />
              </HeaderIconButton>
              <HeaderIconButton label="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo}>
                <path d="M14 7H7.5a3.5 3.5 0 0 0 0 7H12" />
                <path d="M11.5 4.5L14 7l-2.5 2.5" />
              </HeaderIconButton>
              <span className="mx-0.5 h-3.5 w-px bg-white/10" />
              <button
                onClick={resetEdit}
                disabled={!hasPhoto}
                className="text-[11px] text-muted transition-colors hover:text-accent-soft disabled:opacity-40"
              >
                Reset
              </button>
            </>
          )}
        </div>
      </div>
      <div className="lx-rule mx-4 mt-2" />

      {!hasPhoto ? (
        <p className="p-8 text-center text-[12px] leading-relaxed text-faint">
          Select a photo to begin editing.
        </p>
      ) : maskMode ? (
        <div key="mask" className="lx-fade-in min-h-0 flex-1 overflow-y-auto p-3">
          <MasksPanel />
        </div>
      ) : (
        <div key="develop" className="lx-fade-in min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
          <Histogram />
          {mode === 'expert' && <ToolStrip />}
          {mode === 'simple' ? <SimpleControls /> : <ExpertControls set={set} edit={edit} />}
        </div>
      )}
    </aside>
  )
}

// Lightroom-style tool strip: dedicated Crop and Masking workspaces.
function ToolStrip(): JSX.Element {
  const setCropMode = useStore((s) => s.setCropMode)
  const setMaskMode = useStore((s) => s.setMaskMode)
  const cropMode = useStore((s) => s.cropMode)
  const maskCount = useStore((s) => s.edit.masks.length)
  return (
    <div className="grid grid-cols-2 gap-2">
      <ToolButton
        active={cropMode}
        onClick={() => setCropMode(!cropMode)}
        label="Crop"
        badge={null}
      >
        <path d="M4.5 1v10.5H15" />
        <path d="M1 4.5h10.5V15" />
      </ToolButton>
      <ToolButton active={false} onClick={() => setMaskMode(true)} label="Masking" badge={maskCount || null}>
        <circle cx="6" cy="7" r="4" />
        <circle cx="10.5" cy="9.5" r="4" opacity="0.55" />
      </ToolButton>
    </div>
  )
}

function ToolButton({
  active,
  onClick,
  label,
  badge,
  children
}: {
  active: boolean
  onClick: () => void
  label: string
  badge: number | null
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`relative flex items-center justify-center gap-2 rounded-xl border py-2.5 text-[12px] transition-colors ${
        active
          ? 'border-accent/60 bg-accent/10 text-accent-soft'
          : 'border-glass bg-white/[0.02] text-muted hover:border-accent/40 hover:text-ink'
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
      {label}
      {badge != null && (
        <span className="lx-num absolute right-1.5 top-1.5 rounded-full bg-accent/20 px-1.5 text-[9px] text-accent-soft">
          {badge}
        </span>
      )}
    </button>
  )
}

function SimpleControls(): JSX.Element {
  const edit = useStore((s) => s.edit)
  const setEdit = useStore((s) => s.setEdit)
  const applyEdit = useStore((s) => s.applyEdit)
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const proxyUrl = useStore((s) => (s.proxy.status === 'ready' ? s.proxy.url : null))
  const set = (key: keyof EditState) => (v: number) => setEdit({ [key]: v })

  function runAutoEnhance(): void {
    const meta = photo?.meta ?? null
    if (proxyUrl) {
      computeAutoEnhance(proxyUrl, edit, meta).then(applyEdit)
    } else {
      applyEdit(autoEnhance(edit, meta))
    }
  }

  return (
    <>
      <Button variant="primary" className="w-full justify-center" onClick={runAutoEnhance}>
        Auto Enhance
      </Button>
      <div className="space-y-5 pt-1">
        <Slider label="Brightness" size="lg" value={edit.exposure} onChange={set('exposure')} />
        <Slider label="Contrast" size="lg" value={edit.contrast} onChange={set('contrast')} />
        <Slider label="Color" size="lg" value={edit.saturation} onChange={set('saturation')} />
        <DenoiseControl edit={edit} set={set} />
      </div>
      <div className="space-y-3 pt-1">
        <div className="flex items-center gap-2">
          <span className="h-3 w-[2px] rounded-full bg-accent" />
          <span className="lx-eyebrow">Presets</span>
          <span className="lx-rule flex-1" />
        </div>
        <PresetsPanel />
      </div>
    </>
  )
}

function ExpertControls({
  set,
  edit
}: {
  set: (key: keyof EditState) => (v: number) => void
  edit: EditState
}): JSX.Element {
  return (
    <>
      <Section title="Light" defaultOpen>
        <Slider label="Exposure" value={edit.exposure} onChange={set('exposure')} />
        <Slider label="Contrast" value={edit.contrast} onChange={set('contrast')} />
        <Slider label="Highlights" value={edit.highlights} onChange={set('highlights')} />
        <Slider label="Shadows" value={edit.shadows} onChange={set('shadows')} />
        <Slider label="Whites" value={edit.whites} onChange={set('whites')} />
        <Slider label="Blacks" value={edit.blacks} onChange={set('blacks')} />
      </Section>

      <Section title="Tone Curve">
        <ToneCurve />
      </Section>

      <Section title="Color" defaultOpen>
        <WbPicker />
        <Slider label="Temperature" gradient="temp" value={edit.temperature} onChange={set('temperature')} />
        <Slider label="Tint" gradient="tint" value={edit.tint} onChange={set('tint')} />
        <Slider label="Saturation" gradient="sat" value={edit.saturation} onChange={set('saturation')} />
        <Slider label="Vibrance" value={edit.vibrance} onChange={set('vibrance')} />
      </Section>

      <Section title="Color Mixer">
        <HslMixer />
      </Section>

      <Section title="Color Grading">
        <ColorGradePanel />
      </Section>

      <Section title="Detail">
        <Slider label="Texture" value={edit.texture} onChange={set('texture')} />
        <Slider label="Clarity" value={edit.clarity} onChange={set('clarity')} />
        <Slider label="Dehaze" value={edit.dehaze} onChange={set('dehaze')} />
        <Slider label="Sharpening" min={0} max={100} value={edit.sharpening} onChange={set('sharpening')} />
        <DenoiseControl edit={edit} set={set} />
      </Section>

      <Section title="Effects">
        <Slider label="Vignette" value={edit.vignette} onChange={set('vignette')} />
        <Slider label="Grain" min={0} max={100} value={edit.grain} onChange={set('grain')} />
      </Section>

      <Section title="Geometry">
        <GeometryControls edit={edit} />
      </Section>

      <Section title="Presets" defaultOpen>
        <PresetsPanel />
      </Section>

      <Section title="Snapshots & History">
        <HistoryPanel />
      </Section>
    </>
  )
}

// AI denoise: the strength slider blends a restored copy of the source (computed
// on demand — inference is slow, so it runs behind a progress bar).
function DenoiseControl({
  edit,
  set
}: {
  edit: EditState
  set: (key: keyof EditState) => (v: number) => void
}): JSX.Element {
  const dp = useStore((s) => s.denoiseProxy)
  const selectedPath = useStore((s) => s.selectedPath)
  const runDenoise = useStore((s) => s.runDenoise)
  const ready = dp.status === 'ready' && dp.filePath === selectedPath
  const running = dp.status === 'running'

  return (
    <div className="space-y-2.5">
      <Slider label="Denoise (AI)" min={0} max={100} value={edit.denoise} onChange={set('denoise')} />
      {running ? (
        <div className="space-y-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(dp.progress * 100)}%` }} />
          </div>
          <p className="lx-num text-center text-[10px] text-muted">Denoising… {Math.round(dp.progress * 100)}%</p>
        </div>
      ) : (
        <button
          onClick={() => void runDenoise()}
          className="flex w-full items-center justify-center gap-1.5 rounded-control border border-accent/40 bg-accent/[0.06] py-1.5 text-[11px] text-accent-soft transition-colors hover:bg-accent/[0.12]"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.6 4.2L14 6.4l-3.3 3 .9 4.6L8 11.8 4.4 14l.9-4.6L2 6.4l4.4-1.2z" /></svg>
          {ready ? 'Re-run denoise' : 'Run AI denoise'}
        </button>
      )}
      {dp.status === 'error' && <p className="text-center text-[10px] text-faint">{dp.message}</p>}
      {!ready && !running && edit.denoise > 0 && (
        <p className="text-center text-[10px] text-faint">Run denoise to apply it.</p>
      )}
    </div>
  )
}

// White-balance eyedropper: toggles a pick mode; click a neutral area on the
// photo to auto-set Temperature + Tint.
function WbPicker(): JSX.Element {
  const wbPicking = useStore((s) => s.wbPicking)
  const setWbPicking = useStore((s) => s.setWbPicking)
  return (
    <button
      onClick={() => setWbPicking(!wbPicking)}
      className={`flex w-full items-center justify-center gap-2 rounded-control border py-1.5 text-[11px] transition-colors ${
        wbPicking
          ? 'border-accent/60 bg-accent/10 text-accent-soft'
          : 'border-glass text-muted hover:text-ink'
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 2.5 13.5 5.5M12 4 6.5 9.5 4 12l-1.5.5L3 11l2.5-2.5L11 3" />
        <path d="M2.5 13.5 4 12" />
      </svg>
      {wbPicking ? 'Click a neutral area…' : 'White balance picker'}
    </button>
  )
}

function HeaderIconButton({
  label,
  disabled,
  onClick,
  children
}: {
  label: string
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="rounded-md p-1 text-muted transition-colors hover:bg-white/5 hover:text-ink disabled:pointer-events-none disabled:opacity-30"
    >
      <svg width="16" height="16" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  )
}

function GeometryControls({ edit }: { edit: EditState }): JSX.Element {
  const setEdit = useStore((s) => s.setEdit)
  return (
    <div className="space-y-3.5">
      <Slider
        label="Straighten"
        min={-45}
        max={45}
        value={Math.round(edit.rotate)}
        onChange={(v) => setEdit({ rotate: v })}
        onDragChange={(d) => useStore.getState().setStraightening(d)}
      />
      <div className="flex gap-2">
        <GeoButton active={edit.flipH} onClick={() => setEdit({ flipH: !edit.flipH })}>
          Flip H
        </GeoButton>
        <GeoButton active={edit.flipV} onClick={() => setEdit({ flipV: !edit.flipV })}>
          Flip V
        </GeoButton>
        <GeoButton active={false} onClick={() => setEdit({ rotate: 0, flipH: false, flipV: false })}>
          Reset
        </GeoButton>
      </div>
    </div>
  )
}

function GeoButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-control border px-2 py-1.5 text-[11px] transition-colors ${
        active
          ? 'border-accent/60 bg-accent/10 text-accent-soft'
          : 'border-glass text-muted hover:text-ink'
      }`}
    >
      {children}
    </button>
  )
}

function Section({
  title,
  children,
  defaultOpen = false
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  // A collapsed section is only clipped by CSS, so its children stayed mounted
  // and kept working — the tone curve, HSL mixer and preset tiles (each a WebGL
  // render) all ran on first paint and re-ran on every edit, unseen. Mount on
  // first open and keep it mounted so the collapse animation still has content.
  const [mounted, setMounted] = useState(defaultOpen)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  return (
    <section
      className={`overflow-hidden rounded-xl border transition-colors ${
        open ? 'border-glass bg-white/[0.02]' : 'border-transparent'
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          className={`w-[3px] rounded-full bg-accent transition-all ${open ? 'h-4' : 'h-3 opacity-70'}`}
        />
        <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted transition-colors group-hover:text-ink">
          {title}
        </span>
        <span className="lx-rule flex-1" />
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`text-faint transition-transform duration-300 ${open ? 'rotate-90' : ''}`}
          fill="none"
        >
          <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Smooth collapse: 0fr → 1fr grid rows animates height without a fixed max. */}
      <div
        className="grid transition-[grid-template-rows] duration-300 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden">
          <div className="space-y-4 px-3 pb-4 pt-0.5">{mounted ? children : null}</div>
        </div>
      </div>
    </section>
  )
}
