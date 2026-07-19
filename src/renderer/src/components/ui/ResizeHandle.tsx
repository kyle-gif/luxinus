import { useState, type PointerEvent as ReactPointerEvent } from 'react'

// A thin drag strip on a panel edge for resizing. Invisible until hovered/dragged,
// then a faint pink hairline (pink stays a signal). `compute` turns the pointer's
// clientX into the desired panel width; the parent clamps + persists.
export function ResizeHandle({
  side,
  compute,
  onResize
}: {
  side: 'left' | 'right'
  compute: (clientX: number) => number
  onResize: (width: number) => void
}): JSX.Element {
  const [drag, setDrag] = useState(false)
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(e: ReactPointerEvent<HTMLDivElement>) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        setDrag(true)
      }}
      onPointerMove={(e: ReactPointerEvent<HTMLDivElement>) => {
        if (drag) onResize(compute(e.clientX))
      }}
      onPointerUp={(e: ReactPointerEvent<HTMLDivElement>) => {
        setDrag(false)
        e.currentTarget.releasePointerCapture?.(e.pointerId)
      }}
      onDoubleClick={() => onResize(compute(NaN))} // parent may treat NaN as "reset"
      className={`lx-no-drag absolute top-0 z-30 h-full w-2.5 cursor-col-resize ${
        side === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      <span
        className={`absolute inset-y-0 w-px transition-colors ${side === 'right' ? 'right-0' : 'left-0'} ${
          drag ? 'bg-accent/70' : 'bg-transparent hover:bg-accent/30'
        }`}
      />
    </div>
  )
}
