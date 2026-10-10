import { useStore } from '../../store/useStore'
import type { PhotoVM } from '../../types'
interface ThumbnailProps {
  photo: PhotoVM
  active: boolean
  selected?: boolean
  onClick: (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => void
  onDoubleClick?: () => void
  className?: string
  showName?: boolean
}
export function Thumbnail({ photo, active, selected = false, onClick, onDoubleClick, className = '', showName = false }: ThumbnailProps): JSX.Element {
  const edited = useStore((s) => s.editedPaths.has(photo.filePath))
  return <button onClick={onClick} onDoubleClick={onDoubleClick} title={photo.fileName}
    aria-label={`${photo.fileName}${active ? ', 현재 사진' : selected ? ', 선택됨' : ''}${photo.rating ? `, 별점 ${photo.rating}` : ''}${photo.flagged ? ', 플래그' : ''}${edited ? ', 보정됨' : ''}`}
    aria-pressed={selected || active} data-active={active} data-selected={selected} data-photo-path={photo.filePath}
    className={`lx-thumbnail ${className}`}>
    <span className="lx-thumbnail-image">
      {photo.thumbUrl ? <img src={photo.thumbUrl} alt="" loading="lazy" decoding="async" /> : <span className="text-[12px] text-faint">미리보기 대기</span>}
      {selected && !active && <span className="lx-selection-check" aria-hidden="true">✓</span>}
    </span>
    {showName && <span className="lx-thumbnail-name">{photo.fileName}</span>}
    <span className="lx-thumbnail-meta"><span>{photo.isRaw ? 'RAW' : photo.ext.slice(1).toUpperCase()}</span><span>{photo.rating ? '★'.repeat(photo.rating) : ''}{photo.flagged ? ' ⚑' : ''}{edited ? ' ◆' : ''}</span></span>
  </button>
}
