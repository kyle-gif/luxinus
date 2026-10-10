import { useEffect, useState } from 'react'
import { useStore } from '../../store/useStore'
import { Button } from '../ui/Button'
import { Slider } from '../ui/Slider'
import { Histogram } from '../ui/Histogram'
import { ToneCurve } from '../ui/ToneCurve'
import { HslMixer } from '../ui/HslMixer'
import { ColorGradePanel } from '../ui/ColorGradePanel'
import { MasksPanel } from '../ui/MasksPanel'
import { PresetsPanel } from '../ui/PresetsPanel'
import { HistoryPanel } from '../ui/HistoryPanel'
import { ResizeHandle } from '../ui/ResizeHandle'
import { computeAutoEnhance } from '../../lib/autoEnhance'
import { defaultEditState, type EditState } from '../../types'
import { ModeSwitch } from '../ui/ModeSwitch'
import { CropBar } from '../ui/CropBar'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'
import { historyShortcuts, isMac, runEditHistory } from '../../lib/editShortcuts'

// RIGHT edit panel. Simple mode: Auto Enhance + 4 large controls. Expert mode:
// the full develop stack in collapsible sections, all driving the WebGL preview.
export function EditPanel(): JSX.Element {
  const mode = useStore((s) => s.mode)
  const hasPhoto = useStore((s) => s.selectedPath !== null)
  const edit = useStore((s) => s.edit)
  const setEdit = useStore((s) => s.setEdit)
  const resetEdit = useStore((s) => s.resetEdit)
  const canUndo = useStore((s) => s.undoStack.length > 0)
  const canRedo = useStore((s) => s.redoStack.length > 0)
  const syncing = useStore((s) => s.syncing)
  const previewing = useStore((s) => !!s.previewEdit)
  const maskMode = useStore((s) => s.maskMode)
  const setMaskMode = useStore((s) => s.setMaskMode)
  const editLoading = useStore((s) => s.editLoading)
  const cropMode = useStore((s) => s.cropMode)
  const photoMeta = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath)?.meta)
  const tab = useWorkspaceStore((s) => s.editPanelTab)
  const setTab = useWorkspaceStore((s) => s.setEditPanelTab)
  const setPanelWidth = useStore((s) => s.setPanelWidth)

  const set = (key: keyof EditState) => (v: number) => setEdit({ [key]: v })
  const title = maskMode ? '부분 보정' : cropMode ? '자르기·수평' : '사진 보정'
  const historyDisabled = !hasPhoto || editLoading || syncing || previewing

  return (
    <aside
      className="lx-edit-panel" aria-label="사진 보정 도구"
    >
      <ResizeHandle
        side="left"
        compute={(x) => (isNaN(x) ? 320 : window.innerWidth - x)}
        onResize={setPanelWidth}
      />
      <div className="flex items-center justify-between px-4 pt-3">
        <span className="lx-display text-[13px] font-semibold text-ink">{title}</span>
        <div className="flex items-center gap-3">
          {maskMode ? <button className="text-[12px] text-accent" onClick={() => setMaskMode(false)}>부분 보정 완료</button>
            : <button onClick={resetEdit} disabled={historyDisabled} className="text-[12px] text-muted hover:text-ink disabled:opacity-40">보정 초기화</button>}
          <button aria-label="보정 도구 접기" title="보정 도구 접기" onClick={() => useWorkspaceStore.getState().togglePanel()} className="text-muted px-1">›</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 px-3 pt-3 pb-1">
        {(['undo', 'redo'] as const).map((action) => <button key={action} type="button"
          aria-label={action === 'undo' ? '실행 취소' : '다시 실행'}
          aria-keyshortcuts={`${isMac ? 'Meta' : 'Control'}+${action === 'redo' ? 'Shift+' : ''}Z`}
          title={`${action === 'undo' ? '마지막 보정 실행 취소' : '취소한 보정 다시 실행'} (${historyShortcuts[action]})`}
          disabled={historyDisabled || !(action === 'undo' ? canUndo : canRedo)} onClick={() => runEditHistory(action)}
          className="flex items-center justify-between gap-2 rounded-control border border-glass px-2 py-2 text-[12px] text-ink disabled:opacity-35">
          <span>{action === 'undo' ? '↶ 실행 취소' : '↷ 다시 실행'}</span><kbd className="text-muted">{historyShortcuts[action]}</kbd>
        </button>)}
      </div>
      <div className="lx-rule mx-4 mt-2" />

      {!hasPhoto ? (
        <p className="p-8 text-center text-[12px] leading-relaxed text-faint">
          사진을 선택해 보정을 시작하세요.
        </p>
      ) : (
        <fieldset disabled={editLoading || syncing} className="min-w-0 min-h-0 flex-1 overflow-y-auto p-3">{editLoading && <p role="status" className="mb-3 text-muted">저장된 보정을 읽는 중…</p>}
          <details open className="mb-3"><summary className="pb-2 text-[12px] text-muted cursor-pointer">히스토그램</summary><Histogram /></details>
          <ToolStrip />
          {cropMode ? <div className="pt-4"><CropBar imgAspect={photoMeta?.width && photoMeta.height ? photoMeta.width / photoMeta.height : 1.5} /></div> : maskMode ? <div className="pt-3"><MasksPanel /></div> : <>
            <div className="lx-panel-tabs" role="tablist" aria-label="보정 내용">{([['adjust', '직접 조정'], ['presets', '프리셋'], ['history', '편집 기록']] as const).map(([id, label]) => <button role="tab" aria-selected={tab === id} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
            {tab === 'adjust' ? <><div className="flex justify-end py-3"><ModeSwitch /></div>{mode === 'simple' ? <SimpleControls /> : <ExpertControls set={set} edit={edit} />}</> : tab === 'presets' ? <PresetsPanel /> : <HistoryPanel />}
          </>}
        </fieldset>
      )}
    </aside>
  )
}

// Lightroom-style tool strip: dedicated Crop and Masking workspaces.
function ToolStrip(): JSX.Element {
  const setCropMode = useStore((s) => s.setCropMode)
  const setMaskMode = useStore((s) => s.setMaskMode)
  const cropMode = useStore((s) => s.cropMode)
  const maskMode = useStore((s) => s.maskMode)
  const maskCount = useStore((s) => s.edit.masks.length)
  return (
    <div className="grid grid-cols-2 gap-2">
      <ToolButton
        active={cropMode}
        onClick={() => setCropMode(!cropMode)}
        label="자르기·수평"
        badge={null}
      >
        <path d="M4.5 1v10.5H15" />
        <path d="M1 4.5h10.5V15" />
      </ToolButton>
      <ToolButton active={maskMode} onClick={() => setMaskMode(!maskMode)} label="부분 보정" badge={maskCount || null}>
        <circle cx="6" cy="7" r="4" />
        <circle cx="10.5" cy="9.5" r="4" opacity="0.55" />
      </ToolButton>
    </div>
  )
}

function ToolButton({
  active,
  onClick,
  label,
  badge,
  children
}: {
  active: boolean
  onClick: () => void
  label: string
  badge: number | null
  children: React.ReactNode
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`relative flex items-center justify-center gap-2 rounded-control border py-2.5 text-[12px] transition-colors ${
        active
          ? 'border-accent/60 bg-accent/10 text-accent-soft'
          : 'border-glass bg-white/[0.02] text-muted hover:border-accent/40 hover:text-ink'
      }`}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
      {label}
      {badge != null && (
        <span className="lx-num absolute right-1.5 top-1.5 rounded-full bg-accent/20 px-1.5 text-[12px] text-accent-soft">
          {badge}
        </span>
      )}
    </button>
  )
}

function SimpleControls(): JSX.Element {
  const edit = useStore((s) => s.edit)
  const setEdit = useStore((s) => s.setEdit)
  const applyEdit = useStore((s) => s.applyEdit)
  const photo = useStore((s) => s.photos.find((p) => p.filePath === s.selectedPath) ?? null)
  const proxyUrl = useStore((s) => (s.proxy.status === 'ready' ? s.proxy.url : null))
  const [autoError, setAutoError] = useState<string | null>(null)
  const set = (key: keyof EditState) => (v: number) => setEdit({ [key]: v })

  function runAutoEnhance(): void {
    if (!proxyUrl) return
    const path = photo?.filePath
    setAutoError(null)
    computeAutoEnhance(proxyUrl, edit, photo?.meta ?? null)
      .then((next) => { if (useStore.getState().selectedPath === path) applyEdit(next) })
      .catch((error) => { if (useStore.getState().selectedPath === path) setAutoError(error instanceof Error ? error.message : String(error)) })
  }

  return (
    <>
      <Button variant="primary" className="w-full justify-center" onClick={runAutoEnhance} disabled={!proxyUrl}>
        밝기 자동 보정
      </Button>
      {autoError && <p role="alert" className="py-2 text-[12px] text-red-300">{autoError}</p>}
      <div className="space-y-5 pt-1">
        <Slider label="노출" size="lg" value={edit.exposure} onChange={set('exposure')} />
        <Slider label="대비" size="lg" value={edit.contrast} onChange={set('contrast')} />
        <Slider label="채도" size="lg" value={edit.saturation} onChange={set('saturation')} />
        <DenoiseControl edit={edit} set={set} />
      </div>

    </>
  )
}

function ExpertControls({
  set,
  edit
}: {
  set: (key: keyof EditState) => (v: number) => void
  edit: EditState
}): JSX.Element {
  return (
    <>
      <Section title="밝기" defaultOpen>
        <Slider label="노출" value={edit.exposure} onChange={set('exposure')} />
        <Slider label="대비" value={edit.contrast} onChange={set('contrast')} />
        <Slider label="밝은 부분" value={edit.highlights} onChange={set('highlights')} />
        <Slider label="어두운 부분" value={edit.shadows} onChange={set('shadows')} />
        <Slider label="흰색" value={edit.whites} onChange={set('whites')} />
        <Slider label="검은색" value={edit.blacks} onChange={set('blacks')} />
      </Section>

      <Section title="톤 커브">
        <ToneCurve />
      </Section>

      <Section title="색상">
        <WbPicker />
        <Slider label="색온도" gradient="temp" value={edit.temperature} onChange={set('temperature')} />
        <Slider label="색조" gradient="tint" value={edit.tint} onChange={set('tint')} />
        <Slider label="채도" gradient="sat" value={edit.saturation} onChange={set('saturation')} />
        <Slider label="색 생동감" value={edit.vibrance} onChange={set('vibrance')} />
      </Section>

      <Section title="색상별 조정">
        <HslMixer />
      </Section>

      <Section title="영역별 색감">
        <ColorGradePanel />
      </Section>

      <Section title="선명도">
        <Slider label="질감" value={edit.texture} onChange={set('texture')} />
        <Slider label="부분 대비" value={edit.clarity} onChange={set('clarity')} />
        <Slider label="안개 제거" value={edit.dehaze} onChange={set('dehaze')} />
        <Slider label="선명도" min={0} max={100} value={edit.sharpening} onChange={set('sharpening')} />
        <DenoiseControl edit={edit} set={set} />
      </Section>

      <Section title="효과">
        <Slider label="가장자리 밝기" value={edit.vignette} onChange={set('vignette')} />
        <Slider label="필름 입자" min={0} max={100} value={edit.grain} onChange={set('grain')} />
      </Section>

    </>
  )
}

// AI denoise: the strength slider blends a restored copy of the source (computed
// on demand — inference is slow, so it runs behind a progress bar).
function DenoiseControl({
  edit,
  set
}: {
  edit: EditState
  set: (key: keyof EditState) => (v: number) => void
}): JSX.Element {
  const dp = useStore((s) => s.denoiseProxy)
  const selectedPath = useStore((s) => s.selectedPath)
  const runDenoise = useStore((s) => s.runDenoise)
  const ready = dp.status === 'ready' && dp.filePath === selectedPath
  const running = dp.status === 'running'

  return (
    <div className="space-y-2.5">
      <p className="text-[12px] text-muted">NAFNet SIDD로 사진의 노이즈를 줄입니다. 완료된 결과는 이 컴퓨터에 자동 저장됩니다.</p>
      <Slider label="노이즈 제거 강도" min={0} max={100} value={edit.denoise} onChange={set('denoise')} />
      {running ? (
        <div className="space-y-1.5">
          <div className="h-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(dp.progress * 100)}%` }} />
          </div>
          <div className="flex items-center justify-between"><p role="status" className="lx-num text-[12px] text-muted">노이즈 제거 중… {Math.round(dp.progress * 100)}%</p><button className="text-[12px] underline text-muted" onClick={() => useStore.getState().clearDenoise()}>중단</button></div>
        </div>
      ) : (!ready || dp.cacheStatus === 'error') ? (
        <button
          onClick={() => void runDenoise()}
          className="flex w-full items-center justify-center gap-1.5 rounded-control border border-accent/40 bg-accent/[0.06] py-1.5 text-[12px] text-accent-soft transition-colors hover:bg-accent/[0.12]"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1l1.6 4.2L14 6.4l-3.3 3 .9 4.6L8 11.8 4.4 14l.9-4.6L2 6.4l4.4-1.2z" /></svg>
          {ready ? '복원 결과 저장 재시도' : '노이즈 제거 (NAFNet SIDD)'}
        </button>
      ) : null}
      {ready && <>
        <p role="status" className="text-[12px] text-muted">{dp.cacheStatus === 'stored' ? '복원 결과를 이 컴퓨터에 저장했습니다.' : dp.cacheStatus === 'hit' ? '저장된 복원 결과를 불러왔습니다.' : dp.cacheStatus === 'error' ? `복원은 완료했지만 저장하지 못했습니다. ${dp.cacheMessage ?? ''}` : '복원 미리보기가 준비되었습니다.'}</p>
        <button className="w-full rounded-control border border-line py-1.5 text-[12px] hover:bg-white/5" onClick={() => useStore.getState().setExportOpen(true)}>결과 이미지 저장…</button>
        <p className="text-[11px] text-faint">현재 보정을 포함한 JPEG·PNG를 별도 파일로 저장합니다.</p>
      </>}
      {dp.status === 'error' && <p className="text-center text-[12px] text-faint">{dp.message}</p>}
      {!ready && !running && edit.denoise > 0 && (
        <p className="text-center text-[12px] text-faint">복원을 실행해야 강도가 적용됩니다.</p>
      )}
    </div>
  )
}

// White-balance eyedropper: toggles a pick mode; click a neutral area on the
// photo to auto-set Temperature + Tint.
function WbPicker(): JSX.Element {
  const wbPicking = useStore((s) => s.wbPicking)
  const setWbPicking = useStore((s) => s.setWbPicking)
  return (
    <button
      onClick={() => setWbPicking(!wbPicking)}
      className={`flex w-full items-center justify-center gap-2 rounded-control border py-1.5 text-[12px] transition-colors ${
        wbPicking
          ? 'border-accent/60 bg-accent/10 text-accent-soft'
          : 'border-glass text-muted hover:text-ink'
      }`}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10.5 2.5 13.5 5.5M12 4 6.5 9.5 4 12l-1.5.5L3 11l2.5-2.5L11 3" />
        <path d="M2.5 13.5 4 12" />
      </svg>
      {wbPicking ? '사진에서 흰색이나 회색 부분을 클릭하세요' : '흰색 기준으로 색온도 맞추기'}
    </button>
  )
}

function Section({
  title,
  children,
  defaultOpen = false
}: {
  title: string
  children: React.ReactNode
  defaultOpen?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  // A collapsed section is only clipped by CSS, so its children stayed mounted
  // and kept working — the tone curve, HSL mixer and preset tiles (each a WebGL
  // render) all ran on first paint and re-ran on every edit, unseen. Mount on
  // first open and keep it mounted so the collapse animation still has content.
  const [mounted, setMounted] = useState(defaultOpen)
  useEffect(() => {
    if (open) setMounted(true)
  }, [open])
  return (
    <section
      className="border-b border-glass"
    >
      <button
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
      >
        <span
          className={`w-[3px] rounded-full bg-accent transition-all ${open ? 'h-4' : 'h-3 opacity-70'}`}
        />
        <span className="text-[13px] font-medium text-muted transition-colors group-hover:text-ink">
          {title}
        </span>
        <span className="lx-rule flex-1" />
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`text-faint transition-transform duration-150 ${open ? 'rotate-90' : ''}`}
          fill="none"
        >
          <path d="M3.5 2L7 5L3.5 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* Smooth collapse: 0fr → 1fr grid rows animates height without a fixed max. */}
      <div
        className="grid transition-[grid-template-rows] duration-150 ease-out"
        style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
      >
        <div className="overflow-hidden" style={{ visibility: open ? 'visible' : 'hidden' }} aria-hidden={!open}>
          <div className="space-y-4 px-1 pb-4 pt-0.5">{open && <SectionReset title={title} />}{mounted ? children : null}</div>
        </div>
      </div>
    </section>
  )
}

function SectionReset({ title }: { title: string }): JSX.Element | null {
  const keys: Record<string, (keyof EditState)[]> = {
    '밝기': ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks'],
    '색상': ['temperature', 'tint', 'saturation', 'vibrance'],
    '효과': ['vignette', 'grain'], '선명도': ['texture', 'clarity', 'dehaze', 'sharpening', 'denoise'],
    '톤 커브': ['curves'], '색상별 조정': ['hsl'], '영역별 색감': ['colorGrade']
  }
  const fields = keys[title]
  if (!fields) return null
  return <button className="text-[12px] text-muted hover:text-ink" onClick={() => {
    const defaults = defaultEditState()
    const patch = Object.fromEntries(fields.map((key) => [key, defaults[key]]))
    useStore.getState().setEdit(patch)
  }}>{title} 섹션 초기화</button>
}
