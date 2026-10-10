import { useEffect, useRef, useState } from 'react'
import { LOCAL_MODEL_CANDIDATE, type LocalAgentApi, type LocalModelStatus } from '../../../../shared/local-agent'
import { useDialogFocus } from './useDialogFocus'
import type { AgentProvider, CodexApi } from '../../../../shared/agent-provider'
import { AiProviderPicker } from './AiProviderPicker'
import { CodexSettings } from './CodexSettings'

interface Props { open: boolean; onClose: () => void; api: LocalAgentApi; codexApi: CodexApi; provider: AgentProvider; onProviderChange: (value: AgentProvider) => void; onOpenXmp?: () => void }
const labels = { unavailable: '설치 필요', untested: '실행 확인 필요', loading: '확인 중', ready: '사용 가능', running: '작업 중', error: '오류' }
export function ModelsDialog({ open, onClose, api, codexApi, provider, onProviderChange, onOpenXmp }: Props): JSX.Element | null {
  const [status, setStatus] = useState<LocalModelStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<string | null>(null)
  const mounted = useRef(false)
  const epoch = useRef(0)
  const close = (): void => {
    epoch.current++
    mounted.current = false
    if (request.current) void api.cancel(request.current).catch(() => {})
    request.current = null
    onClose()
  }
  const ref = useDialogFocus(open, close)
  useEffect(() => {
    mounted.current = open
    const currentEpoch = ++epoch.current
    setBusy(false); setError(''); setStatus(null)
    if (!open || provider !== 'local') return
    void api.status()
      .then(value => { if (mounted.current && currentEpoch === epoch.current) setStatus(value) })
      .catch(err => { if (mounted.current && currentEpoch === epoch.current) setError(String(err)) })
    return () => {
      epoch.current++
      mounted.current = false
      if (request.current) void api.cancel(request.current).catch(() => {})
      request.current = null
    }
  }, [open, api, provider])
  if (!open) return null
  async function run(action: () => Promise<LocalModelStatus>, smoke = false): Promise<void> {
    const currentEpoch = ++epoch.current
    const currentRequest = request.current
    setBusy(true); setError('')
    setStatus(current => smoke && current
      ? { ...current, phase: 'loading', lastTest: null, message: '실제 한국어 추론 검사 중…' }
      : null)
    try { const result = await action(); if (mounted.current && currentEpoch === epoch.current) setStatus(result) }
    catch (err) {
      if (mounted.current && currentEpoch === epoch.current) setError((err as Error).message)
      void api.status().then(value => { if (mounted.current && currentEpoch === epoch.current) setStatus(value) }).catch(() => {})
    } finally {
      if (request.current === currentRequest) request.current = null
      if (mounted.current && currentEpoch === epoch.current) setBusy(false)
    }
  }
  return <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/50">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="models-title" tabIndex={-1}
      className="w-[640px] max-w-full max-h-[calc(100vh-48px)] overflow-y-auto rounded-[10px] border border-[#343434] bg-[#262626] p-5 text-[#eee] text-[13px]">
      <div className="flex items-center justify-between mb-4"><h2 id="models-title" className="text-[16px] font-semibold">AI 설정</h2>
        <button type="button" onClick={close} className="px-2 py-1" aria-label="AI 설정 닫기">닫기</button></div>
      <AiProviderPicker value={provider} onChange={onProviderChange} disabled={busy} />
      {provider === 'codex' ? <CodexSettings api={codexApi} /> : <>
      <p className="text-[#a3a3a3] mb-4">내 Mac에서 보정 제안을 만듭니다. 아래에서 설치된 모델을 선택하고 실행을 확인해 주세요.</p>
      <div className="border-y border-[#343434] py-3 mb-4">
        <div className="flex justify-between gap-3"><strong>로컬 모델 · Qwen 2.5</strong><span role="status">{status ? labels[status.phase] : '상태 확인 중'}</span></div>
        <p className="mt-2">{status?.message}</p>
        <details className="mt-3"><summary className="cursor-pointer text-[#a3a3a3] text-[12px]">설치 경로와 실행 정보</summary><dl className="grid grid-cols-[92px_1fr] gap-x-3 gap-y-2 mt-3 text-[12px]">
          <dt className="text-[#a3a3a3]">실행기</dt><dd className="break-all">{status?.runtimePath ?? '선택되지 않음'}</dd>
          <dt className="text-[#a3a3a3]">버전</dt><dd className="break-all">{status?.runtimeVersion ?? '이 실행에서 미확인'}</dd>
          <dt className="text-[#a3a3a3]">모델 파일</dt><dd className="break-all">{status?.modelPath ?? '선택되지 않음'}</dd>
          <dt className="text-[#a3a3a3]">체크섬</dt><dd>{status?.verifiedCandidate ? '공식 SHA256 일치' : '확인 필요'}</dd>
          <dt className="text-[#a3a3a3]">실행 자원</dt><dd>{status?.memoryBytes ? `물리 메모리 ${(status.memoryBytes / 1024 ** 3).toFixed(0)} GiB · ` : ''}CPU 4개 스레드 이하 · 문맥 4,096 토큰</dd>
          <dt className="text-[#a3a3a3]">추론 검증</dt><dd>{status?.lastTest ? `${new Date(status.lastTest.at).toLocaleString('ko-KR')} · ${(status.lastTest.durationMs / 1000).toFixed(1)}초 · 한국어·JSON 통과` : '실제 모델 로딩·한국어·JSON 응답 미검증'}</dd>
        </dl></details>
        <div className="flex flex-wrap gap-2 mt-3">
          <button type="button" disabled={busy} onClick={() => void run(() => api.pickRuntime())} className="px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40">실행 파일 선택</button>
          <button type="button" disabled={busy} onClick={() => void run(() => api.pickModel())} className="px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40">모델 파일 선택</button>
          <button type="button" disabled={busy || !status?.runtimePath || !status?.modelPath} onClick={() => {
            request.current = crypto.randomUUID(); void run(() => api.smokeTest(request.current!), true)
          }} className="px-3 py-2 bg-[#b7a8f7] text-[#151515] rounded-md disabled:opacity-40">모델 실행 확인</button>
          {busy && request.current && <button type="button" onClick={() => void api.cancel(request.current!)} className="px-3 py-2 border border-[#343434] rounded-md">검사 중단</button>}
          <button type="button" disabled={busy && !request.current} onClick={() => void run(() => api.unload())} className="px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40">모델 사용 중단</button>
        </div>
      </div>
      <details className="space-y-2 mb-4">
        <summary className="text-[13px] cursor-pointer">모델 설치 안내</summary>
        <p>{LOCAL_MODEL_CANDIDATE.name} · {LOCAL_MODEL_CANDIDATE.license} · {LOCAL_MODEL_CANDIDATE.sizeLabel}</p>
        <p className="text-[12px] break-all">{LOCAL_MODEL_CANDIDATE.file}</p>
        <p className="text-[12px] text-[#a3a3a3] break-all">공식 출처: {LOCAL_MODEL_CANDIDATE.source}</p>
        <p className="text-[12px] text-[#a3a3a3] break-all">SHA256: {LOCAL_MODEL_CANDIDATE.sha256}</p>
        <p className="text-[12px] text-[#a3a3a3]">별도로 설치한 llama.cpp의 llama-completion과 위 파일을 선택해 주세요. 다른 모델은 입력 형식과 품질 검증 전까지 지원하지 않습니다.</p>
      </details>
      <p className="border-t border-[#343434] pt-3 text-[12px] text-[#a3a3a3]">로컬 모델은 네트워크를 사용하지 않습니다. 모델은 요청할 때만 실행하며, 작업이 끝나면 메모리를 반환합니다.</p>
      <p className="mt-3 text-[12px] text-[#a3a3a3]">수치는 “어두운 부분을 20으로”처럼 변경 후 값으로 요청해 주세요. 이 작은 모델은 단위 환산이나 상대 계산을 지원하지 않습니다.</p>
      </>}
      {onOpenXmp && <button type="button" disabled={busy} onClick={() => { close(); onOpenXmp() }}
        className="mt-3 px-3 py-2 border border-[#343434] rounded-md disabled:opacity-40">사진 프리셋 XMP 검토</button>}
      {busy && <p role="status" className="mt-3">선택한 작업을 처리하는 중…</p>}
      {error && <p role="alert" className="mt-3 whitespace-pre-wrap">{error}</p>}
    </div>
  </div>
}
