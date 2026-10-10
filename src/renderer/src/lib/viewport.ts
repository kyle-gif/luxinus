export interface Viewport { z: number; x: number; y: number }
export interface ViewportPoint { x: number; y: number }
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 12
export const FIT_VIEW: Viewport = { z: 1, x: 0, y: 0 }

/** Coordinates are CSS pixels relative to the photo area's centre. */
export function zoomAt(view: Viewport, zoom: number, anchor: ViewportPoint): Viewport {
  if (!Number.isFinite(zoom) || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return view
  const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
  if (z === view.z) return view
  return { z, x: anchor.x - (anchor.x - view.x) * z / view.z, y: anchor.y - (anchor.y - view.y) * z / view.z }
}

export interface ViewportWheel {
  deltaX: number; deltaY: number; deltaMode: number
  shiftKey: boolean; ctrlKey: boolean; metaKey: boolean
}

/** Keep both axes from trackpads; line/page mouse wheels use CSS-pixel units. */
export function wheelDelta(event: ViewportWheel, page: { width: number; height: number }): ViewportPoint {
  const x = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.width : 1)
  const y = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page.height : 1)
  // Chromium already remaps some Shift-wheel devices to deltaX. Don't add twice.
  return event.shiftKey ? { x: x || y, y: 0 } : { x, y }
}

export function wheelView(view: Viewport, event: ViewportWheel, anchor: ViewportPoint, page: { width: number; height: number }): Viewport {
  const delta = wheelDelta(event, page)
  if (!Number.isFinite(delta.x) || !Number.isFinite(delta.y)) return view
  if (event.ctrlKey || event.metaKey) {
    const amount = event.shiftKey ? delta.x : delta.y
    const factor = Math.min(2.2, Math.max(0.45, Math.exp(-amount * 0.006)))
    return zoomAt(view, view.z * factor, anchor)
  }
  return { ...view, x: view.x - delta.x, y: view.y - delta.y }
}

export function containPhoto(frame: { width: number; height: number }, aspect: number): { width: number; height: number } {
  const width = Math.max(1, Math.min(frame.width, frame.height * aspect))
  return { width, height: width / aspect }
}
