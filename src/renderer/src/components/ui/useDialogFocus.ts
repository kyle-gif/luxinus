import { useEffect, useRef } from 'react'
/** Local modal focus containment, Escape and focus restoration. */
export function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!open) return
    const previous = document.activeElement as HTMLElement | null
    const modal = ref.current
    if (!modal) return
    const selector = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'
    const controls = (): HTMLElement[] => Array.from(modal.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.matches(':disabled') && el.getClientRects().length > 0)
    ;(controls()[0] ?? modal).focus()
    function key(event: KeyboardEvent): void {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return }
      if (event.key !== 'Tab') return
      const targets = controls()
      const first = targets[0], last = targets[targets.length - 1]
      if (!first) { event.preventDefault(); modal?.focus(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === modal)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    modal.addEventListener('keydown', key)
    return () => { modal.removeEventListener('keydown', key); if (previous?.isConnected) previous.focus() }
  }, [open])
  return ref
}
