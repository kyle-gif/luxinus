import { useStore } from '../../store/useStore'
import type { PhotoVM } from '../../types'

interface ThumbnailProps {
  photo: PhotoVM
  active: boolean
  onClick: () => void
  className?: string
}

// A single library thumbnail. Shows the decoded webp once it streams in;
// otherwise a subtle placeholder with the filename. Active = pink hairline + tick.
// Rating (stars) and flag render as small read-only indicators.
export function Thumbnail({ photo, active, onClick, className = '' }: ThumbnailProps): JSX.Element {
  const edited = useStore((s) => s.editedPaths.has(photo.filePath))
  return (
    <button
      onClick={onClick}
      title={photo.fileName}
      className={`lx-squish group relative overflow-hidden rounded-md border ${
        active ? 'border-accent' : 'border-glass hover:border-white/25'
      } ${className}`}
    >
      {photo.thumbUrl ? (
        <img
          src={photo.thumbUrl}
          alt={photo.fileName}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-black/45">
          <span className="lx-num px-1 text-center text-[8px] leading-tight text-faint">
            {photo.fileName}
          </span>
        </div>
      )}

      {/* RAW badge */}
      {photo.isRaw && (
        <span className="lx-num absolute left-1 top-1 rounded bg-black/60 px-1 text-[7px] uppercase text-muted">
          raw
        </span>
      )}

      {/* Edited badge — has a sidecar with non-default edits. */}
      {edited && (
        <span
          title="Edited"
          className="absolute right-1 top-1 flex h-3 w-3 items-center justify-center rounded-full bg-accent/90 text-[7px] text-white"
        >
          ◆
        </span>
      )}

      {/* Flag + rating indicators */}
      <div className="absolute bottom-0 left-0 right-0 flex items-center justify-between bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2 opacity-0 transition-opacity group-hover:opacity-100 data-[show=true]:opacity-100"
        data-show={photo.rating > 0 || photo.flagged}>
        <span className="lx-num text-[8px] text-accent-soft">
          {photo.rating > 0 ? '★'.repeat(photo.rating) : ''}
        </span>
        {photo.flagged && <span className="h-1.5 w-1.5 rounded-full bg-accent" title="Flagged" />}
      </div>

      {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent" />}
    </button>
  )
}
