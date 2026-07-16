import { useEffect, useState } from 'react'
import { useStore } from '../../store/useStore'
import { renderPresetThumb, setPresetSource } from '../../lib/presetThumb'
import type { Preset, XmpImportResult } from '../../../../shared/presets'

// Presets: a grid of tiles, each a live thumbnail of the current photo with that
// preset applied (rendered through the shared edit shader). Save the current
// look, apply/delete presets, or import a Lightroom .xmp (with a mapping summary).
export function PresetsPanel(): JSX.Element {
  const presets = useStore((s) => s.presets)
  const proxyUrl = useStore((s) => (s.proxy.status === 'ready' ? s.proxy.url : null))
  const selectedPath = useStore((s) => s.selectedPath)
  const apply = useStore((s) => s.applyPresetToCurrent)
  const del = useStore((s) => s.deletePreset)
  const savePreset = useStore((s) => s.savePreset)
  const loadPresets = useStore((s) => s.loadPresets)

  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [summary, setSummary] = useState<XmpImportResult | null>(null)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    void loadPresets()
  }, [loadPresets])

  // Upload the current photo into the shared thumb renderer, then render tiles.
  useEffect(() => {
    if (!proxyUrl || !selectedPath) return
    let cancelled = false
    setPresetSource(selectedPath, proxyUrl).then(() => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const p of presets) {
        const url = renderPresetThumb(p.edits, p.id)
        if (url) next[p.id] = url
      }
      setThumbs(next)
    })
    return () => {
      cancelled = true
    }
  }, [proxyUrl, selectedPath, presets])

  async function doSave(): Promise<void> {
    if (!name.trim()) return
    await savePreset(name.trim())
    setName('')
    setNaming(false)
  }

  async function doImport(): Promise<void> {
    if (!window.luxinus) return
    setImporting(true)
    try {
      const res = await window.luxinus.presets.importXmp()
      if (res) {
        await loadPresets()
        setSummary(res)
      }
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        {naming ? (
          <div className="flex flex-1 gap-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSave()
                if (e.key === 'Escape') setNaming(false)
              }}
              placeholder="Preset name…"
              className="flex-1 rounded-control border border-glass bg-black/25 px-2.5 py-1.5 text-[12px] text-ink focus:border-accent/60"
            />
            <button onClick={doSave} className="rounded-control border border-accent/60 bg-accent/10 px-2.5 text-[11px] text-accent-soft">
              Save
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => setNaming(true)}
              className="flex-1 rounded-control border border-glass px-2.5 py-1.5 text-[11px] text-muted hover:text-ink"
            >
              + Save current
            </button>
            <button
              onClick={doImport}
              disabled={importing}
              className="rounded-control border border-glass px-2.5 py-1.5 text-[11px] text-muted hover:text-ink disabled:opacity-50"
            >
              {importing ? 'Importing…' : 'Import .xmp'}
            </button>
          </>
        )}
      </div>

      {presets.length === 0 ? (
        <p className="py-2 text-center text-[11px] text-faint">
          No presets yet. Save a look or import a Lightroom .xmp.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {presets.map((p) => (
            <PresetTile key={p.id} preset={p} thumb={thumbs[p.id]} onApply={() => apply(p)} onDelete={() => del(p.id)} />
          ))}
        </div>
      )}

      {summary && <ImportSummary result={summary} onClose={() => setSummary(null)} onApply={() => {
        const p = useStore.getState().presets.find((x) => x.name === summary.name)
        if (p) apply(p)
        setSummary(null)
      }} />}
    </div>
  )
}

function PresetTile({
  preset,
  thumb,
  onApply,
  onDelete
}: {
  preset: Preset
  thumb: string | undefined
  onApply: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className="group relative">
      <button
        onClick={onApply}
        title={`Apply ${preset.name}`}
        className="block aspect-square w-full overflow-hidden rounded-md border border-glass transition-colors hover:border-accent/70"
      >
        {thumb ? (
          <img src={thumb} alt={preset.name} className="h-full w-full object-cover" />
        ) : (
          <div className="h-full w-full bg-black/40" />
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 to-transparent px-1 pb-0.5 pt-2 text-center text-[8px] text-ink">
        {preset.name}
        {preset.origin === 'xmp' && <span className="text-accent-soft"> ·xmp</span>}
      </div>
      <button
        onClick={onDelete}
        title="Delete preset"
        className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-white/30 bg-black/80 text-[9px] text-muted group-hover:flex hover:text-accent-soft"
      >
        ✕
      </button>
    </div>
  )
}

// Import summary: what mapped (with values), what isn't supported, and the
// honesty notice — a polished modal.
function ImportSummary({
  result,
  onClose,
  onApply
}: {
  result: XmpImportResult
  onClose: () => void
  onApply: () => void
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        className="lx-glass w-[460px] max-w-[92vw] overflow-hidden rounded-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <span className="lx-eyebrow">Lightroom preset imported</span>
            <h3 className="lx-display mt-1 text-[18px] font-semibold leading-tight text-ink">
              {result.name}
            </h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-full p-1 text-muted transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>

        {/* Honesty notice */}
        <div className="mx-5 mt-4 flex gap-2.5 rounded-control border border-accent/25 bg-accent/[0.05] px-3 py-2.5">
          <span className="mt-px text-[12px] text-accent-soft">≈</span>
          <p className="text-[11px] leading-snug text-muted">
            <span className="text-ink">Approximate mapping.</span> Luxinus and Adobe render
            differently, so the look may not match exactly.
          </p>
        </div>

        <div className="max-h-[42vh] space-y-4 overflow-y-auto px-5 py-4">
          {/* Mapped */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <span className="h-3 w-[2px] rounded-full bg-accent" />
              <span className="lx-eyebrow">Applied · {result.mapped.length}</span>
            </div>
            {result.mapped.length ? (
              <div className="flex flex-wrap gap-1.5">
                {result.mapped.map((m) => (
                  <span
                    key={m}
                    className="lx-num rounded-md border border-glass bg-white/[0.03] px-2 py-1 text-[10px] text-ink"
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-faint">No recognizable adjustments in this file.</p>
            )}
          </section>

          {/* Ignored */}
          {result.ignored.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-3 w-[2px] rounded-full bg-white/20" />
                <span className="lx-eyebrow">Not supported · {result.ignored.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.ignored.map((m) => (
                  <span
                    key={m}
                    className="lx-num rounded-md px-1.5 py-0.5 text-[10px] text-faint line-through decoration-white/20"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-glass px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-control px-3.5 py-2 text-[12px] text-muted transition-colors hover:text-ink"
          >
            Keep as preset
          </button>
          <button
            onClick={onApply}
            className="rounded-control border border-accent/60 bg-accent/10 px-4 py-2 text-[12px] font-medium text-accent-soft transition-colors hover:bg-accent/[0.16]"
          >
            Apply now
          </button>
        </div>
      </div>
    </div>
  )
}
