import { useMemo, useState } from 'react'
import { useStore, selectFilteredPhotos } from '../../store/useStore'
import { Button } from '../ui/Button'
import { Thumbnail } from '../ui/Thumbnail'
import { StarRating } from '../ui/StarRating'
import { ResizeHandle } from '../ui/ResizeHandle'

// LEFT file drawer — a floating glass sheet over the photo stage: Open Folder,
// a filter bar (filename / extension / rating / flag), and the thumbnail grid.
export function FileDrawer(): JSX.Element {
  const collapsed = useStore((s) => s.drawerCollapsed)
  const toggle = useStore((s) => s.toggleDrawer)
  const width = useStore((s) => s.drawerWidth)
  const setWidth = useStore((s) => s.setDrawerWidth)
  const folderPath = useStore((s) => s.folderPath)
  const photos = useStore((s) => s.photos)
  const selectedPath = useStore((s) => s.selectedPath)
  const selection = useStore((s) => s.selection)
  const pickPhoto = useStore((s) => s.pickPhoto)
  const openFolder = useStore((s) => s.openFolder)
  const loading = useStore((s) => s.loadingLibrary)
  const filter = useStore((s) => s.filter)
  const setFilter = useStore((s) => s.setFilter)

  const visible = useStore(selectFilteredPhotos)
  const extensions = useMemo(
    () => Array.from(new Set(photos.map((p) => p.ext))).sort(),
    [photos]
  )

  if (collapsed) {
    return (
      <button
        onClick={toggle}
        title="Expand file drawer"
        className="lx-glass absolute bottom-0 left-0 top-12 z-20 flex w-9 items-center justify-center rounded-none border-y-0 border-l-0"
      >
        <span className="lx-eyebrow rotate-180 [writing-mode:vertical-rl]">library</span>
      </button>
    )
  }

  return (
    <aside
      className="lx-glass lx-fade-in absolute bottom-0 left-0 top-12 z-20 flex flex-col rounded-none border-y-0 border-l-0"
      style={{ width, animationDelay: '60ms' }}
    >
      <div className="flex items-center justify-between px-3.5 pt-3">
        <span className="lx-display text-[13px] font-semibold text-ink">Library</span>
        <button onClick={toggle} title="Collapse" className="text-muted hover:text-ink">
          ‹
        </button>
      </div>
      <div className="lx-rule mx-3.5 mt-2" />

      <div className="space-y-2.5 p-3.5">
        <Button variant="primary" className="w-full" onClick={openFolder} disabled={loading}>
          {loading ? 'Scanning…' : 'Open Folder'}
        </Button>
        {folderPath && (
          <p className="lx-num truncate text-[10px] text-faint" title={folderPath}>
            {folderPath}
          </p>
        )}

        {photos.length > 0 && (
          <div className="space-y-2 pt-1">
            {/* filename search */}
            <input
              type="text"
              value={filter.text}
              onChange={(e) => setFilter({ text: e.target.value })}
              placeholder="Filter by name…"
              className="w-full rounded-control border border-glass bg-black/25 px-2.5 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-accent/60"
            />
            <div className="flex items-center gap-2">
              {/* extension */}
              <select
                value={filter.ext}
                onChange={(e) => setFilter({ ext: e.target.value })}
                className="flex-1 rounded-control border border-glass bg-black/25 px-2 py-1 text-[11px] text-muted focus:border-accent/60"
              >
                <option value="all">All types</option>
                {extensions.map((ext) => (
                  <option key={ext} value={ext}>
                    {ext.replace('.', '').toUpperCase()}
                  </option>
                ))}
              </select>
              {/* flagged only */}
              <button
                onClick={() => setFilter({ flaggedOnly: !filter.flaggedOnly })}
                title="Show flagged only"
                className={`rounded-control border px-2 py-1 text-[11px] transition-colors ${
                  filter.flaggedOnly
                    ? 'border-accent/60 bg-accent/10 text-accent-soft'
                    : 'border-glass text-muted hover:text-ink'
                }`}
              >
                ⚑ Flag
              </button>
            </div>
            {/* min rating */}
            <div className="flex items-center justify-between">
              <span className="lx-eyebrow">min rating</span>
              <div className="flex items-center gap-1.5">
                <StarRating
                  rating={filter.minRating}
                  interactive
                  size={12}
                  onChange={(r) => setFilter({ minRating: r })}
                />
                {filter.minRating > 0 && (
                  <button
                    onClick={() => setFilter({ minRating: 0 })}
                    className="text-[10px] text-faint hover:text-ink"
                  >
                    clear
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Thumbnail grid */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-3.5">
        {photos.length === 0 ? (
          <p className="mt-6 text-center text-[12px] leading-relaxed text-faint">
            No folder open.
            <br />
            Open one to begin.
          </p>
        ) : visible.length === 0 ? (
          <p className="mt-6 text-center text-[12px] leading-relaxed text-faint">
            No photos match the filter.
          </p>
        ) : (
          <>
            <p className="lx-eyebrow mb-2">
              {visible.length} of {photos.length}
            </p>
            <div className="grid grid-cols-2 gap-2">
              {visible.map((p) => (
                <Thumbnail
                  key={p.filePath}
                  photo={p}
                  active={selectedPath === p.filePath}
                  selected={selection.has(p.filePath)}
                  onClick={(m) => pickPhoto(p.filePath, { meta: m.metaKey || m.ctrlKey, shift: m.shiftKey })}
                  className="aspect-square"
                />
              ))}
            </div>
          </>
        )}
      </div>

      <BatchSyncBar />

      <ResizeHandle side="right" compute={(x) => (isNaN(x) ? 288 : x)} onResize={setWidth} />
    </aside>
  )
}

// Batch sync — appears when 2+ photos are selected. Copies the active photo's
// develop settings (minus framing) onto the others' sidecars.
function BatchSyncBar(): JSX.Element | null {
  const count = useStore((s) => s.selection.size)
  const syncing = useStore((s) => s.syncing)
  const sync = useStore((s) => s.syncEditToSelection)
  const clear = useStore((s) => s.clearSelection)
  const [done, setDone] = useState<number | null>(null)

  if (count < 2) return null
  const others = count - 1

  async function run(): Promise<void> {
    const n = await sync()
    setDone(n)
    window.setTimeout(() => setDone(null), 2200)
  }

  return (
    <div className="lx-fade-in border-t border-glass bg-black/25 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="lx-eyebrow text-accent-soft">{count} selected</span>
        <button onClick={clear} className="text-[10px] text-faint transition-colors hover:text-ink">
          clear
        </button>
      </div>
      <button
        onClick={() => void run()}
        disabled={syncing}
        className="flex w-full items-center justify-center gap-2 rounded-control border border-accent/50 bg-accent/[0.08] py-2 text-[11px] font-medium text-accent-soft transition-colors hover:bg-accent/[0.14] disabled:opacity-50"
      >
        {syncing ? (
          'Syncing…'
        ) : done != null ? (
          `Synced to ${done} photo${done === 1 ? '' : 's'}`
        ) : (
          <>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8a6 6 0 0 1 10-4.5M14 8a6 6 0 0 1-10 4.5" />
              <path d="M12 2v3H9M4 14v-3h3" />
            </svg>
            Sync settings to {others} photo{others === 1 ? '' : 's'}
          </>
        )}
      </button>
      <p className="mt-1.5 text-center text-[9.5px] leading-tight text-faint">
        ⌘/Ctrl-click or Shift-click thumbnails to select. Framing stays per-photo.
      </p>
    </div>
  )
}
