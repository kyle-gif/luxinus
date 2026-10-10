import { useStore } from '../store/useStore'

export const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent)
export const historyShortcuts = { undo: isMac ? '⌘Z' : 'Ctrl+Z', redo: isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z' }

export function runEditHistory(action: 'undo' | 'redo'): boolean {
  const state = useStore.getState()
  if (!state.selectedPath || state.editLoading || state.syncing || state.previewEdit || state.editGestureActive ||
    document.querySelector('[role="dialog"], [data-drag="true"]')) return false
  state[action]()
  return true
}

/** Keep native text undo, while allowing photo undo from buttons and sliders. */
export function handleEditHistoryShortcut(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.isComposing || event.altKey || !(event.metaKey || event.ctrlKey)) return false
  const key = event.key.toLowerCase()
  const action = key === 'z' ? (event.shiftKey ? 'redo' : 'undo') : key === 'y' && event.ctrlKey ? 'redo' : null
  if (!action) return false
  const target = event.target instanceof Element ? event.target : document.activeElement
  if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [aria-disabled="true"], fieldset[disabled]') || target?.matches(':disabled')) return false
  if (!runEditHistory(action)) return false
  event.preventDefault()
  return true
}
