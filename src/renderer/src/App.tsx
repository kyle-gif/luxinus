import { useEffect } from 'react'
import { TopBar } from './components/layout/TopBar'
import { FileDrawer } from './components/layout/FileDrawer'
import { Stage } from './components/layout/Stage'
import { EditPanel } from './components/layout/EditPanel'
import { Filmstrip } from './components/layout/Filmstrip'
import { GlassFilters } from './components/ui/GlassFilters'
import { LiquidGlass } from './components/ui/LiquidGlass'
import { ExportDialog } from './components/ui/ExportDialog'
import { useStore } from './store/useStore'

// Layout: a single full-bleed image STAGE with floating glass panels laid over
// it, so the frosted panels refract the photo/backdrop beneath.
//   ┌ TopBar (floating) ───────────────────────────────────┐
//   │ Drawer │            Stage (photo)            │ Edit   │  ← panels overlay
//   │ (float)│                                     │ (float)│    the stage edges
//   └────────────── Filmstrip (floating) ──────────────────┘
export default function App(): JSX.Element {
  useThumbnailStream()
  useEffect(() => {
    // Dev-only design preview; dynamic import is tree-shaken from production.
    if (import.meta.env.DEV) void import('./dev/preview').then((m) => m.enablePreview())
  }, [])
  return (
    <div className="relative h-full w-full overflow-hidden bg-base text-ink">
      <GlassFilters />
      <LiquidGlass />
      <Stage />
      <TopBar />
      <FileDrawer />
      <EditPanel />
      <Filmstrip />
      <ExportDialog />
    </div>
  )
}

// Thumbnails decode in the utility process and stream in one at a time; apply
// each to its photo as it arrives so the grid fills progressively.
function useThumbnailStream(): void {
  useEffect(() => {
    if (typeof window === 'undefined' || !window.luxinus) return
    return window.luxinus.library.onThumbnail((payload) => {
      useStore.getState().applyThumbnail(payload.filePath, payload.webp, payload.meta)
    })
  }, [])
}
