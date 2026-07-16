import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { Thumbnail } from '../ui/Thumbnail'

// Bottom filmstrip — a floating glass rail of the folder's (filtered) photos.
export function Filmstrip(): JSX.Element {
  const photos = useStore((s) => s.photos)
  const visible = useStore(selectFilteredPhotos)
  const selectedPath = useStore((s) => s.selectedPath)
  const selectPhoto = useStore((s) => s.selectPhoto)

  if (photos.length === 0) return <div className="hidden" />

  return (
    <div className="lx-glass absolute bottom-0 left-72 right-80 z-20 flex h-24 items-center gap-2 rounded-none border-x-0 border-b-0 px-4">
      <span className="lx-eyebrow shrink-0 rotate-180 pr-1 [writing-mode:vertical-rl]">
        {visible.length} shots
      </span>
      <div className="flex h-full flex-1 items-center gap-2 overflow-x-auto py-3">
        {visible.map((p) => (
          <Thumbnail
            key={p.filePath}
            photo={p}
            active={selectedPath === p.filePath}
            onClick={() => selectPhoto(p.filePath)}
            className="h-full w-16 shrink-0"
          />
        ))}
      </div>
    </div>
  )
}
