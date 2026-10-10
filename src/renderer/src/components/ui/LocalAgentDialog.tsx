import { useEffect, useRef, useState } from 'react'
import type { EditState } from '../../../../shared/edits'
import { AGENT_CONTROLS, editFingerprint, type AgentControl, type AgentProposal, type ApprovedAgentEdit,
  type LocalAgentApi, type LocalModelStatus } from '../../../../shared/local-agent'
import { useDialogFocus } from './useDialogFocus'
import type { CodexStatus } from '../../../../shared/codex'
import type { AgentProvider, CodexApi } from '../../../../shared/agent-provider'
import { AiProviderPicker } from './AiProviderPicker'

interface Props {
  open: boolean
  onClose: () => void
  onOpenModels: () => void
  api: LocalAgentApi
  codexApi: CodexApi
  provider: AgentProvider
  onProviderChange: (value: AgentProvider) => void
  photoId: string | null
  photoName: string | null
  edit: EditState
  onPreview: (edit: EditState | null) => void
  beforeRequest: () => Promise<boolean>
  onApplied: (result: ApprovedAgentEdit) => boolean
}

export function LocalAgentDialog({ open, onClose, onOpenModels, api, codexApi, provider, onProviderChange, photoId, photoName, edit,
  onPreview, beforeRequest, onApplied }: Props): JSX.Element | null {
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState<LocalModelStatus | null>(null)
  const [codex, setCodex] = useState<CodexStatus | null>(null)
  const [proposal, setProposal] = useState<AgentProposal | null>(null)
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'applying'>('idle')
  const [message, setMessage] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const requestRef = useRef<string | null>(null)
  const cancelledRequest = useRef<string | null>(null)
  const epoch = useRef(0)
  const close = (): void => {
    if (phase === 'applying') return
    epoch.current++
    if (requestRef.current) void api.cancel(requestRef.current).catch(() => {})
    requestRef.current = null
    cancelledRequest.current = null
    onPreview(null)
    onClose()
  }
  const dialogRef = useDialogFocus(open, close)
  useEffect(() => {
    if (!open) return
    const currentEpoch = ++epoch.current
    setProposal(null); setPreviewing(false); setPhase('idle'); setMessage(''); setModel(null); setCodex(null)
    const status = provider === 'local'
      ? api.status().then(value => { if (currentEpoch === epoch.current) setModel(value) })
      : codexApi.status().then(value => { if (currentEpoch === epoch.current) setCodex(value) })
    void status.catch(err => { if (currentEpoch === epoch.current) setMessage((err as Error).message) })
    return () => {
      epoch.current++
      if (requestRef.current) void api.cancel(requestRef.current).catch(() => {})
      requestRef.current = null
      cancelledRequest.current = null
      onPreview(null)
    }
  }, [open, photoId, api, codexApi, provider, onPreview])
  if (!open) return null
  const valid = proposal?.photoId === photoId && editFingerprint(proposal.baseEdit) === editFingerprint(edit)
  const ready = provider === 'codex' ? codex?.phase === 'ready' : !!model?.lastTest && model.phase !== 'error'
  async function propose(): Promise<void> {
    if (!photoId || phase !== 'idle' || requestRef.current) return
    const turn = ++epoch.current
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    cancelledRequest.current = null
    setPhase('requesting'); setMessage('현재 보정 저장을 확인하는 중…'); setProposal(null)
    setPreviewing(false); onPreview(null)
    try {
      const saved = await beforeRequest()
      if (turn !== epoch.current) return
      if (cancelledRequest.current === requestId) {
        setMessage('요청을 취소했습니다. 보정 제안을 만들지 않았습니다.')
        return
      }
      if (!saved) throw new Error('현재 보정 저장에 실패했습니다. 저장 문제를 해결한 뒤 다시 요청해 주세요.')
      setMessage(provider === 'codex' ? 'Codex가 보정 제안을 만드는 중…' : '내 Mac에서 보정 제안을 만드는 중…')
      const result = await api.propose({ requestId, photoId, baseEdit: edit, prompt, provider })
      if (turn !== epoch.current) return
      if (cancelledRequest.current === requestId) {
        setMessage('요청을 취소했습니다. 제안은 적용되지 않았습니다.')
        return
      }
      setProposal(result); setMessage('제안이 준비되었습니다. 값과 사진 미리보기를 검토한 뒤 적용해 주세요.')
    } catch (err) {
      if (turn === epoch.current) setMessage(cancelledRequest.current === requestId
        ? '요청을 취소했습니다. 제안은 적용되지 않았습니다.' : (err as Error).message)
    } finally {
      if (turn === epoch.current) { requestRef.current = null; setPhase('idle') }
      if (cancelledRequest.current === requestId) cancelledRequest.current = null
    }
  }
  function cancelRequest(): void {
    const requestId = requestRef.current
    if (!requestId) return
    const turn = epoch.current
    cancelledRequest.current = requestId
    setMessage('중단을 요청했습니다. 진행 중인 저장 또는 모델 종료를 기다리는 중…')
    void api.cancel(requestId).catch(() => {
      if (turn === epoch.current && requestRef.current === requestId) {
        setMessage('모델 중단을 확인하지 못했습니다. 작업이 끝나기를 기다립니다. 제안은 적용하지 않습니다.')
      }
    })
  }
  async function approve(): Promise<void> {
    if (!proposal || !valid || phase !== 'idle') return
    setPhase('applying'); setMessage('보정을 저장하는 중…')
    try {
      const result = await api.approve({ proposalId: proposal.proposalId, photoId: proposal.photoId, baseEdit: edit })
      onPreview(null); setPreviewing(false); setProposal(null)
      setMessage(onApplied(result)
        ? '사진 1장에 저장했습니다. 실행 취소로 이전 보정으로 돌아갈 수 있습니다.'
        : '대상 사진에는 저장했습니다. 현재 선택이 바뀌어 화면을 갱신하지 않았습니다. 대상 사진을 다시 열어 확인해 주세요.')
    } catch (err) { setMessage((err as Error).message) }
    finally { setPhase('idle') }
  }
  const panelStyle = { width: 560, maxWidth: 'calc(100vw - 32px)', maxHeight: 'calc(100vh - 48px)',
    background: '#262626', border: '1px solid #343434', borderRadius: 10, color: '#eee', padding: 20, overflow: 'auto' as const,
    boxShadow: '0 12px 48px #0008' }
  return <div className="fixed inset-0 z-[100] flex p-6" style={{ background: previewing ? 'transparent' : '#0007',
    alignItems: previewing ? 'flex-end' : 'center', justifyContent: previewing ? 'flex-end' : 'center' }}>
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="local-agent-title" tabIndex={-1} style={panelStyle}>
      <div className="flex items-center justify-between gap-4 mb-3">
        <h2 id="local-agent-title" className="text-[16px] font-semibold">AI 사진 보정</h2>
        <button type="button" onClick={close} disabled={phase === 'applying'} aria-label="사진 보정 제안 닫기" className="px-2 py-1">닫기</button>
      </div>
      <AiProviderPicker value={provider} onChange={onProviderChange} disabled={phase !== 'idle'} />
      <div className="text-[13px] mb-3 truncate" title={photoName ?? ''}>선택한 사진: {photoName ?? '없음'}</div>
      <p className="text-[12px] text-[#a3a3a3] mb-3 leading-relaxed">원하는 밝기와 색감을 말해 주세요. 변경할 값을 먼저 보여드리고, 적용하기 전 사진에서 비교할 수 있습니다.</p>
      <p className="text-[12px] text-[#a3a3a3] mb-3 leading-relaxed">{provider === 'codex'
        ? '요청할 때 입력한 문장과 보정값을 Codex로 전송합니다. 사진은 전송하지 않으며 사진 속 내용은 분석하지 않습니다.'
        : '내 Mac에서 처리합니다. 수치는 “어두운 부분을 20으로”처럼 변경 후 값으로 요청해 주세요. 로컬 모델은 상대 계산과 단위 환산을 지원하지 않습니다.'}</p>
      {!ready && <div className="border border-[#343434] rounded-md p-3 mb-3 text-[13px]">
        <p>{(provider === 'codex' ? codex?.message : model?.message) ?? 'AI 상태를 확인하는 중…'}</p>
        <button type="button" className="mt-2 underline" onClick={() => { close(); onOpenModels() }}>{provider === 'codex' ? 'Codex 로그인 설정' : '로컬 모델 설정'}</button>
      </div>}
      <label htmlFor="agent-prompt" className="block text-[13px] mb-2">어떻게 보정할까요?</label>
      <textarea id="agent-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} maxLength={1500}
        disabled={phase !== 'idle'} placeholder="색감은 유지하고 어두운 부분만 조금 밝게 해줘."
        className="w-full p-3 text-[13px] bg-[#1c1c1c] border border-[#343434] rounded-md resize-y" />
      <div className="flex items-center justify-between mt-2 gap-3">
        <span className="text-[12px] text-[#a3a3a3] tabular-nums">{prompt.length}/1,500</span>
        {phase === 'requesting'
          ? <button type="button" className="px-3 py-2 border border-[#343434] rounded-md" onClick={cancelRequest}>요청 중단</button>
          : <button type="button" onClick={() => void propose()} disabled={!ready || !photoId || !prompt.trim() || phase !== 'idle'}
              className="px-3 py-2 rounded-md bg-[#b7a8f7] text-[#151515] disabled:opacity-40">보정 제안 만들기</button>}
      </div>
      {proposal && <div className="mt-4 border-t border-[#343434] pt-3">
        <p className="text-[13px] mb-3">{proposal.reason}</p>
        <table className="w-full text-[13px] tabular-nums text-left"><thead><tr className="text-[#a3a3a3]"><th className="pb-2">항목</th><th>현재</th><th>제안</th></tr></thead>
          <tbody>{(Object.entries(proposal.patch) as [AgentControl, number][]).map(([key, value]) =>
            <tr key={key}><td className="py-1">{AGENT_CONTROLS[key].label}</td><td>{proposal.baseEdit[key]}</td><td>{value}</td></tr>)}</tbody></table>
        <details className="text-[12px] text-[#a3a3a3] mt-2"><summary className="cursor-pointer">보정값 단위 안내</summary><p className="mt-2">슬라이더에 표시되는 값입니다. 노출 50은 +1 EV에 해당하며, 색온도는 -100~100의 상대값입니다.</p></details>
        {!valid && <p role="alert" className="text-[13px] mt-2">사진 또는 보정값이 변경되었습니다. 제안을 다시 만들어 주세요.</p>}
        <div className="flex gap-2 justify-end mt-3">
          <button type="button" disabled={!valid || phase !== 'idle'} className="px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40"
            aria-pressed={previewing} onClick={() => {
              onPreview(previewing ? null : { ...edit, ...proposal.patch }); setPreviewing(!previewing)
            }}>{previewing ? '미리보기 해제' : '사진에서 미리보기'}</button>
          <button type="button" disabled={!valid || phase !== 'idle'} onClick={() => void approve()}
            className="px-3 py-2 bg-[#b7a8f7] text-[#151515] rounded-md disabled:opacity-40">{phase === 'applying' ? '저장 중…' : '사진 1장에 적용'}</button>
        </div>
      </div>}
      {message && <p role="status" aria-live="polite" className="text-[13px] mt-4 whitespace-pre-wrap">{message}</p>}
    </div>
  </div>
}
