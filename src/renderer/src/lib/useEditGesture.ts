import { useCallback, useEffect, useRef } from 'react'
import { useStore } from '../store/useStore'

/** One pointer gesture is one history step, including cancel and unmount. */
export function useEditGesture(): { begin: () => boolean; end: () => void; isActive: () => boolean } {
  const active = useRef(false)
  const photo = useStore(state => state.selectedPath)
  const end = useCallback(() => {
    if (!active.current) return
    active.current = false
    useStore.getState().endEditGesture()
  }, [])
  const begin = useCallback(() => {
    const state = useStore.getState()
    if (active.current || !state.selectedPath || state.editLoading || state.syncing) return false
    active.current = true
    state.beginEditGesture()
    return true
  }, [])
  useEffect(() => end, [photo, end])
  return { begin, end, isActive: () => active.current }
}
