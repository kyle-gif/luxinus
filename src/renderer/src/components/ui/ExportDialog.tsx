import { useEffect, useState } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { Button } from './Button'
import { Slider } from './Slider'
import {
  DEFAULT_EXPORT_OPTIONS,
  frameFields,
  type ExifMode,
  type ExportFormat,
  type ExportItem,
  type ExportOptions,
  type FrameStyle
} from '../../../../shared/export'

// Export modal: format, quality, resize, filename, EXIF policy (Keep/Strip/Frame),
// frame style + live frame preview, destination, and batch progress.
export function ExportDialog(): JSX.Element | null {
  const open = useStore((s) => s.exportOpen)
  const close = (): void => useStore.getState().setExportOpen(false)
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const edit = useStore((s) => s.edit)
  const proxyUrl = useStore((s) => (s.proxy.status === 'ready' ? s.proxy.url : null))
  const filtered = useStore(selectFilteredPhotos)

  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const [scope, setScope] = useState<'one' | 'all'>('one')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ n: number; errors: number } | null>(null)

  useEffect(() => {
    if (!window.luxinus) return
    return window.luxinus.exportr.onProgress((p) => setProgress({ done: p.done, total: p.total }))
  }, [])

  useEffect(() => {
    if (open) {
      setResult(null)
      setProgress(null)
    }
  }, [open])

  if (!open || !photo) return null
  const set = (patch: Partial<ExportOptions>): void => setOpts((o) => ({ ...o, ...patch }))

  async function pickDir(): Promise<void> {
    const dir = await window.luxinus.exportr.pickDir()
    if (dir) set({ destDir: dir })
  }

  async function run(): Promise<void> {
    if (!opts.destDir || !window.luxinus) return
    const source = scope === 'all' ? filtered : photo ? [photo] : []
    const items: ExportItem[] = source.map((p) => ({
      filePath: p.filePath,
      fileName: p.fileName,
      // Active photo uses the live edit buffer; others load their sidecar in main.
      editState: p.filePath === photo?.filePath ? edit : null,
      meta: p.meta
    }))
    setProgress({ done: 0, total: items.length })
    const res = await window.luxinus.exportr.run(items, opts)
    setResult({ n: res.written.length, errors: res.errors.length })
    setProgress(null)
  }

  const fields = frameFields(photo.meta, photo.fileName)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="lx-glass flex max-h-[86vh] w-[860px] max-w-[94vw] overflow-hidden rounded-panel border-glass">
        {/* Left: live preview */}
        <div className="flex w-[45%] flex-col border-r border-glass bg-black/30 p-5">
          <span className="lx-eyebrow mb-3">Preview</span>
          <div className="flex flex-1 items-center justify-center">
            {opts.exifMode === 'frame' ? (
              <FramePreview url={proxyUrl} style={opts.frameStyle} fields={fields} />
            ) : (
              proxyUrl && (
                <img
                  src={proxyUrl}
                  alt=""
                  className="max-h-full max-w-full rounded-sm object-contain shadow-lg"
                />
              )
            )}
          </div>
        </div>

        {/* Right: options */}
        <div className="flex w-[55%] flex-col">
          <div className="flex items-center justify-between px-5 pt-4">
            <span className="lx-display text-[15px] font-semibold text-ink">Export</span>
            <button onClick={close} className="text-muted hover:text-ink">
              ✕
            </button>
          </div>
          <div className="lx-rule mx-5 mt-2.5" />

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {/* Scope */}
            {filtered.length > 1 && (
              <Field label="Photos">
                <Segmented
                  options={[
                    { v: 'one', label: 'This photo' },
                    { v: 'all', label: `All ${filtered.length}` }
                  ]}
                  value={scope}
                  onChange={(v) => setScope(v as 'one' | 'all')}
                />
              </Field>
            )}

            {/* Format */}
            <Field label="Format">
              <Segmented
                options={[
                  { v: 'jpeg', label: 'JPEG' },
                  { v: 'png', label: 'PNG' },
                  { v: 'tiff', label: 'TIFF' }
                ]}
                value={opts.format}
                onChange={(v) => set({ format: v as ExportFormat })}
              />
            </Field>

            {opts.format === 'jpeg' && (
              <Slider label="Quality" min={1} max={100} value={opts.quality} onChange={(v) => set({ quality: v })} />
            )}

            {/* Resize */}
            <Field label="Resize (long edge)">
              <Segmented
                options={[
                  { v: '0', label: 'Original' },
                  { v: '2048', label: '2048' },
                  { v: '4096', label: '4096' }
                ]}
                value={String(opts.longEdge)}
                onChange={(v) => set({ longEdge: Number(v) })}
              />
            </Field>

            {/* Filename */}
            <Field label="Filename">
              <input
                value={opts.filenamePattern}
                onChange={(e) => set({ filenamePattern: e.target.value })}
                className="w-full rounded-control border border-glass bg-black/25 px-2.5 py-1.5 text-[12px] text-ink focus:border-accent/60"
              />
              <p className="lx-num mt-1 text-[9px] text-faint">tokens: {'{name} {seq} {date} {W} {H}'}</p>
            </Field>

            {/* EXIF */}
            <Field label="Metadata">
              <div className="space-y-1.5">
                {(
                  [
                    ['keep', 'Keep', 'Preserve original EXIF, GPS, and XMP'],
                    ['strip', 'Strip', 'Remove all metadata (EXIF / GPS / XMP)'],
                    ['frame', 'Frame', 'Strip metadata, print shooting info on a border']
                  ] as [ExifMode, string, string][]
                ).map(([v, label, desc]) => (
                  <label
                    key={v}
                    className={`flex cursor-pointer items-start gap-2.5 rounded-control border px-3 py-2 transition-colors ${
                      opts.exifMode === v ? 'border-accent/60 bg-accent/[0.07]' : 'border-glass hover:border-white/20'
                    }`}
                  >
                    <span
                      className={`mt-0.5 h-3 w-3 shrink-0 rounded-full border ${
                        opts.exifMode === v ? 'border-accent bg-accent' : 'border-white/30'
                      }`}
                    />
                    <span>
                      <span className="block text-[12px] text-ink">{label}</span>
                      <span className="block text-[10px] leading-snug text-muted">{desc}</span>
                    </span>
                    <input
                      type="radio"
                      className="sr-only"
                      checked={opts.exifMode === v}
                      onChange={() => set({ exifMode: v })}
                    />
                  </label>
                ))}
              </div>
            </Field>

            {opts.exifMode === 'frame' && (
              <Field label="Frame style">
                <Segmented
                  options={[
                    { v: 'minimal', label: 'Minimal White' },
                    { v: 'film', label: 'Black Film' }
                  ]}
                  value={opts.frameStyle}
                  onChange={(v) => set({ frameStyle: v as FrameStyle })}
                />
              </Field>
            )}

            {/* Destination */}
            <Field label="Destination">
              <div className="flex gap-2">
                <button
                  onClick={pickDir}
                  className="shrink-0 rounded-control border border-glass px-3 py-1.5 text-[11px] text-muted hover:text-ink"
                >
                  Choose…
                </button>
                <span className="lx-num flex-1 self-center truncate text-[10px] text-faint" title={opts.destDir}>
                  {opts.destDir || 'No folder chosen'}
                </span>
              </div>
            </Field>
          </div>

          {/* Footer */}
          <div className="border-t border-glass px-5 py-3">
            {result ? (
              <div className="flex items-center justify-between">
                <span className="text-[12px] text-ink">
                  Exported {result.n} photo{result.n === 1 ? '' : 's'}
                  {result.errors > 0 && <span className="text-accent-soft"> · {result.errors} failed</span>}
                </span>
                <Button variant="primary" onClick={close}>
                  Done
                </Button>
              </div>
            ) : progress ? (
              <div className="space-y-1.5">
                <div className="lx-groove h-1.5 overflow-hidden rounded-full">
                  <div
                    className="lx-fill h-full rounded-full transition-[width]"
                    style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
                  />
                </div>
                <span className="lx-num text-[10px] text-muted">
                  Exporting {progress.done} / {progress.total}…
                </span>
              </div>
            ) : (
              <div className="flex items-center justify-end gap-2">
                <button onClick={close} className="px-3 py-2 text-[12px] text-muted hover:text-ink">
                  Cancel
                </button>
                <Button variant="primary" disabled={!opts.destDir} onClick={run}>
                  Export {scope === 'all' && filtered.length > 1 ? `${filtered.length} photos` : ''}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <span className="lx-eyebrow">{label}</span>
      {children}
    </div>
  )
}

function Segmented({
  options,
  value,
  onChange
}: {
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}): JSX.Element {
  return (
    <div className="flex gap-1 rounded-control border border-glass bg-black/20 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`flex-1 rounded-[7px] px-2 py-1 text-[11px] transition-colors ${
            value === o.v ? 'bg-accent/15 text-accent-soft' : 'text-muted hover:text-ink'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// Live HTML frame preview — mirrors the export compositor's styles/fonts so the
// user sees the actual look before exporting.
function FramePreview({
  url,
  style,
  fields
}: {
  url: string | null
  style: FrameStyle
  fields: { label: string; value: string }[]
}): JSX.Element {
  const theme =
    style === 'film'
      ? { bg: '#0c0c0e', title: '#f0eef2', tech: '#b9b6c0', hair: 'rgba(255,255,255,0.12)' }
      : { bg: '#f6f4f1', title: '#161418', tech: '#4a4750', hair: 'rgba(0,0,0,0.12)' }
  const title = fields.find((f) => f.label === 'Camera')?.value
  const tech = fields.filter((f) => f.label !== 'Camera').map((f) => f.value).join('   ·   ')
  return (
    <div className="max-h-full max-w-full shadow-xl" style={{ background: theme.bg, padding: '5%' }}>
      {url && <img src={url} alt="" className="block max-h-[52vh] w-full object-contain" />}
      <div className="border-t pt-2.5 text-center" style={{ borderColor: theme.hair, marginTop: '5%' }}>
        {title && (
          <div className="lx-display text-[13px] font-semibold" style={{ color: theme.title }}>
            {title}
          </div>
        )}
        <div className="lx-num mt-1 text-[9px]" style={{ color: theme.tech }}>
          {tech}
        </div>
      </div>
    </div>
  )
}
