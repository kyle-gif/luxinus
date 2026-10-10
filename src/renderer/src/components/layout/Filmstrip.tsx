import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { useWorkspaceStore, sortPhotos } from '../../store/useWorkspaceStore'
import { Thumbnail } from '../ui/Thumbnail'
export function Filmstrip(): JSX.Element | null {
  const filtered = useStore(selectFilteredPhotos)
  const sort = useWorkspaceStore((s) => s.sort)
  const visible = useMemo(() => sortPhotos(filtered, sort), [filtered, sort])
  const selectedPath = useStore((s) => s.selectedPath)
  const selection = useStore((s) => s.selection)
  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 20 })
  const itemWidth = 108
  useEffect(() => {
    const el = ref.current
    if (!el) return
    function update(): void { if (el) setRange({ start: Math.max(0, Math.floor(el.scrollLeft / itemWidth) - 2), end: Math.ceil((el.scrollLeft + el.clientWidth) / itemWidth) + 2 }) }
    const observer = new ResizeObserver(update); observer.observe(el)
    el.addEventListener('scroll', update); update()
    return () => { observer.disconnect(); el.removeEventListener('scroll', update) }
  }, [])
  useEffect(() => {
    const i = visible.findIndex((p) => p.filePath === selectedPath)
    const el = ref.current
    if (el && i >= 0 && (i * itemWidth < el.scrollLeft || (i + 1) * itemWidth > el.scrollLeft + el.clientWidth)) el.scrollLeft = Math.max(0, i * itemWidth - el.clientWidth / 2)
  }, [selectedPath, visible])
  if (!visible.length) return null
  return <section className="lx-filmstrip" aria-label="하단 사진 목록"><button className="lx-filmstrip-close" aria-label="하단 사진 접기" onClick={() => useWorkspaceStore.getState().toggleFilmstrip()}>⌄</button><div ref={ref} className="lx-filmstrip-scroll"><div className="relative h-full" style={{ width: visible.length * itemWidth }}><div className="absolute inset-y-0 flex gap-2 py-2" style={{ left: range.start * itemWidth }}>{visible.slice(range.start, range.end).map((p) => <Thumbnail key={p.filePath} photo={p} active={selectedPath === p.filePath} selected={selection.has(p.filePath)} onClick={(e) => useStore.getState().pickPhoto(p.filePath, { meta: e.metaKey || e.ctrlKey, shift: e.shiftKey, order: visible.map((x) => x.filePath) })} className="h-full w-[100px] shrink-0" />)}</div></div></div></section>
}
