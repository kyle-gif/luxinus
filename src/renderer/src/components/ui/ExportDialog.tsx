import { useEffect, useState } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { Button } from './Button'
import { Slider } from './Slider'
import { useDialogFocus } from './useDialogFocus'
import { EditCanvas } from './EditCanvas'
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
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const edit = useStore((s) => s.edit)
  const proxyUrl = useStore((s) => (s.proxy.status === 'ready' ? s.proxy.url : null))
  const filtered = useStore(selectFilteredPhotos)

  const [opts, setOpts] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS)
  const selection = useStore((s) => s.selection)
  const [scope, setScope] = useState<'one' | 'selected' | 'all'>('one')
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<{ n: number; errors: { file: string; message: string }[]; canceled: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [canceling, setCanceling] = useState(false)
  const close = (): void => { if (!progress) useStore.getState().setExportOpen(false) }
  const ref = useDialogFocus(open && !!photo, close)
  const restored = useStore((s) => s.denoiseProxy.status === 'ready' && s.denoiseProxy.filePath === s.selectedPath ? s.denoiseProxy.url : null)

  useEffect(() => {
    if (!window.luxinus) return
    return window.luxinus.exportr.onProgress((p) => setProgress({ done: p.done, total: p.total }))
  }, [])

  useEffect(() => {
    if (open) {
      setResult(null)
      setProgress(null)
      setError(null)
      setCanceling(false)
    }
  }, [open])

  if (!open || !photo) return null
  const set = (patch: Partial<ExportOptions>): void => setOpts((o) => ({ ...o, ...patch }))

  async function pickDir(): Promise<void> {
    try { const dir = await window.luxinus.exportr.pickDir(); if (dir) set({ destDir: dir }) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  async function run(): Promise<void> {
    if (!opts.destDir || !window.luxinus) return
    const source = scope === 'all' ? filtered : scope === 'selected' ? useStore.getState().photos.filter((p) => selection.has(p.filePath)) : photo ? [photo] : []
    const items: ExportItem[] = source.map((p) => ({
      filePath: p.filePath,
      fileName: p.fileName,
      // Active photo uses the live edit buffer; others load their sidecar in main.
      editState: p.filePath === photo?.filePath ? edit : null,
      meta: p.meta
    }))
    setProgress({ done: 0, total: items.length })
    setError(null)
    try {
      if (!await useStore.getState().flushSaves()) throw new Error('보정 저장에 실패했습니다. 저장을 다시 시도한 뒤 내보내세요.')
      const res = await window.luxinus.exportr.run(items, opts)
      setResult({ n: res.written.length, errors: res.errors, canceled: res.canceled })
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setProgress(null); setCanceling(false) }
  }

  const fields = frameFields(photo.meta, photo.fileName)
  const count = scope === 'all' ? filtered.length : scope === 'selected' ? selection.size : 1
  const aspect = photo.meta?.width && photo.meta.height ? photo.meta.width / photo.meta.height : 1.5
  const displayAspect = aspect * (edit.crop ? edit.crop.w / edit.crop.h : 1)
  const image = proxyUrl ? <div className="w-full" style={{ aspectRatio: displayAspect }}><EditCanvas imageUrl={proxyUrl} edit={edit} compareMode={0} splitPos={.5} denoiseUrl={restored} className="block h-full w-full" /></div> : null

  return (
    <div className="lx-modal-backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-label="사진 내보내기" tabIndex={-1} className="lx-modal flex max-h-[86vh] w-[860px] max-w-[94vw] overflow-hidden rounded-panel border-glass">
        {/* Left: live preview */}
        <div className="flex w-[45%] flex-col border-r border-glass bg-black/30 p-5">
          <span className="lx-eyebrow mb-3">현재 보정 미리보기</span>
          <div className="flex flex-1 items-center justify-center">
            {opts.exifMode === 'frame' ? (
              <FramePreview image={image} style={opts.frameStyle} fields={fields} />
            ) : (
              image
            )}
          </div>
        </div>

        {/* Right: options */}
        <div className="flex w-[55%] min-w-0 flex-col">
          <div className="flex items-center justify-between px-5 pt-4">
            <span className="lx-display text-[15px] font-semibold text-ink">내보내기 · {count}장</span>
            <button aria-label="내보내기 닫기" disabled={!!progress} onClick={close} className="text-muted hover:text-ink">
              ✕
            </button>
          </div>
          <div className="lx-rule mx-5 mt-2.5" />

          <fieldset disabled={!!progress} className="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
            {/* Scope */}
            {filtered.length > 1 && (
              <Field label="사진 범위">
                <Segmented
                  options={[
                    { v: 'one', label: '현재 사진' },
                    { v: 'selected', label: `선택 ${selection.size}장` },
                    { v: 'all', label: `필터 결과 ${filtered.length}장` }
                  ]}
                  value={scope}
                  onChange={(v) => setScope(v as 'one' | 'selected' | 'all')}
                />
              </Field>
            )}

            {/* Format */}
            <Field label="파일 형식">
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
              <Slider label="JPEG 품질" min={1} max={100} value={opts.quality} onChange={(v) => set({ quality: v })} />
            )}

            {/* Resize */}
            <Field label="출력 긴 변">
              <Segmented
                options={[
                  { v: '0', label: '원본 크기' },
                  { v: '2048', label: '2,048 px' },
                  { v: '4096', label: '4,096 px' }
                ]}
                value={String(opts.longEdge)}
                onChange={(v) => set({ longEdge: Number(v) })}
              />
            </Field>

            {/* Filename */}
            <Field label="파일명 규칙">
              <input
                value={opts.filenamePattern}
                onChange={(e) => set({ filenamePattern: e.target.value })}
                className="w-full rounded-control border border-glass bg-black/25 px-2.5 py-1.5 text-[12px] text-ink focus:border-accent/60"
              />
              <p className="lx-num mt-1 text-[12px] text-faint">치환자: {'{name} {seq} {date} {W} {H}'}</p>
            </Field>

            {/* EXIF */}
            <Field label="메타데이터">
              <div className="space-y-1.5">
                {(
                  [
                    ['keep', '유지', '원본 EXIF·GPS·XMP 보존'],
                    ['strip', '제거', 'EXIF·GPS·XMP 메타데이터 제거'],
                    ['frame', '테두리에 표시', '메타데이터를 제거하고 촬영 정보를 테두리에 인쇄']
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
                      <span className="block text-[12px] leading-snug text-muted">{desc}</span>
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
              <Field label="테두리 스타일">
                <Segmented
                  options={[
                    { v: 'minimal', label: '흰 테두리' },
                    { v: 'film', label: '검정 테두리' }
                  ]}
                  value={opts.frameStyle}
                  onChange={(v) => set({ frameStyle: v as FrameStyle })}
                />
              </Field>
            )}

            {/* Destination */}
            <Field label="저장 위치">
              <div className="flex gap-2">
                <button
                  onClick={pickDir}
                  className="shrink-0 rounded-control border border-glass px-3 py-1.5 text-[12px] text-muted hover:text-ink"
                >
                  폴더 선택…
                </button>
                <span className="lx-num min-w-0 flex-1 self-center truncate text-[12px] text-faint" title={opts.destDir}>
                  {opts.destDir || '저장 폴더를 선택하세요'}
                </span>
              </div>
            </Field>
            <p className="text-[12px] leading-relaxed text-muted">색 공간: sRGB · RGB 8비트 출력. 기존 파일은 덮어쓰지 않고 고유한 이름으로 저장합니다.</p>
          </fieldset>

          {/* Footer */}
          <div className="border-t border-glass px-5 py-3">
            {error && <p role="alert" className="mb-3 text-[12px] text-red-300">{error}</p>}
            {result ? <div className="space-y-3"><p role="status">{result.canceled ? '취소됨 · ' : ''}{result.n}장 저장{result.errors.length > 0 ? ` · ${result.errors.length}장 실패` : ''}</p>{result.errors.length > 0 && <ul className="max-h-32 overflow-y-auto text-[12px] text-red-300">{result.errors.map((e, i) => <li key={i} className="break-all mb-2">{e.file}: {e.message}</li>)}</ul>}<div className="flex justify-end"><Button onClick={close}>닫기</Button></div></div> : progress ? <div className="space-y-2"><progress className="w-full" value={progress.done} max={progress.total} /><div className="flex items-center justify-between"><span role="status">내보내는 중 {progress.done}/{progress.total}</span><Button disabled={canceling} onClick={() => { setCanceling(true); void window.luxinus.exportr.cancel().catch((e) => { setError(String(e)); setCanceling(false) }) }}>{canceling ? '중단 중…' : '중단'}</Button></div></div> : <div className="flex items-center justify-end gap-2"><Button onClick={close}>취소</Button><Button variant="primary" disabled={!opts.destDir || count < 1} onClick={() => void run()}>{count}장 내보내기</Button></div>}
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
          aria-pressed={value === o.v}
          onClick={() => onChange(o.v)}
          className={`flex-1 rounded-[7px] px-2 py-1 text-[12px] transition-colors ${
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
  image,
  style,
  fields
}: {
  image: React.ReactNode
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
      {image}
      <div className="border-t pt-2.5 text-center" style={{ borderColor: theme.hair, marginTop: '5%' }}>
        {title && (
          <div className="lx-display text-[13px] font-semibold" style={{ color: theme.title }}>
            {title}
          </div>
        )}
        <div className="lx-num mt-1 text-[12px]" style={{ color: theme.tech }}>
          {tech}
        </div>
      </div>
    </div>
  )
}
