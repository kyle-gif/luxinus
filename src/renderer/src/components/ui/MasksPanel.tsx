import { useEffect, useState } from 'react'
import { useStore } from '../../store/useStore'
import { MASK_ADJUST_KEYS, type Mask, type MaskKind } from '../../../../shared/edits'
import { Slider } from './Slider'
import { RangeSlider } from './RangeSlider'
import { usePortraitStore } from '../../store/usePortraitStore'
import { PORTRAIT_REGIONS, PORTRAIT_LABELS, SEMANTIC_MAX_MASKS } from '../../../../shared/portrait'

// The Masking panel. Intuition-first: big labelled type cards to add a mask, a
// live red coverage overlay you can toggle, a clear list, and a focused editor
// for the selected mask. The interactive geometry lives on the stage.

const KIND_ICON: Record<MaskKind, JSX.Element> = {
  semantic: <><circle cx="8" cy="5" r="2.4" /><path d="M3 14v-2a5 5 0 0 1 10 0v2" /></>,
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
  semantic: '인물 부위 자동 선택',
  radial: '테두리로 크기 조정',
  linear: '한 방향으로 서서히',
  brush: '직접 칠해서 선택',
  lumRange: '밝기 범위 지정',
  colorRange: '사진의 색상 선택'
}
const KIND_LABEL: Record<MaskKind, string> = {
  semantic: '인물 자동 선택',
  radial: '타원 영역',
  linear: '그라데이션',
  brush: '브러시',
  lumRange: '밝기로 선택',
  colorRange: '색으로 선택'
}

const ADJUST_META: {
  key: (typeof MASK_ADJUST_KEYS)[number]
  label: string
  gradient?: 'temp' | 'tint' | 'sat'
  min?: number
  max?: number
}[] = [
  { key: 'exposure', label: '노출' },
  { key: 'contrast', label: '대비' },
  { key: 'highlights', label: '밝은 부분' },
  { key: 'shadows', label: '어두운 부분' },
  { key: 'whites', label: '흰색' },
  { key: 'blacks', label: '검은색' },
  { key: 'temperature', label: '색온도', gradient: 'temp' },
  { key: 'tint', label: '색조', gradient: 'tint' },
  { key: 'saturation', label: '채도', gradient: 'sat' },
  { key: 'clarity', label: '부분 대비' },
  { key: 'dehaze', label: '안개 제거' },
  { key: 'sharpness', label: '선명도', min: 0, max: 100 }
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
  const brushFull = masks.filter(mask => mask.enabled && mask.kind === 'brush').length >= 4

  return (
    <div className="space-y-3">
      <PortraitSelection />
      {masks.length >= SEMANTIC_MAX_MASKS && <p role="status" className="text-[12px] text-muted">선택 영역 16개를 사용 중입니다. 새 영역을 만들려면 기존 영역을 삭제하세요.</p>}
      {/* Add a mask — big, labelled cards. */}
      <div className="grid grid-cols-2 gap-2">
        {(['lumRange', 'colorRange', 'radial', 'linear', 'brush'] as MaskKind[]).map((k) => (
          <button
            key={k}
            disabled={masks.length >= SEMANTIC_MAX_MASKS || (k === 'brush' && brushFull)}
            onClick={() => addMask(k)}
            className={`flex flex-col items-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-2.5 text-muted transition-colors hover:border-accent/50 hover:text-ink ${
              k === 'brush' ? 'col-span-2' : ''
            }`}
          >
            <KindGlyph kind={k} />
            <span className="text-[12px] font-medium text-ink">{KIND_LABEL[k]}</span>
            <span className="text-[12px] text-faint">{k === 'brush' && brushFull ? '브러시 4개 사용 중' : KIND_HINT[k]}</span>
          </button>
        ))}
      </div>

      {/* One-click dynamic-range selections — pre-aimed luminance ranges. */}
      <div className="space-y-1.5">
        <span className="lx-eyebrow px-0.5">빠른 범위 선택</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={masks.length >= SEMANTIC_MAX_MASKS}
            onClick={() => addQuickMask('blown')}
            className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <span className="h-2 w-2 rounded-full border border-white/40 bg-white" />
            너무 밝은 부분
          </button>
          <button
            disabled={masks.length >= SEMANTIC_MAX_MASKS}
            onClick={() => addQuickMask('crushed')}
            className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
          >
            <span className="h-2 w-2 rounded-full border border-white/40 bg-black" />
            너무 어두운 부분
          </button>
        </div>
      </div>

      {masks.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-0.5">
            <span className="lx-eyebrow">보정 영역 · {masks.length}</span>
            <div className="flex items-center gap-2">
              {showOverlay && (
                <button
                  onClick={cycleOverlayMode}
                  title="선택 영역 표시 방식 전환 (Shift+O)"
                  className="lx-num rounded border border-glass px-1.5 py-0.5 text-[12px] text-muted transition-colors hover:border-accent/40 hover:text-ink"
                >
                  {overlayMode === 0 ? '빨강' : overlayMode === 1 ? '흰색/검은색' : '검은색/흰색'}
                </button>
              )}
              <button
                onClick={() => setShowOverlay(!showOverlay)}
                title={showOverlay ? '선택 영역 표시 숨기기 (O)' : '선택 영역 표시 (O)'}
                className={`flex items-center gap-1 text-[12px] transition-colors ${showOverlay ? 'text-accent-soft' : 'text-faint hover:text-muted'}`}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" strokeLinecap="round" strokeLinejoin="round" />
                  <circle cx="8" cy="8" r="1.9" />
                  {!showOverlay && <path d="M3 13 13 3" strokeLinecap="round" />}
                </svg>
                영역 표시
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

function PortraitSelection(): JSX.Element {
  const portrait = usePortraitStore()
  const photoId = useStore(s => s.selectedPath)
  const ready = useStore(s => s.proxy.status === 'ready' && s.proxy.filePath === s.selectedPath && !s.editLoading && !s.editGestureActive && !s.syncing)
  const maskCount = useStore(s => s.edit.masks.length)
  const [error, setError] = useState('')
  useEffect(() => { void portrait.refreshModel() }, [portrait.refreshModel])
  useEffect(() => { setError('') }, [photoId])
  const result = portrait.photoId === photoId && portrait.phase === 'ready'
  return <section aria-label="인물 자동 선택" className="rounded-control border border-accent/30 bg-accent/[0.04] p-3 space-y-2.5">
    <div className="flex items-center gap-2"><KindGlyph kind="semantic" /><strong className="text-[13px] font-medium">인물 자동 선택</strong><span className="ml-auto text-[11px] text-muted">내 컴퓨터에서 분석</span></div>
    <p className="text-[12px] leading-relaxed text-muted">얼굴·눈·코·입·피부·옷을 찾아 따로 보정합니다.</p>
    {portrait.phase === 'running' ? <div role="status" className="flex items-center justify-between gap-2 text-[12px]"><span>{portrait.message}</span><button onClick={portrait.cancel} className="shrink-0 text-accent-soft">중단</button></div>
      : <button disabled={!ready || !portrait.model?.modelAvailable} onClick={() => { setError(''); void portrait.analyze() }} className="w-full rounded-control border border-accent/40 bg-accent/10 py-2 text-[12px] text-ink disabled:opacity-40">{result ? '다시 분석' : '인물 부위 찾기'}</button>}
    {portrait.model && !portrait.model.modelAvailable && <p className="text-[12px] text-muted">{portrait.model.message ?? '인물 분석 모델이 준비되지 않았습니다.'}</p>}
    {result && <div className="grid grid-cols-2 gap-1.5">{PORTRAIT_REGIONS.map(region => {
      const found = portrait.regions.find(item => item.region === region)
      return <button key={region} disabled={!found || !ready || maskCount >= SEMANTIC_MAX_MASKS} title={found ? `${PORTRAIT_LABELS[region]} 선택 영역 추가` : '이 사진에서 찾지 못한 부위'}
        className="rounded-control border border-glass px-2 py-2 text-[12px] text-ink hover:border-accent/50 disabled:opacity-35"
        onClick={() => { if (!found || !photoId) return; try { useStore.getState().addSemanticMasks(photoId, [found]); setError('') } catch (err) { setError((err as Error).message) } }}>
        {PORTRAIT_LABELS[region]}{!found && <span className="block text-[10px]">찾지 못함</span>}
      </button>
    })}</div>}
    {portrait.phase !== 'running' && portrait.message && <p role="status" className="text-[12px] text-muted">{portrait.message}</p>}
    {portrait.warnings.map((warning, index) => <p key={index} className="text-[11px] leading-relaxed text-muted">{warning}</p>)}
    {error && <p role="alert" className="text-[12px] text-accent-soft">{error}</p>}
  </section>
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
        title={mask.enabled ? '보정 영역 숨기기' : '보정 영역 표시'}
        className={`text-[12px] transition-colors ${mask.enabled ? 'text-muted hover:text-ink' : 'text-faint hover:text-muted'}`}
      >
        {mask.enabled ? '◉' : '○'}
      </button>
      <button
        onClick={onDelete}
        title="보정 영역 삭제"
        className="text-[12px] text-faint opacity-0 transition-opacity hover:text-accent-soft group-hover:opacity-100 focus:opacity-100"
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
    <div className="lx-fade-in space-y-3.5 rounded-control border border-accent/25 bg-accent/[0.03] p-3">
      <div className="flex items-center gap-2">
        <KindGlyph kind={mask.kind} className="text-accent-soft" />
        <span className="text-[12px] font-medium text-ink">{mask.name}</span>
        <span className="lx-rule flex-1" />
        <span className="text-[12px] uppercase tracking-wider text-faint">편집 중</span>
      </div>

      {mask.kind === 'brush' && <BrushControls mask={mask} />}
      {mask.kind === 'radial' && mask.radial && (
        <div className="space-y-3">
          <Slider
            label="경계 부드럽게"
            min={0}
            max={100}
            value={Math.round(mask.radial.feather * 100)}
            onChange={(v) => updateMask(mask.id, { radial: { ...mask.radial!, feather: v / 100 } })}
          />
          <button
            onClick={() => updateMask(mask.id, { radial: { ...mask.radial!, invert: !mask.radial!.invert } })}
            className={`w-full rounded-control border py-1.5 text-[12px] transition-colors ${
              mask.radial.invert ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
            }`}
          >
            {mask.radial.invert ? '반전됨 · 바깥쪽' : '보정 영역 반전'}
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
        label="적용 강도"
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
        label="범위"
        track="lum"
        lo={Math.round(lum.lo * 100)}
        hi={Math.round(lum.hi * 100)}
        onChange={(lo, hi) => onChange({ ...lum, lo: lo / 100, hi: hi / 100 })}
      />
      <Slider
        label="아래쪽 감쇠"
        min={0}
        max={50}
        value={Math.round(lum.featherLo * 100)}
        onChange={(v) => onChange({ ...lum, featherLo: v / 100 })}
      />
      <Slider
        label="위쪽 감쇠"
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
        className={`flex w-full items-center gap-2.5 rounded-control border px-2.5 py-2 text-[12px] transition-colors ${
          colorPicking
            ? 'border-accent/60 bg-accent/10 text-accent-soft'
            : 'border-glass text-muted hover:text-ink'
        }`}
      >
        <span
          className="h-4 w-4 shrink-0 rounded-full border border-white/30"
          style={{ background: `rgb(${r},${g},${b})` }}
        />
        {colorPicking ? '사진에서 색상을 클릭하세요…' : '색상 다시 선택'}
        <span className="lx-num ml-auto text-[12px] text-faint">
          {r},{g},{b}
        </span>
      </button>
      <Slider
        label="허용 오차"
        min={0}
        max={100}
        value={Math.round(color.tolerance * 100)}
        onChange={(v) => onChange({ ...color, tolerance: v / 100 })}
      />
      <Slider
        label="경계 부드럽게"
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
        <span className="lx-eyebrow">범위 보완</span>
        <span className="lx-rule flex-1" />
        {(['add', 'subtract', 'intersect'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setPendingMode(pendingMode === mode ? null : mode)}
            title={{ add: '선택 영역 추가', subtract: '선택 영역 제외', intersect: '겹치는 영역만 선택' }[mode]}
            className={`lx-num rounded border px-1.5 py-0.5 text-[12px] transition-colors ${
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
              className="flex items-center justify-center gap-1.5 rounded-control border border-glass bg-white/[0.02] py-1.5 text-[12px] text-muted transition-colors hover:border-accent/50 hover:text-ink"
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
              className={`group/chip flex items-center gap-1 rounded-full border py-0.5 pl-1.5 pr-1 text-[12px] transition-colors ${
                r.id === selectedRefineId
                  ? 'border-accent/60 bg-accent/[0.08] text-accent-soft'
                  : 'border-glass text-muted hover:border-white/20'
              }`}
            >
              <button onClick={() => selectRefine(r.id === selectedRefineId ? null : r.id)} className="flex items-center gap-1">
                <span className="lx-num">{MODE_GLYPH[r.mode]}</span>
                <KindGlyph kind={r.kind} className="scale-90" />
                {r.invert && <span className="lx-num text-[12px]">반전</span>}
              </button>
              <button
                onClick={() => removeRefine(mask.id, r.id)}
                title="범위 보완 삭제"
                className="px-0.5 text-faint opacity-0 transition-opacity hover:text-accent-soft group-hover/chip:opacity-100 focus:opacity-100"
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
                className={`lx-num flex-1 rounded border py-1 text-[12px] transition-colors ${
                  selected.mode === mode
                    ? 'border-accent/60 bg-accent/10 text-accent-soft'
                    : 'border-glass text-muted hover:text-ink'
                }`}
              >
                {MODE_GLYPH[mode]} {{ add: '추가', subtract: '제외', intersect: '교차' }[mode]}
              </button>
            ))}
            <button
              onClick={() => updateRefine(mask.id, selected.id, { invert: !selected.invert })}
              className={`lx-num rounded border px-2 py-1 text-[12px] transition-colors ${
                selected.invert
                  ? 'border-accent/60 bg-accent/10 text-accent-soft'
                  : 'border-glass text-muted hover:text-ink'
              }`}
            >
              반전
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
      <div className="flex items-center gap-2 rounded-control border border-glass bg-black/20 px-2.5 py-1.5 text-[12px] text-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        사진 위에 칠해 보정 영역를 만드세요.
      </div>
      <Slider
        label="브러시 크기"
        min={1}
        max={40}
        value={Math.round(brushRadius * 200)}
        onChange={(v) => setBrushRadius(v / 200)}
      />
      <div className="flex gap-2">
        <button
          onClick={() => setBrushErase(false)}
          className={`flex-1 rounded-control border py-1.5 text-[12px] transition-colors ${
            !brushErase ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
          }`}
        >
          칠하기
        </button>
        <button
          onClick={() => setBrushErase(true)}
          className={`flex-1 rounded-control border py-1.5 text-[12px] transition-colors ${
            brushErase ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted hover:text-ink'
          }`}
        >
          지우개
        </button>
        <button
          onClick={() => clearBrush(mask.id)}
          disabled={empty}
          className="rounded-control border border-glass px-2.5 py-1.5 text-[12px] text-muted transition-colors hover:text-accent-soft disabled:opacity-40"
        >
          비우기
        </button>
      </div>
      <div className="lx-rule" />
    </div>
  )
}
