import { useEffect, useState } from 'react'
import { useStore } from '../../store/useStore'
import { renderPresetThumb, setPresetSource } from '../../lib/presetThumb'
import { applyPreset, type Preset, type XmpImportResult } from '../../../../shared/presets'
import { useDialogFocus } from './useDialogFocus'

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
  const [error, setError] = useState<string | null>(null)
  useEffect(() => () => useStore.getState().setPreviewEdit(null), [selectedPath])

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
    try { await savePreset(name.trim()); setName(''); setNaming(false); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
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
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally {
      setImporting(false)
    }
  }

  return (
    <div className="space-y-3">
      {error && <p role="alert" className="text-red-300 text-[12px]">{error}</p>}
      <p className="text-[12px] text-muted">포인터를 올리거나 키보드로 선택해 미리보기 · 클릭 / Enter로 적용</p>
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
              placeholder="프리셋 이름" aria-label="프리셋 이름"
              className="flex-1 rounded-control border border-glass bg-black/25 px-2.5 py-1.5 text-[12px] text-ink focus:border-accent/60"
            />
            <button onClick={doSave} className="rounded-control border border-accent/60 bg-accent/10 px-2.5 text-[12px] text-accent-soft">
              저장
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => setNaming(true)}
              className="flex-1 rounded-control border border-glass px-2.5 py-1.5 text-[12px] text-muted hover:text-ink"
            >
              + 현재 보정 저장
            </button>
            <button
              onClick={doImport}
              disabled={importing}
              className="rounded-control border border-glass px-2.5 py-1.5 text-[12px] text-muted hover:text-ink disabled:opacity-50"
            >
              {importing ? '가져오는 중…' : '.xmp 가져오기'}
            </button>
          </>
        )}
      </div>

      {presets.length === 0 ? (
        <p className="py-2 text-center text-[12px] text-faint">
          프리셋이 없습니다. 현재 보정을 저장하거나 Lightroom .xmp 파일을 가져오세요.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {presets.map((p) => (
            <PresetTile key={p.id} preset={p} thumb={thumbs[p.id]} onApply={() => { useStore.getState().setPreviewEdit(null); apply(p) }} onPreview={() => { const current = useStore.getState(); current.setPreviewEdit(applyPreset(current.edit, p)) }} onClearPreview={() => useStore.getState().setPreviewEdit(null)} onDelete={() => void del(p.id).catch((e) => setError(String(e)))} />
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
  onPreview,
  onClearPreview,
  onDelete
}: {
  preset: Preset
  thumb: string | undefined
  onApply: () => void
  onPreview: () => void
  onClearPreview: () => void
  onDelete: () => void
}): JSX.Element {
  return (
    <div className="group relative">
      <button
        onClick={onApply}
        onMouseEnter={onPreview} onMouseLeave={onClearPreview} onFocus={onPreview} onBlur={onClearPreview}
        title={`${preset.name} 적용`}
        className="block aspect-square w-full overflow-hidden rounded-[2px] border border-glass transition-colors hover:border-accent/70"
      >
        {thumb ? (
          <img src={thumb} alt={preset.name} className="h-full w-full object-contain" />
        ) : (
          <div className="h-full w-full bg-black/40" />
        )}
      </button>
      <div className="truncate px-1 pt-2 text-[12px] text-ink">
        {preset.name}
        {preset.origin === 'xmp' && <span className="text-accent-soft"> ·xmp</span>}
      </div>
      <button
        onClick={onDelete}
        title="프리셋 삭제" aria-label={`${preset.name} 프리셋 삭제`}
        className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/30 bg-black/80 text-[12px] text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-accent-soft"
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
  const ref = useDialogFocus(true, onClose)
  return (
    <div
      className="lx-modal-backdrop"
      onClick={onClose}
    >
      <div
        ref={ref} role="dialog" aria-modal="true" aria-label="XMP 프리셋 가져오기 결과" tabIndex={-1}
        className="lx-modal w-[460px] max-w-[92vw] overflow-hidden rounded-panel"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-5 pt-5">
          <div>
            <span className="lx-eyebrow">Lightroom 프리셋 가져오기 결과</span>
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
          <p className="text-[12px] leading-snug text-muted">
            <span className="text-ink">지원 항목을 근사 변환했습니다.</span> Luxinus와 Adobe의 렌더링 방식이 달라 결과가 정확히 같지는 않습니다.
          </p>
        </div>

        <div className="max-h-[42vh] space-y-4 overflow-y-auto px-5 py-4">
          {/* Mapped */}
          <section>
            <div className="mb-2 flex items-center gap-2">
              <span className="h-3 w-[2px] rounded-full bg-accent" />
              <span className="lx-eyebrow">변환 지원 · {result.mapped.length}</span>
            </div>
            {result.mapped.length ? (
              <div className="flex flex-wrap gap-1.5">
                {result.mapped.map((m) => (
                  <span
                    key={m}
                    className="lx-num rounded-md border border-glass bg-white/[0.03] px-2 py-1 text-[12px] text-ink"
                  >
                    {m}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-faint">인식 가능한 보정 항목이 없습니다.</p>
            )}
          </section>

          {/* Ignored */}
          {result.ignored.length > 0 && (
            <section>
              <div className="mb-2 flex items-center gap-2">
                <span className="h-3 w-[2px] rounded-full bg-white/20" />
                <span className="lx-eyebrow">지원하지 않음 · {result.ignored.length}</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {result.ignored.map((m) => (
                  <span
                    key={m}
                    className="lx-num rounded-md px-1.5 py-0.5 text-[12px] text-faint line-through decoration-white/20"
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
            프리셋으로 보관
          </button>
          <button
            onClick={onApply}
            className="rounded-control border border-accent/60 bg-accent/10 px-4 py-2 text-[12px] font-medium text-accent-soft transition-colors hover:bg-accent/[0.16]"
          >
            현재 사진에 적용
          </button>
        </div>
      </div>
    </div>
  )
}
