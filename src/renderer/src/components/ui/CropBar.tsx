import { useStore } from '../../store/useStore'
import type { CropRect } from '../../types'
import { Slider } from './Slider'

// Floating toolbar shown while cropping: aspect-ratio presets, reset, and done.
// Aspect values are pixel ratios (w/h); '자유' = null, '원본 비율' = image aspect.

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }

const PRESETS: { label: string; ratio: number | 'orig' | null }[] = [
  { label: '자유', ratio: null },
  { label: '원본 비율', ratio: 'orig' },
  { label: '1:1', ratio: 1 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '16:9', ratio: 16 / 9 }
]

export function CropBar({ imgAspect }: { imgAspect: number }): JSX.Element {
  const crop = useStore((s) => s.edit.crop) ?? FULL
  const rotate = useStore((s) => s.edit.rotate)
  const flipH = useStore((s) => s.edit.flipH)
  const flipV = useStore((s) => s.edit.flipV)
  const setEdit = useStore((s) => s.setEdit)
  const cropAspect = useStore((s) => s.cropAspect)
  const setCropAspect = useStore((s) => s.setCropAspect)
  const setCropMode = useStore((s) => s.setCropMode)

  // Snap the current crop to a target pixel aspect, centred on its current centre.
  function applyAspect(ratio: number | 'orig' | null): void {
    const a = ratio === 'orig' ? imgAspect : ratio
    setCropAspect(a)
    if (a === null) return
    const normA = a / imgAspect // rect w/h in normalized (squished) space
    const cx = crop.x + crop.w / 2
    const cy = crop.y + crop.h / 2
    let w = crop.w
    let h = w / normA
    if (h > 1) {
      h = 1
      w = h * normA
    }
    if (w > 1) {
      w = 1
      h = w / normA
    }
    const x = clamp(cx - w / 2, 0, 1 - w)
    const y = clamp(cy - h / 2, 0, 1 - h)
    setEdit({ crop: { x, y, w, h } })
  }

  function activeLabel(): string | null {
    if (cropAspect === null) return '자유'
    if (Math.abs(cropAspect - imgAspect) < 1e-3) return '원본 비율'
    const hit = PRESETS.find((p) => typeof p.ratio === 'number' && Math.abs(p.ratio - cropAspect) < 1e-3)
    return hit?.label ?? null
  }
  const active = activeLabel()

  return (
    <div className="space-y-5" aria-label="자르기와 수평 조정">
      <p className="text-[12px] leading-relaxed text-muted">사진의 테두리를 끌어 원하는 부분만 남기세요. 안쪽을 끌면 자를 영역이 이동합니다.</p>
      <section aria-label="자르기 비율">
      <h3 className="mb-2 text-[13px] font-medium">자르기 비율</h3>
      <div className="grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            aria-pressed={active === p.label}
            onClick={() => applyAspect(p.ratio)}
            className={`rounded-control px-2 py-2 text-[12px] transition-colors ${
              active === p.label
                ? 'border border-accent/60 bg-accent/10 text-accent-soft'
                : 'border border-transparent text-muted hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <button
        onClick={() => {
          setEdit({ crop: null })
          setCropAspect(null)
        }}
        className="rounded-control px-2.5 py-1 text-[12px] text-muted transition-colors hover:text-accent-soft"
      >
        자를 영역만 초기화
      </button>
      </section>
      <section className="border-t border-glass pt-4" aria-label="수평 조정">
        <Slider label="수평 맞추기" min={-45} max={45} step={0.1} value={Math.round(rotate * 10) / 10}
          onChange={(value) => setEdit({ rotate: value })}
          onDragChange={(dragging) => useStore.getState().setStraightening(dragging)} />
        <p className="mt-1 text-[12px] leading-relaxed text-muted">사진의 기울기를 −45°~+45°로 조정합니다. 수치를 누르면 각도를 직접 입력할 수 있습니다.</p>
      </section>
      <section aria-label="사진 뒤집기">
        <h3 className="mb-2 text-[13px] font-medium">뒤집기</h3>
        <div className="grid grid-cols-2 gap-2">{([['flipH', flipH, '좌우 뒤집기'], ['flipV', flipV, '상하 뒤집기']] as const).map(([key, active, label]) =>
          <button key={key} type="button" aria-pressed={active} onClick={() => setEdit({ [key]: !active })}
            className={`rounded-control border px-2 py-2 text-[12px] ${active ? 'border-accent/60 bg-accent/10 text-accent-soft' : 'border-glass text-muted'}`}>{label}</button>)}</div>
      </section>
      <div className="grid gap-2 border-t border-glass pt-4">
      <button type="button" onClick={() => {
        setEdit({ crop: null, rotate: 0, flipH: false, flipV: false }); setCropAspect(null)
      }} className="text-[12px] text-muted py-2">자르기·수평·뒤집기 초기화</button>
      <button
        onClick={() => { setCropMode(false); useStore.getState().setStraightening(false) }}
        className="rounded-control bg-accent px-3 py-2.5 text-[13px] font-medium text-[#151515]"
      >
        자르기 완료
      </button>
      </div>
    </div>
  )
}
