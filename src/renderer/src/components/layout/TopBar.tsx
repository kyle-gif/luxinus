import { useStore } from '../../store/useStore'
import { Button } from '../ui/Button'
import { ApertureMark } from '../ui/ApertureMark'
import { ModeSwitch } from '../ui/ModeSwitch'

// macOS draws its traffic lights on top of our frameless bar; reserve space on
// the left so the logo clears them.
const isMac =
  typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)

// Floating top bar. The whole bar is a window drag region (.lx-drag); every
// control opts back out (.lx-no-drag). Mode toggle uses a pink hairline + pink
// label on the active segment — never a solid pink block. Export is outlined.
export function TopBar(): JSX.Element {
  const hasPhoto = useStore((s) => s.selectedPath !== null)

  return (
    <header
      className="lx-glass lx-drag absolute inset-x-0 top-0 z-30 flex h-12 items-center justify-between rounded-none border-x-0 border-t-0 pr-4"
      style={{ paddingLeft: isMac ? 84 : 16 }}
    >
      {/* Logo */}
      <div className="flex items-center gap-2.5">
        <ApertureMark size={18} />
        <span className="lx-display text-[16px] font-semibold text-ink">Luxinus</span>
        <span className="lx-eyebrow ml-1 rounded-full border border-glass px-2 py-0.5">
          on-device
        </span>
      </div>

      {/* Mode switch — absolutely centered in the header, independent of the
          logo/export widths on either side. */}
      <div className="lx-no-drag absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <ModeSwitch />
      </div>

      {/* Export */}
      <Button
        variant="primary"
        className="lx-no-drag"
        disabled={!hasPhoto}
        title={hasPhoto ? 'Export photo' : 'Open a photo first'}
        onClick={() => useStore.getState().setExportOpen(true)}
      >
        Export
      </Button>
    </header>
  )
}
