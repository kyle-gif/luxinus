import { useCallback, useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { FIT_VIEW, wheelView, zoomAt } from './viewport'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

function isControl(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input,textarea,select,button,[contenteditable="true"],[role="slider"],[role="dialog"]')
}

/** View-only navigation. Capture handlers reserve hand gestures before edit overlays. */
export function useViewport(photoId: string | null) {
  const areaRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ ...FIT_VIEW })
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [panning, setPanning] = useState(false)
  const spaceRef = useRef(false)
  const pan = useRef<{ id: number; x: number; y: number } | null>(null)
  const suppressClick = useRef(false)
  const requestedView = useWorkspaceStore(state => state.viewRequest)
  const fit = useCallback(() => setView({ ...FIT_VIEW }), [])
  const finishPan = useCallback(() => {
    const pointer = pan.current
    pan.current = null
    setPanning(false)
    if (pointer && areaRef.current?.hasPointerCapture(pointer.id)) areaRef.current.releasePointerCapture(pointer.id)
  }, [])
  const clearInput = useCallback(() => {
    spaceRef.current = false
    setSpaceHeld(false)
    finishPan()
  }, [finishPan])

  useEffect(() => { fit(); clearInput() }, [photoId, fit, clearInput])
  useEffect(() => {
    if (!photoId || !requestedView) return
    setView(current => requestedView.zoom === 1 ? { ...FIT_VIEW } : zoomAt(current, requestedView.zoom, { x: 0, y: 0 }))
    // A request survives library -> Stage mounting, then is consumed once. A
    // newer request arriving before this effect must remain pending.
    useWorkspaceStore.setState(state => state.viewRequest === requestedView ? { viewRequest: null } : {})
  }, [photoId, requestedView])
  useEffect(() => {
    const area = areaRef.current
    if (!area) return
    const wheel = (event: WheelEvent): void => {
      if (!photoId || document.querySelector('[role="dialog"]')) return
      event.preventDefault()
      const rect = area.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 }
      setView(current => wheelView(current, event, anchor, rect))
    }
    area.addEventListener('wheel', wheel, { passive: false })
    return () => area.removeEventListener('wheel', wheel)
  }, [photoId])
  useEffect(() => {
    const down = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
          document.querySelector('[role="dialog"]') || !photoId) return
      if (event.code === 'Space') {
        if (isControl(event.target)) return
        event.preventDefault()
        spaceRef.current = true
        setSpaceHeld(true)
      } else if (event.code === 'Digit1' && event.shiftKey) {
        if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable="true"]')) return
        event.preventDefault()
        fit()
      }
    }
    const up = (event: KeyboardEvent): void => {
      if (event.code !== 'Space') return
      spaceRef.current = false
      setSpaceHeld(false)
    }
    const visibility = (): void => { if (document.hidden) clearInput() }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clearInput)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clearInput)
      document.removeEventListener('visibilitychange', visibility)
      clearInput()
    }
  }, [photoId, fit, clearInput])

  function onPointerDownCapture(event: PointerEvent<HTMLDivElement>): void {
    if (!photoId) return
    areaRef.current?.focus({ preventScroll: true })
    suppressClick.current = false
    if (pan.current || !(event.button === 1 || (event.button === 0 && spaceRef.current))) return
    event.preventDefault()
    event.stopPropagation()
    suppressClick.current = true
    pan.current = { id: event.pointerId, x: event.clientX, y: event.clientY }
    setPanning(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  function onPointerMoveCapture(event: PointerEvent<HTMLDivElement>): void {
    const pointer = pan.current
    if (!pointer || pointer.id !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    if (!event.buttons) { finishPan(); return }
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y
    pointer.x = event.clientX; pointer.y = event.clientY
    setView(current => ({ ...current, x: current.x + dx, y: current.y + dy }))
  }
  function onPointerEnd(event: PointerEvent<HTMLDivElement>): void {
    if (pan.current?.id !== event.pointerId) return
    event.preventDefault()
    event.stopPropagation()
    finishPan()
  }
  function onClickCapture(event: MouseEvent<HTMLDivElement>): void {
    if (suppressClick.current || spaceRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  return {
    areaRef, view, fit, spaceHeld, panning,
    zoom: (factor: number) => setView(current => zoomAt(current, current.z * factor, { x: 0, y: 0 })),
    handlers: { onPointerDownCapture, onPointerMoveCapture, onPointerUpCapture: onPointerEnd,
      onPointerCancelCapture: onPointerEnd, onLostPointerCapture: onPointerEnd, onClickCapture,
      onAuxClick: (event: MouseEvent<HTMLDivElement>) => { if (event.button === 1) event.preventDefault() } }
  }
}
