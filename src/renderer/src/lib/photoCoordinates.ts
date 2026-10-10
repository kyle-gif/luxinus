import type { EditState } from '../../../shared/edits'

export interface PhotoPoint { x: number; y: number }
type PhotoGeometry = Pick<EditState, 'crop' | 'rotate' | 'flipH' | 'flipV'>
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value))

/**
 * Match editShader.mapCoord: view UV (top-left origin) -> source UV. The shader
 * crops before rotating around the source center, scales by its cover factor,
 * then flips and clamps. GLSL mat2 is column-major, so positive angles map
 * (x,y) to (cos*x + sin*y, -sin*x + cos*y), not CSS's forward rotation.
 * Pan and zoom are removed by normalizing the click against the displayed
 * image's getBoundingClientRect before calling this function.
 */
export function viewToSource(point: PhotoPoint, edit: PhotoGeometry, sourceAspect: number): PhotoPoint {
  if (!Number.isFinite(sourceAspect) || sourceAspect <= 0 || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new Error('사진 좌표가 유효하지 않습니다.')
  const crop = edit.crop ?? { x: 0, y: 0, w: 1, h: 1 }
  let x = crop.x + point.x * crop.w
  let y = crop.y + point.y * crop.h
  const angle = edit.rotate * Math.PI / 180
  if (Math.abs(angle) > .0001) {
    const px = (x - .5) * sourceAspect
    const py = y - .5
    const sin = Math.sin(angle), cos = Math.cos(angle)
    const cover = Math.abs(sin) * (sourceAspect > 1 ? 1 / sourceAspect : sourceAspect) + Math.abs(cos)
    x = (cos * px + sin * py) / cover / sourceAspect + .5
    y = (-sin * px + cos * py) / cover + .5
  }
  return { x: clamp01(edit.flipH ? 1 - x : x), y: clamp01(edit.flipV ? 1 - y : y) }
}
