import { useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { useStore } from '../../store/useStore'

// The draggable divider for split-compare. It overlays the aspect-locked image
// box, so its `left = splitPos` matches exactly where the shader splits original
// (left) from edited (right).
export function SplitHandle(): JSX.Element {
  const splitPos = useStore((s) => s.splitPos)
  const setSplitPos = useStore((s) => s.setSplitPos)
  const ref = useRef<HTMLDivElement>(null)

  function fromEvent(clientX: number): void {
    const box = ref.current?.parentElement
    if (!box) return
    const r = box.getBoundingClientRect()
    setSplitPos((clientX - r.left) / r.width)
  }

  function onDown(e: ReactPointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId)
    fromEvent(e.clientX)
  }
  function onMove(e: ReactPointerEvent<HTMLDivElement>): void {
    if (e.buttons) fromEvent(e.clientX)
  }

  return (
    <div
      ref={ref}
      onPointerDown={onDown}
      onPointerMove={onMove}
      className="absolute inset-y-0 z-10 -ml-3 w-6 cursor-ew-resize"
      style={{ left: `${splitPos * 100}%` }}
    >
      <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/80" />
      <div className="absolute left-1/2 top-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/50 bg-black/60 backdrop-blur">
        <span className="text-[10px] text-white/90">⇄</span>
      </div>
    </div>
  )
}
