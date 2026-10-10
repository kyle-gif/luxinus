import type { AgentAppAction } from '../../../shared/agent-tools'
import { MASK_ADJUST_KEYS, type EditState, type Mask } from '../../../shared/edits'
import { AGENT_CONTROLS } from '../../../shared/local-agent'

const labels: Record<string, string> = { ...Object.fromEntries(Object.entries(AGENT_CONTROLS).map(([key, value]) => [key, value.label])),
  denoise: '노이즈 제거', rotate: '수평 각도', flipH: '좌우 뒤집기', flipV: '상하 뒤집기', crop: '자르기', curves: '밝기 곡선', hsl: '색상별 조정', colorGrade: '색감 조정', masks: '부분 보정' }
function showValue(key: string, value: unknown): string {
  if (typeof value === 'boolean') return value ? '켜짐' : '꺼짐'
  if (typeof value === 'number') return `${Math.round(value * 100) / 100}${key === 'rotate' ? '°' : ''}`
  if (value === null) return '없음'
  if (key === 'crop') { const crop = value as NonNullable<EditState['crop']>; return `${Math.round(crop.w * 100)}×${Math.round(crop.h * 100)}% · 위치 ${Math.round(crop.x * 100)},${Math.round(crop.y * 100)}%` }
  if (Array.isArray(value)) return `${value.length}개`
  return '사용자 설정'
}
export function editChanges(before: EditState, after: EditState): { key: string; label: string; before: string; after: string }[] {
  const changes: { key: string; label: string; before: string; after: string }[] = []
  const walk = (a: unknown, b: unknown, path: string, label: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return
    if (path === 'masks' && Array.isArray(a) && Array.isArray(b)) {
      const oldMasks = a as Mask[], newMasks = b as Mask[]
      for (const mask of newMasks) {
        const previous = oldMasks.find(item => item.id === mask.id)
        const title = `부분 보정 · ${mask.name}`
        if (!previous) changes.push({ key: `masks.${mask.id}`, label: title, before: '없음', after: '선택 영역 추가' })
        else {
          if (previous.name !== mask.name) changes.push({ key: `masks.${mask.id}.name`, label: '선택 영역 이름', before: previous.name, after: mask.name })
          if (previous.enabled !== mask.enabled) changes.push({ key: `masks.${mask.id}.enabled`, label: title, before: previous.enabled ? '켜짐' : '꺼짐', after: mask.enabled ? '켜짐' : '꺼짐' })
          if ((previous.density ?? 1) !== (mask.density ?? 1)) changes.push({ key: `masks.${mask.id}.density`, label: `${title} · 적용 강도`, before: `${Math.round((previous.density ?? 1) * 100)}%`, after: `${Math.round((mask.density ?? 1) * 100)}%` })
          const geometry = ({ id: _id, name: _name, adjust: _adjust, enabled: _enabled, density: _density, ...shape }: Mask): string => JSON.stringify(shape)
          if (geometry(previous) !== geometry(mask)) changes.push({ key: `masks.${mask.id}.shape`, label: title, before: '기존 선택 영역', after: '선택 범위 변경' })
        }
        for (const key of MASK_ADJUST_KEYS) {
          const before = previous?.adjust[key] ?? 0, after = mask.adjust[key] ?? 0
          if (before !== after) changes.push({ key: `masks.${mask.id}.${key}`, label: `${title} · ${labels[key] ?? (key === 'sharpness' ? '선명도' : key)}`, before: showValue(key, before), after: showValue(key, after) })
        }
      }
      for (const mask of oldMasks) if (!newMasks.some(item => item.id === mask.id)) changes.push({ key: `masks.${mask.id}`, label: `부분 보정 · ${mask.name}`, before: '선택됨', after: '삭제' })
      return
    }
    if (b && a && typeof b === 'object' && typeof a === 'object' && !Array.isArray(b) && !Array.isArray(a) && path !== 'crop') {
      const names: Record<string, string> = { rgb: '전체', r: '빨강', g: '초록', b: '파랑', red: '빨강', orange: '주황', yellow: '노랑', green: '초록', aqua: '청록', blue: '파랑', purple: '보라', magenta: '자홍', hue: '색상', sat: '채도', lum: '밝기', shadows: '어두운 부분', midtones: '중간 밝기', highlights: '밝은 부분', global: '전체', blending: '혼합', balance: '균형' }
      for (const key of Object.keys(b)) walk((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], `${path}.${key}`, `${label} · ${names[key] ?? key}`)
      return
    }
    // Curves and masks need meaningful details even when their item count stays equal.
    const arraySummary = (value: unknown): string => Array.isArray(value) ? value.map(item => {
      if (item && typeof item === 'object' && 'x' in item && 'y' in item) return `${Math.round(item.x * 100)}:${Math.round(item.y * 100)}`
      if (item && typeof item === 'object' && 'name' in item) return String(item.name)
      return '항목'
    }).join(', ') || '없음' : showValue(path, value)
    changes.push({ key: path, label, before: Array.isArray(a) ? arraySummary(a) : showValue(path, a), after: Array.isArray(b) ? arraySummary(b) : showValue(path, b) })
    if (path === 'masks' && Array.isArray(b) && Array.isArray(a) && a.length === b.length && arraySummary(a) === arraySummary(b)) {
      changes[changes.length - 1].after += ' · 모양/보정값 변경'
    }
  }
  for (const key of Object.keys(after) as (keyof EditState)[]) walk(before[key], after[key], key, labels[key] ?? key)
  return changes
}
export function describeAgentAction(action: AgentAppAction): string {
  switch (action.kind) {
    case 'selectPhoto': return '공유한 목록에서 요청한 사진 선택'
    case 'setRating': return `현재 사진 별점 ${action.rating}개`
    case 'setFlag': return action.flagged ? '현재 사진에 표시 남기기' : '현재 사진 표시 해제'
    case 'setFilter': return `사진 목록 필터 변경${action.filter.minRating !== undefined ? ` · 별점 ${action.filter.minRating}개 이상` : ''}${action.filter.text !== undefined ? ` · 검색 “${action.filter.text}”` : ''}${action.filter.ext ? ` · ${action.filter.ext === 'all' ? '모든 형식' : action.filter.ext.toUpperCase()}` : ''}${action.filter.flaggedOnly !== undefined ? action.filter.flaggedOnly ? ' · 표시한 사진만' : ' · 표시 여부 전체' : ''}`
    case 'setSort': return `사진 정렬 · ${{ name: '이름', date: '촬영일', rating: '별점' }[action.sort]}`
    case 'setWorkspace': return action.workspace === 'library' ? '사진 목록 열기' : '사진 편집 열기'
    case 'setEditorMode': return action.mode === 'simple' ? '기본 보정 보기' : '전체 보정 보기'
    case 'openPanel': return `${{ adjust: '직접 조정', crop: '자르기·수평', masks: '부분 보정', presets: '프리셋', history: '편집 기록', export: '내보내기 설정', settings: 'AI 설정', info: '사진 정보' }[action.panel]} 열기`
    case 'history': return action.direction === 'undo' ? '마지막 보정 실행 취소' : '취소한 보정 다시 실행'
    case 'setView': return action.zoom === 1 ? '사진을 화면에 맞추기' : `사진 확대 배율 ${action.zoom}배`
    case 'setCompare': return `사진 보기 · ${{ before: '보정 전', edited: '현재 보정', split: '전후 비교' }[action.mode]}`
    case 'setClipping': return action.enabled ? '너무 밝거나 어두운 부분 표시' : '밝기 경고 표시 끄기'
    case 'setBackground': return `사진 배경 · ${{ dark: '어두움', gray: '회색', light: '밝음' }[action.background]}`
    case 'setFilmstrip': return action.visible ? '하단 사진 목록 열기' : '하단 사진 목록 접기'
    case 'setPhotoOnly': return action.enabled ? '사진만 크게 보기' : '사진만 보기 종료'
  }
}
