import { useMemo, useState } from 'react'
import { useStore } from '../../store/useStore'
import type { EditState } from '../../types'

// Snapshots & History. Snapshots are named saved looks you can jump back to;
// History is the live undo timeline — click any step to travel to it. Both are
// per-photo. Pink stays a signal (the current step's marker, the active hairline).

// Name the change between two edit states for the history label — the single
// field that moved, or a category, so the timeline reads like Lightroom's.
const SCALAR_LABELS: [keyof EditState, string][] = [
  ['exposure', 'Exposure'], ['contrast', 'Contrast'], ['highlights', 'Highlights'],
  ['shadows', 'Shadows'], ['whites', 'Whites'], ['blacks', 'Blacks'],
  ['temperature', 'Temperature'], ['tint', 'Tint'], ['saturation', 'Saturation'],
  ['vibrance', 'Vibrance'], ['clarity', 'Clarity'], ['texture', 'Texture'],
  ['sharpening', 'Sharpening'], ['denoise', 'Denoise'], ['dehaze', 'Dehaze'],
  ['vignette', 'Vignette'], ['grain', 'Grain'], ['rotate', 'Straighten']
]

function describeDelta(prev: EditState | null, cur: EditState): string {
  if (!prev) return 'Import'
  const changed: string[] = []
  for (const [key, label] of SCALAR_LABELS) {
    if (prev[key] !== cur[key]) changed.push(label)
  }
  if (JSON.stringify(prev.curves) !== JSON.stringify(cur.curves)) changed.push('Tone curve')
  if (JSON.stringify(prev.hsl) !== JSON.stringify(cur.hsl)) changed.push('Color mixer')
  if (JSON.stringify(prev.colorGrade) !== JSON.stringify(cur.colorGrade)) changed.push('Color grade')
  if (JSON.stringify(prev.masks) !== JSON.stringify(cur.masks)) changed.push('Masks')
  if (prev.crop !== cur.crop || prev.flipH !== cur.flipH || prev.flipV !== cur.flipV) changed.push('Crop')
  if (changed.length === 0) return 'Edit'
  if (changed.length === 1) return changed[0]
  return `${changed[0]} +${changed.length - 1}`
}

export function HistoryPanel(): JSX.Element {
  const snapshots = useStore((s) => s.snapshots)
  const saveSnapshot = useStore((s) => s.saveSnapshot)
  const applySnapshot = useStore((s) => s.applySnapshot)
  const renameSnapshot = useStore((s) => s.renameSnapshot)
  const deleteSnapshot = useStore((s) => s.deleteSnapshot)
  const undoStack = useStore((s) => s.undoStack)
  const redoStack = useStore((s) => s.redoStack)
  const edit = useStore((s) => s.edit)
  const jumpToHistory = useStore((s) => s.jumpToHistory)
  const [naming, setNaming] = useState(false)
  const [draft, setDraft] = useState('')

  // Combined timeline, newest at top. Current position = undoStack.length.
  const timeline = useMemo(() => {
    const states = [...undoStack, edit, ...[...redoStack].reverse()]
    const cur = undoStack.length
    return states.map((s, i) => ({
      index: i,
      label: describeDelta(i > 0 ? states[i - 1] : null, s),
      current: i === cur
    }))
  }, [undoStack, redoStack, edit])

  function commitName(): void {
    saveSnapshot(draft)
    setDraft('')
    setNaming(false)
  }

  return (
    <div className="space-y-4">
      {/* Snapshots */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="lx-eyebrow">Snapshots</span>
          <button
            onClick={() => setNaming((v) => !v)}
            className="flex items-center gap-1 text-[10px] text-accent-soft transition-colors hover:text-accent"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <path d="M6 2.5v7M2.5 6h7" />
            </svg>
            New
          </button>
        </div>
        {naming && (
          <div className="lx-fade-in flex gap-1.5">
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName()
                if (e.key === 'Escape') { setNaming(false); setDraft('') }
              }}
              placeholder="Snapshot name…"
              className="flex-1 rounded-control border border-glass bg-black/25 px-2 py-1 text-[11px] text-ink placeholder:text-faint focus:border-accent/60"
            />
            <button
              onClick={commitName}
              className="rounded-control border border-accent/60 bg-accent/10 px-2.5 py-1 text-[11px] text-accent-soft transition-colors hover:bg-accent/[0.16]"
            >
              Save
            </button>
          </div>
        )}
        {snapshots.length === 0 && !naming ? (
          <p className="text-[10.5px] leading-relaxed text-faint">
            Save the current look as a snapshot to compare variations.
          </p>
        ) : (
          <div className="space-y-1">
            {snapshots.map((s) => (
              <SnapshotRow
                key={s.id}
                name={s.name}
                onApply={() => applySnapshot(s.id)}
                onRename={(n) => renameSnapshot(s.id, n)}
                onDelete={() => deleteSnapshot(s.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* History */}
      <div className="space-y-2">
        <span className="lx-eyebrow">History</span>
        <div className="max-h-52 space-y-0.5 overflow-y-auto pr-0.5">
          {timeline
            .slice()
            .reverse()
            .map((step) => (
              <button
                key={step.index}
                onClick={() => jumpToHistory(step.index)}
                className={`flex w-full items-center gap-2 rounded-control px-2 py-1 text-left text-[11px] transition-colors ${
                  step.current ? 'bg-accent/[0.09] text-accent-soft' : 'text-muted hover:bg-white/[0.04] hover:text-ink'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${step.current ? 'bg-accent' : 'bg-white/25'}`}
                />
                <span className="flex-1 truncate">{step.label}</span>
                <span className="lx-num text-[9px] text-faint">{step.index}</span>
              </button>
            ))}
        </div>
      </div>
    </div>
  )
}

function SnapshotRow({
  name,
  onApply,
  onRename,
  onDelete
}: {
  name: string
  onApply: () => void
  onRename: (name: string) => void
  onDelete: () => void
}): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  return (
    <div className="group flex items-center gap-2 rounded-control border border-glass px-2.5 py-1.5 transition-colors hover:border-white/15">
      {editing ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => { onRename(draft.trim() || name); setEditing(false) }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { onRename(draft.trim() || name); setEditing(false) }
            if (e.key === 'Escape') { setDraft(name); setEditing(false) }
          }}
          className="flex-1 rounded border border-accent/40 bg-black/30 px-1.5 py-0.5 text-[11px] text-ink focus:border-accent/60"
        />
      ) : (
        <button onClick={onApply} title="Apply snapshot" className="flex flex-1 items-center gap-2 text-left">
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" className="text-muted">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <path d="M2.5 6.5h11" />
          </svg>
          <span className="truncate text-[11.5px] text-muted">{name}</span>
        </button>
      )}
      <button
        onClick={() => setEditing(true)}
        title="Rename"
        className="text-[10px] text-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
      >
        ✎
      </button>
      <button
        onClick={onDelete}
        title="Delete snapshot"
        className="text-[11px] text-faint opacity-0 transition-opacity hover:text-accent-soft group-hover:opacity-100"
      >
        ✕
      </button>
    </div>
  )
}
