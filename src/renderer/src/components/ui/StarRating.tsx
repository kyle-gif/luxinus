interface StarRatingProps {
  rating: number
  size?: number
  interactive?: boolean
  onChange?: (rating: number) => void
}

// Five stars. Filled stars use the pink accent as a stroke/fill hairline motif.
// Read-only by default; interactive on the selected photo. Clicking the current
// rating again clears it (Lightroom behavior).
export function StarRating({
  rating,
  size = 14,
  interactive = false,
  onChange
}: StarRatingProps): JSX.Element {
  return (
    <div className="flex items-center gap-0.5" role={interactive ? 'radiogroup' : undefined}>
      {[1, 2, 3, 4, 5].map((n) => {
        const filled = n <= rating
        const star = (
          <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M12 2.5l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18.9 6.1 21l1.2-6.5L2.5 9.4l6.6-.9z"
              fill={filled ? 'var(--lx-accent)' : 'transparent'}
              stroke={filled ? 'var(--lx-accent)' : 'rgba(255,255,255,0.28)'}
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        )
        if (!interactive) return <span key={n}>{star}</span>
        return (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={n === rating}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
            onClick={() => onChange?.(n === rating ? 0 : n)}
            className="transition-transform hover:scale-110"
          >
            {star}
          </button>
        )
      })}
    </div>
  )
}
