import { useStore } from '../../store/useStore'
export function ModeSwitch(): JSX.Element {
  const mode = useStore((s) => s.mode)
  return <div className="lx-mode-switch" role="group" aria-label="보정 도구 보기">{(['simple', 'expert'] as const).map((m) => <button key={m} aria-pressed={mode === m} onClick={() => useStore.getState().setMode(m)}>{m === 'simple' ? '기본 보정' : '전체 보정'}</button>)}</div>
}
