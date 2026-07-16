import { useStore } from '../../store/useStore'
import type { CropRect } from '../../types'

// Floating toolbar shown while cropping: aspect-ratio presets, reset, and done.
// Aspect values are pixel ratios (w/h); 'Free' = null, 'Original' = image aspect.

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const FULL: CropRect = { x: 0, y: 0, w: 1, h: 1 }

const PRESETS: { label: string; ratio: number | 'orig' | null }[] = [
  { label: 'Free', ratio: null },
  { label: 'Original', ratio: 'orig' },
  { label: '1:1', ratio: 1 },
  { label: '3:2', ratio: 3 / 2 },
  { label: '2:3', ratio: 2 / 3 },
  { label: '4:5', ratio: 4 / 5 },
  { label: '16:9', ratio: 16 / 9 }
]

export function CropBar({ imgAspect }: { imgAspect: number }): JSX.Element {
  const crop = useStore((s) => s.edit.crop) ?? FULL
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
    if (cropAspect === null) return 'Free'
    if (Math.abs(cropAspect - imgAspect) < 1e-3) return 'Original'
    const hit = PRESETS.find((p) => typeof p.ratio === 'number' && Math.abs(p.ratio - cropAspect) < 1e-3)
    return hit?.label ?? null
  }
  const active = activeLabel()

  return (
    <div className="lx-glass lx-pop-in absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-full px-3 py-1.5">
      <span className="lx-eyebrow pl-1 pr-0.5">Crop</span>
      <span className="h-3.5 w-px bg-white/10" />
      <div className="flex items-center gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => applyAspect(p.ratio)}
            className={`rounded-full px-2.5 py-1 text-[11px] transition-colors ${
              active === p.label
                ? 'border border-accent/60 bg-accent/10 text-accent-soft'
                : 'border border-transparent text-muted hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <span className="h-3.5 w-px bg-white/10" />
      <button
        onClick={() => {
          setEdit({ crop: null })
          setCropAspect(null)
        }}
        className="rounded-full px-2.5 py-1 text-[11px] text-muted transition-colors hover:text-accent-soft"
      >
        Reset
      </button>
      <button
        onClick={() => setCropMode(false)}
        className="rounded-full border border-accent/60 bg-accent/10 px-3 py-1 text-[11px] font-medium text-accent-soft transition-colors hover:bg-accent/[0.16]"
      >
        Done
      </button>
    </div>
  )
}
