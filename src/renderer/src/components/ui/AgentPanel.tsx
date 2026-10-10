import { useEffect, useRef, useState } from 'react'
import type { AgentAttachment, AgentChatProposal } from '../../../../shared/agent-tools'
import type { AgentProvider } from '../../../../shared/agent-provider'
import type { CodexModel, CodexReasoningEffort } from '../../../../shared/codex'
import { editFingerprint } from '../../../../shared/local-agent'
import { useStore } from '../../store/useStore'
import { useAgentStore, type AgentComparison } from '../../store/useAgentStore'
import { useWorkspaceStore } from '../../store/useWorkspaceStore'
import { applyAgentActions, buildAgentContext, validateAgentActionSnapshot } from '../../lib/agentActions'
import { describeAgentAction, editChanges } from '../../lib/agentPresentation'
import { renderAgentImage } from '../../lib/agentImage'
import type { AgentToolProgress } from '../../../../shared/agent-vision'

interface Message {
  id: string; role: 'user' | 'assistant'; text: string; photoId: string | null; provider: AgentProvider
  images?: { name: string; previewDataUrl: string }[]
  proposal?: AgentChatProposal | null
  snapshot?: ReturnType<typeof buildAgentContext>
  applied?: boolean
  editSaved?: boolean
  consumed?: boolean
  failure?: string
  operations?: AgentToolProgress[]
}
const effortLabels: Record<CodexReasoningEffort, string> = { none: '없음', minimal: '최소', low: '낮음', medium: '보통', high: '높음', xhigh: '매우 높음', max: '최대', ultra: '울트라' }

export function AgentPanel(): JSX.Element | null {
  const { open, provider, setProvider, comparison, setComparison } = useAgentStore()
  const photo = useStore(s => s.photos.find(p => p.filePath === s.selectedPath) ?? null)
  const photoId = useStore(s => s.selectedPath)
  const edit = useStore(s => s.edit)
  const loading = useStore(s => s.editLoading || s.syncing || s.editGestureActive)
  const proxy = useStore(s => s.proxy)
  const restoration = useStore(s => s.denoiseProxy)
  const [messages, setMessages] = useState<Message[]>([])
  const [prompt, setPrompt] = useState('')
  const [attachments, setAttachments] = useState<AgentAttachment[]>([])
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'applying' | 'attaching' | 'models'>('idle')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const [statusText, setStatusText] = useState('AI 상태를 확인하는 중…')
  const [models, setModels] = useState<CodexModel[]>([])
  const [modelId, setModelId] = useState('')
  const [effort, setEffort] = useState<CodexReasoningEffort | ''>('')
  const [mode, setMode] = useState<'ask' | 'propose'>('propose')
  const [includeLibrary, setIncludeLibrary] = useState(false)
  const [includeCurrentPhoto, setIncludeCurrentPhoto] = useState(true)
  const [currentPreview, setCurrentPreview] = useState<string | null>(null)
  const [operations, setOperations] = useState<AgentToolProgress[]>([])
  const operationRef = useRef<AgentToolProgress[]>([])
  const epoch = useRef(0)
  const request = useRef<string | null>(null)
  const canceled = useRef(false)
  const draftScope = useRef({ photoId, provider })
  const attachmentRef = useRef(attachments)
  attachmentRef.current = attachments
  const logRef = useRef<HTMLDivElement>(null)
  const api = window.luxinus?.localAgent
  const visible = messages.filter(m => m.photoId === photoId && m.provider === provider)
  const selectedModel = modelId ? models.find(m => m.id === modelId) : models.find(m => m.isDefault)
  const imageCapable = provider === 'codex' && (!selectedModel || selectedModel.inputModalities.includes('image'))
  const sendCurrentPhoto = imageCapable && includeCurrentPhoto && !!photoId
  const restoredUrl = restoration.status === 'ready' && restoration.filePath === photoId ? restoration.url : null
  const currentPhotoReady = proxy.filePath === photoId && proxy.status === 'ready' && !!proxy.url && (edit.denoise === 0 || !!restoredUrl)
  const imageCount = attachments.length + (sendCurrentPhoto ? 1 : 0)
  const busy = phase !== 'idle'
  const canSend = !busy && !loading && ready && !!prompt.trim() && !(provider === 'local' && !photoId) && !(attachments.length > 0 && !imageCapable) && imageCount <= 4 && (!sendCurrentPhoto || currentPhotoReady)
  const openSettings = (): void => { document.dispatchEvent(new CustomEvent('luxinus:models-open')) }

  useEffect(() => {
    if (!api || !open) return
    let disposed = false
    const refresh = (): void => {
      void (provider === 'local' ? api.status().then(s => ({ ready: !!s.lastTest && s.phase !== 'error', message: s.message }))
        : window.luxinus.codex.status().then(s => ({ ready: s.phase === 'ready', message: s.message })))
        .then(s => { if (!disposed) { setReady(s.ready); setStatusText(s.message) } })
        .catch(err => { if (!disposed) { setReady(false); setStatusText(String(err.message)) } })
    }
    setReady(false); refresh()
    document.addEventListener('luxinus:agent-status', refresh)
    return () => { disposed = true; document.removeEventListener('luxinus:agent-status', refresh) }
  }, [open, provider, api])

  useEffect(() => {
    epoch.current++
    if (request.current) void api?.cancel(request.current).catch(() => {})
    request.current = null; canceled.current = true
    useAgentStore.getState().setActiveRequest(null)
    operationRef.current = []; setOperations([])
    setPhase('idle'); setNotice(''); setError('')
    if (draftScope.current.photoId !== photoId || draftScope.current.provider !== provider) setPrompt('')
    draftScope.current = { photoId, provider }
    const ids = attachmentRef.current.map(a => a.id)
    setAttachments([])
    if (ids.length) void api?.releaseImages(ids).catch(() => {})
    setComparison(null)
    return () => {
      epoch.current++
      if (request.current) void api?.cancel(request.current).catch(() => {})
      useAgentStore.getState().setActiveRequest(null)
    }
  }, [photoId, provider, open, api, setComparison])
  useEffect(() => api?.onToolProgress?.(event => {
    if (event.requestId !== request.current || canceled.current) return
    const next = operationRef.current.filter(item => item.operationId !== event.operationId)
    next.push(event)
    let images = 0
    const bounded = next.slice(-24).reverse().map(item => item.imageDataUrl && ++images > 4 ? { ...item, imageDataUrl: undefined } : item).reverse()
    operationRef.current = bounded; setOperations(bounded)
    setNotice(event.message)
  }), [api])
  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [messages, photoId, provider, notice, operations])
  useEffect(() => {
    let disposed = false
    setCurrentPreview(null)
    if (!open || !sendCurrentPhoto || !currentPhotoReady || loading || !proxy.url) return
    // Local thumbnail only. Image upload happens only inside send().
    const timer = setTimeout(() => {
      void renderAgentImage(proxy.url!, edit, restoredUrl, 320)
        .then(url => { if (!disposed) setCurrentPreview(url) }).catch(() => {})
    }, 180)
    return () => { disposed = true; clearTimeout(timer) }
  }, [open, sendCurrentPhoto, currentPhotoReady, loading, proxy.url, edit, restoredUrl])
  if (!api) return null

  const addMessage = (message: Message): void => setMessages(previous => [...previous, message].slice(-40))
  async function send(): Promise<void> {
    if (!canSend || request.current) return
    const turn = ++epoch.current, requestId = crypto.randomUUID(), text = prompt.trim()
    request.current = requestId; canceled.current = false
    operationRef.current = []; setOperations([])
    setPhase('requesting'); setError(''); setNotice('현재 보정을 저장하는 중…'); setComparison(null)
    const sentAttachments = [...attachments]
    let generatedAttachment: AgentAttachment | null = null
    try {
      if (!await useStore.getState().flushSaves()) throw new Error('현재 보정을 저장하지 못했습니다. 저장 문제를 해결한 뒤 다시 보내 주세요.')
      if (turn !== epoch.current || canceled.current) return
      const snapshot = buildAgentContext(includeLibrary)
      const current = useStore.getState()
      if (current.selectedPath !== photoId) return
      if (sendCurrentPhoto) {
        if (!current.proxy.url || current.proxy.filePath !== photoId || current.proxy.status !== 'ready') throw new Error('현재 사진 미리보기가 준비되지 않았습니다.')
        setNotice('현재 보정이 반영된 사진을 준비하는 중…')
        const restored = current.denoiseProxy.status === 'ready' && current.denoiseProxy.filePath === photoId ? current.denoiseProxy.url : null
        const dataUrl = await renderAgentImage(current.proxy.url, current.edit, restored)
        if (turn !== epoch.current || canceled.current) return
        generatedAttachment = await api.prepareImage({ dataUrl, name: '현재 사진 · 보정 반영' })
        if (turn !== epoch.current || canceled.current) return
        sentAttachments.unshift(generatedAttachment)
      }
      const latest = useStore.getState()
      if (latest.selectedPath !== photoId || editFingerprint(latest.edit) !== editFingerprint(current.edit) || latest.editGestureActive) throw new Error('사진 보정이 바뀌었습니다. 최신 사진으로 다시 보내 주세요.')
      addMessage({ id: requestId, role: 'user', text, photoId, provider,
        images: sentAttachments.map(({ name, previewDataUrl }) => ({ name, previewDataUrl })) })
      setPrompt(''); setNotice(provider === 'codex' ? 'Codex가 요청을 확인하고 있습니다…' : '로컬 모델이 보정값을 만드는 중…')
      useAgentStore.getState().setActiveRequest({ requestId, photoId, allowVision: sendCurrentPhoto, baseEdit: current.edit })
      const result = await api.chat({ requestId, provider, modelId: provider === 'codex' && modelId ? modelId : undefined,
        reasoningEffort: provider === 'codex' && effort ? effort : undefined, mode: provider === 'local' ? 'propose' : mode, prompt: text,
        photoId, baseEdit: photoId ? current.edit : null, context: snapshot.context, allowVision: sendCurrentPhoto,
        history: visible.slice(-12).map(m => ({ role: m.role, text: `${m.proposal ? `[제안 상태: ${m.failure ? m.editSaved ? '보정 저장, 일부 앱 동작 확인 필요' : '적용 실패' : m.applied ? '적용 완료' : '아직 적용하지 않음'}] ` : ''}${m.text}`.slice(0, 1500) })), attachmentIds: sentAttachments.map(a => a.id) })
      if (turn !== epoch.current || canceled.current) return
      addMessage({ id: crypto.randomUUID(), role: 'assistant', text: result.message, photoId, provider, proposal: result.proposal, snapshot, operations: [...operationRef.current] })
      setOperations([])
      setNotice(result.proposal ? '사진과 변경 내용을 확인한 뒤 적용하세요.' : '')
      setAttachments([])
      void api.releaseImages(sentAttachments.map(a => a.id)).catch(() => {})
    } catch (err) {
      if (turn === epoch.current && !canceled.current) { setError((err as Error).message); setPrompt(text) }
    } finally {
      if (useAgentStore.getState().activeRequest?.requestId === requestId) useAgentStore.getState().setActiveRequest(null)
      if (generatedAttachment) void api.releaseImages([generatedAttachment.id]).catch(() => {})
      if (turn === epoch.current) { request.current = null; setPhase('idle'); if (canceled.current) setNotice('요청을 중단했습니다. 변경은 적용하지 않았습니다.') }
    }
  }
  function cancel(): void {
    if (!request.current) return
    const turn = epoch.current, requestId = request.current
    canceled.current = true; setNotice('요청을 중단하는 중…')
    useAgentStore.getState().setActiveRequest(null)
    void api.cancel(requestId).catch(() => {
      if (turn === epoch.current && request.current === requestId) setError('중단을 확인하지 못했습니다. 응답을 기다리며 변경은 적용하지 않습니다.')
    })
  }
  function validProposal(proposal: AgentChatProposal): boolean {
    return proposal.photoId === photoId && (proposal.baseEdit === null ? photoId === null : editFingerprint(proposal.baseEdit) === editFingerprint(edit))
  }
  async function apply(message: Message): Promise<void> {
    const proposal = message.proposal
    if (!proposal || !message.snapshot || busy || loading || message.consumed || !validProposal(proposal)) return
    const turn = ++epoch.current
    setPhase('applying'); setError(''); setNotice('변경을 적용하는 중…'); setComparison(null)
    setMessages(previous => previous.map(m => m.id === message.id ? { ...m, failure: undefined } : m))
    try {
      validateAgentActionSnapshot(message.snapshot, proposal.actions)
      const result = await api.approveChat({ proposalId: proposal.proposalId, photoId, baseEdit: photoId ? edit : null })
      // Keep completed edits in the chat even if the selection changes during a disk write.
      setMessages(previous => previous.map(m => m.id === message.id ? { ...m, consumed: true, editSaved: result.saved } : m))
      if (result.saved && result.photoId && result.baseEdit && result.edit) {
        if (!useStore.getState().applyAgentEdit({ photoId: result.photoId, baseEdit: result.baseEdit, edit: result.edit, saved: true })) {
          throw new Error('대상 사진에 저장했습니다. 현재 선택이나 보정이 바뀌어 화면을 갱신하지 않았습니다. 대상 사진을 다시 열어 확인하세요.')
        }
      }
      await applyAgentActions(result.actions, message.snapshot)
      setMessages(previous => previous.map(m => m.id === message.id ? { ...m, applied: true } : m))
      if (turn === epoch.current) setNotice(result.saved ? '사진에 저장했습니다. 대화의 버튼으로 적용 전후를 비교할 수 있습니다.' : '앱 동작을 적용했습니다.')
    } catch (err) {
      setMessages(previous => previous.map(m => m.id === message.id ? { ...m, failure: (err as Error).message } : m))
      if (turn === epoch.current) setError((err as Error).message)
    }
    finally { if (turn === epoch.current) setPhase('idle') }
  }
  async function loadModels(): Promise<void> {
    if (busy) return
    const turn = epoch.current
    setPhase('models'); setError('')
    try {
      const result = await window.luxinus.codex.models()
      if (turn !== epoch.current) return
      setModels(result)
      if (modelId && !result.some(m => m.id === modelId)) { setModelId(''); setEffort('') }
      setNotice(result.length ? '사용 가능한 모델 목록을 불러왔습니다.' : '사용 가능한 모델이 없습니다. 로그인 상태를 확인하세요.')
    } catch (err) { if (turn === epoch.current) setError((err as Error).message) }
    finally { if (turn === epoch.current) setPhase('idle') }
  }
  async function attach(): Promise<void> {
    if (busy || !imageCapable || imageCount >= 4) return
    const turn = epoch.current
    setPhase('attaching'); setError('')
    try {
      const images = await api.pickImages()
      if (turn !== epoch.current) { void api.releaseImages(images.map(a => a.id)).catch(() => {}); return }
      const free = 4 - imageCount
      setAttachments(previous => [...previous, ...images.slice(0, free)])
      if (images.length > free) void api.releaseImages(images.slice(free).map(a => a.id)).catch(() => {})
      if (images.length) setNotice('첨부했습니다. 보내기를 누를 때만 이미지 축소본을 Codex로 전송합니다.')
    } catch (err) { if (turn === epoch.current) setError((err as Error).message) }
    finally { if (turn === epoch.current) setPhase('idle') }
  }
  function compare(proposal: AgentChatProposal, mode: AgentComparison['mode']): void {
    if (!proposal.photoId || !proposal.baseEdit || !proposal.edit) return
    useWorkspaceStore.getState().setWorkspace('develop')
    setComparison({ photoId: proposal.photoId, before: proposal.baseEdit, after: proposal.edit, mode, proposalId: proposal.proposalId,
      label: proposal.reason.length > 42 ? `${proposal.reason.slice(0, 42)}…` : proposal.reason })
  }
  return <aside className="lx-agent-panel" aria-label="AI 채팅">
    <header className="lx-agent-header"><h2>AI 작업 도우미</h2><div>
      <button title="이 사진의 현재 AI 대화 지우기" disabled={busy} onClick={() => { setMessages(previous => previous.filter(m => m.photoId !== photoId || m.provider !== provider)); setComparison(null); setNotice('대화를 비웠습니다. 사진 보정은 유지됩니다.') }}>새 대화</button>
      <button aria-label="AI 채팅 닫기" disabled={phase === 'applying'} onClick={() => useAgentStore.getState().setOpen(false)}>‹</button>
    </div></header>
    <div className="lx-agent-options">
      <div className="lx-agent-provider" role="group" aria-label="사용할 AI">{(['local', 'codex'] as const).map(value => <button key={value} disabled={busy} aria-pressed={provider === value} onClick={() => setProvider(value)}>{value === 'local' ? '로컬 모델' : 'GPT Codex'}</button>)}</div>
      <div className="lx-agent-model">{provider === 'codex' ? <>
        <select aria-label="Codex 모델 선택" disabled={busy} value={modelId} onChange={e => { setModelId(e.target.value); setEffort('') }}><option value="">계정 기본 모델</option>{models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}</select>
        <button disabled={busy} title="Codex에 연결해 사용 가능한 모델 목록 가져오기" onClick={() => void loadModels()}>목록 불러오기</button>
      </> : <span className="text-[12px] text-muted">로컬 텍스트 모델 · 기본 보정</span>}
        <button disabled={busy} onClick={openSettings}>설정</button>
      </div>
      {!ready && <div className="lx-agent-notice"><p>{statusText}</p><button className="underline mt-1" onClick={openSettings}>{provider === 'codex' ? 'ChatGPT 로그인' : '로컬 모델 준비'}</button></div>}
      <details className="lx-agent-advanced"><summary>고급 설정 · 도구 안내</summary>
        <label>작업 방식<select aria-label="AI 작업 방식" disabled={busy || provider === 'local'} value={provider === 'local' ? 'propose' : mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="propose">보정·앱 조작 제안</option><option value="ask">대화만 · 변경 없음</option></select></label>
        {provider === 'codex' && <><label>추론 강도<select aria-label="Codex 추론 강도" disabled={busy || !selectedModel} value={effort} onChange={e => setEffort(e.target.value as typeof effort)}><option value="">모델 기본값</option>{selectedModel?.supportedReasoningEfforts.map(item => <option key={item.reasoningEffort} value={item.reasoningEffort}>{effortLabels[item.reasoningEffort]}</option>)}</select></label>
          <label><input type="checkbox" checked={includeLibrary} disabled={busy} onChange={e => setIncludeLibrary(e.target.checked)} />사진 목록의 순서·별점·표시 공유</label>
          <p className="lx-agent-notice">목록을 공유하면 사진 선택도 요청할 수 있습니다. 사진 이름·경로·EXIF는 자동으로 보내지 않습니다.</p></>}
        <p className="lx-agent-notice">{provider === 'codex' ? '인물 부위 선택, 부분 보정, 자르기를 요청하세요. 현재 사진 포함을 켜면 작업 중 사진을 다시 확인하며 다듬습니다. 마지막 제안을 적용하면 저장되며 한 번에 실행 취소할 수 있습니다.' : '기본 밝기와 색상 보정값을 제안합니다. 이미지 분석과 앱 조작은 GPT Codex에서 사용할 수 있습니다.'}</p>
        <p className="lx-agent-notice">대화와 비교 기록은 이 앱 세션에 보관됩니다. 최근 대화 12개를 후속 요청에 함께 사용하며, 이전 첨부 이미지는 다시 보내지 않습니다.</p>
      </details>
    </div>
    <div ref={logRef} className="lx-agent-conversation" role="log" aria-label="AI 대화 기록" aria-live="polite">
      {!visible.length && <div className="lx-agent-empty"><strong>사진을 보며, 말로 편집하세요.</strong><p>{provider === 'codex' ? '부위를 골라 보정하고, 결과를 다시 확인해 다듬습니다. 참고 이미지를 더해 원하는 느낌을 알려 주세요.' : '원하는 밝기와 색감을 알려 주세요. 내 컴퓨터에서 보정값을 제안합니다.'}</p><div className="lx-agent-suggestions">{(provider === 'codex' ? ['피부만 조금 밝게 하고 결과를 확인해줘', '인물 중심으로 잘라주고 눈과 옷을 따로 보정해줘', '사진을 따뜻한 필름 느낌으로 만들고 전후를 확인해줘'] : ['어두운 부분을 20으로 설정해줘', '색감은 유지하고 어두운 부분만 조금 살려줘']).map(text => <button key={text} onClick={() => { setPrompt(text); document.getElementById('agent-chat-prompt')?.focus() }}>{text}</button>)}</div></div>}
      {visible.map(message => <article key={message.id} data-role={message.role} className="lx-agent-message"><header><span>{message.role === 'user' ? '나' : provider === 'codex' ? 'Codex' : '로컬 모델'}</span>{(message.applied || message.failure || message.editSaved) && <span>{message.failure ? message.editSaved ? '보정 저장 · 동작 확인 필요' : '적용 실패' : message.applied ? '적용 완료' : '보정 저장'}</span>}</header><p>{message.text}</p>
        {message.images?.length ? <div className="lx-agent-attachments">{message.images.map((image, i) => <div className="lx-agent-attachment" key={i}><img src={image.previewDataUrl} alt={image.name} /><span>{image.name}</span></div>)}</div> : null}
        {message.operations?.length ? <ToolActivity operations={message.operations} /> : null}
        {message.proposal && <div className="lx-agent-plan">
          {message.proposal.actions.length > 0 && <ul>{message.proposal.actions.map((action, i) => <li key={i}>{describeAgentAction(action)}</li>)}</ul>}
          {message.proposal.baseEdit && message.proposal.edit && <>
            <details open><summary>변경할 보정값</summary><table><thead><tr><th>항목</th><th>적용 전</th><th>적용 후</th></tr></thead><tbody>{editChanges(message.proposal.baseEdit, message.proposal.edit).map(change => <tr key={change.key}><td>{change.label}</td><td>{change.before}</td><td>{change.after}</td></tr>)}</tbody></table></details>
            <div className="lx-agent-compare">{([['before', '적용 전'], ['after', '적용 후'], ['split', '나란히 비교']] as const).map(([value, title]) => <button key={value} disabled={busy || loading} aria-pressed={comparison?.proposalId === message.proposal?.proposalId && comparison?.mode === value} onClick={() => compare(message.proposal!, value)}>{title}</button>)}</div>
          </>}
          {!message.consumed && <button className="lx-agent-apply" disabled={busy || loading || !validProposal(message.proposal)} onClick={() => void apply(message)}>제안 적용</button>}
          {!message.applied && !validProposal(message.proposal) && <p className="lx-agent-notice">보정이 바뀌었습니다. 현재 상태에서 다시 요청하세요.</p>}
          {message.applied && message.proposal.edit && <p className="lx-agent-notice">적용 전후는 이 제안 시점의 기록입니다. 실행 취소로 마지막 보정을 되돌릴 수 있습니다.</p>}
          {message.failure && <p className="lx-agent-error">{message.failure}</p>}
        </div>}
      </article>)}
      {operations.length > 0 && <ToolActivity operations={operations} />}
    </div>
    <div className="lx-agent-composer">
      <div className="lx-agent-target">{(currentPreview || photo?.thumbUrl) && <img src={currentPreview || photo!.thumbUrl!} alt={currentPreview ? '보낼 현재 사진 · 보정 반영' : ''} />}<span title={photo?.fileName}>{photo?.fileName ?? '사진을 선택하거나 앱 조작을 요청하세요'}</span></div>
      {provider === 'codex' && photoId && <label className="lx-agent-current"><input type="checkbox" aria-label="현재 사진 포함" checked={includeCurrentPhoto && imageCapable} disabled={busy || !imageCapable || (!includeCurrentPhoto && attachments.length >= 4)} onChange={e => setIncludeCurrentPhoto(e.target.checked)} /><span>현재 사진 포함 <small>{!imageCapable ? '이 모델은 텍스트 전용' : sendCurrentPhoto ? currentPhotoReady ? '보낼 사진 + 작업 중 미리보기' : '미리보기 준비 중' : '텍스트와 참고 이미지만 전송'}</small></span></label>}
      {attachments.length > 0 && <div className="lx-agent-attachments">{attachments.map(image => <div className="lx-agent-attachment" key={image.id}><img src={image.previewDataUrl} alt={image.name} /><span>{image.name}</span><button aria-label={`${image.name} 첨부 제거`} disabled={busy} onClick={() => { setAttachments(previous => previous.filter(a => a.id !== image.id)); void api.releaseImages([image.id]).catch(() => {}) }}>×</button></div>)}</div>}
      <textarea id="agent-chat-prompt" aria-label="AI에게 요청" rows={3} maxLength={1500} value={prompt} disabled={busy} placeholder={provider === 'codex' ? '원하는 보정이나 앱 동작을 말해 주세요…' : '예: 어두운 부분을 20으로 설정해줘'} onChange={e => setPrompt(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }} />
      <div className="lx-agent-send-row">
        <button disabled={busy || !imageCapable || imageCount >= 4} title="참고 이미지 첨부 · 현재 사진 포함 최대 4장" onClick={() => void attach()}>참고 이미지 +</button>
        {phase === 'requesting' ? <button className="lx-agent-send" onClick={cancel}>중단</button> : <button className="lx-agent-send" title="보내기 · Cmd/Ctrl+Enter" disabled={!canSend} onClick={() => void send()}>보내기</button>}
      </div>
      <p className="lx-agent-notice">{provider === 'codex' ? `보낼 이미지 ${imageCount}/4장 · 보내기를 누르면 문장·보정값${imageCount ? '·이미지 축소본' : ''}을 Codex로 전송합니다.${sendCurrentPhoto ? ' 작업 중 확인한 사진도 전송합니다.' : ''}` : '텍스트 전용 · 내 컴퓨터에서 처리합니다.'}</p>
      {sendCurrentPhoto && !currentPhotoReady && <p role="status" className="lx-agent-notice">{edit.denoise > 0 && !restoredUrl ? '노이즈 제거 결과가 준비되면 사진을 보낼 수 있습니다.' : '선택한 사진을 불러오고 있습니다.'} 사진 포함을 끄면 텍스트만 보낼 수 있습니다.</p>}
      {attachments.length > 0 && !imageCapable && <p className="lx-agent-error">이 모델은 이미지를 지원하지 않습니다. 이미지 지원 모델을 선택하거나 첨부를 제거하세요.</p>}
      {notice && <p role="status" className="lx-agent-notice">{notice}</p>}
      {error && <p role="alert" className="lx-agent-error">{error}</p>}
    </div>
  </aside>
}

function ToolActivity({ operations }: { operations: AgentToolProgress[] }): JSX.Element {
  return <details open className="lx-agent-activity"><summary>사진 작업 기록 · {operations.filter(item => item.status === 'completed').length}단계 완료</summary>
    <ol>{operations.map(item => <li key={item.operationId} data-status={item.status}>
      <span aria-hidden="true">{item.status === 'started' ? '◌' : item.status === 'completed' ? '✓' : '!'}</span><div><p>{item.message}</p>{item.imageDataUrl && <img src={item.imageDataUrl} alt="에이전트가 확인한 사진 미리보기" />}</div>
    </li>)}</ol>
  </details>
}
