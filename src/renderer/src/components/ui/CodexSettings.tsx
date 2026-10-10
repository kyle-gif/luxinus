import { useEffect, useRef, useState } from 'react'
import type { CodexStatus } from '../../../../shared/codex'
import type { CodexApi } from '../../../../shared/agent-provider'

export function CodexSettings({ api }: { api: CodexApi }): JSX.Element {
  const [status, setStatus] = useState<CodexStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const epoch = useRef(0)
  const loginPending = useRef(false)
  const loginId = useRef<string | null>(null)
  useEffect(() => {
    let disposed = false
    const current = ++epoch.current
    void api.status().then(value => {
      if (current !== epoch.current) {
        if (disposed && value.phase === 'signing-in' && value.loginId) void api.cancelLogin(value.loginId).catch(() => {})
        return
      }
      loginPending.current = value.phase === 'signing-in'
      loginId.current = value.loginId
      setStatus(value)
    })
      .catch(err => { if (current === epoch.current) setError((err as Error).message) })
    return () => {
      disposed = true
      epoch.current++
      if (loginPending.current) void api.cancelLogin(loginId.current ?? undefined).catch(() => {})
    }
  }, [api])
  useEffect(() => {
    if (status?.phase !== 'signing-in' || busy) return
    const current = epoch.current
    const timer = window.setTimeout(() => {
      void api.status().then(value => {
        if (current !== epoch.current) return
        loginPending.current = value.phase === 'signing-in'
        loginId.current = value.loginId
        setStatus(value)
      }).catch(err => { if (current === epoch.current) setError((err as Error).message) })
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [status, busy, api])
  async function run(action: 'login' | 'logout' | 'cancelLogin' | 'status'): Promise<void> {
    const current = ++epoch.current
    if (action === 'login') { loginPending.current = true; loginId.current = null }
    setBusy(true); setError('')
    try {
      const next = await api[action]()
      if (current !== epoch.current) {
        if (next.phase === 'signing-in' && next.loginId) await api.cancelLogin(next.loginId)
        return
      }
      loginPending.current = next.phase === 'signing-in'
      loginId.current = next.loginId
      setStatus(next)
    } catch (err) { if (current === epoch.current) setError((err as Error).message) }
    finally { if (current === epoch.current) setBusy(false) }
  }
  const connected = status?.phase === 'ready'
  const signingIn = status?.phase === 'signing-in'
  return <section aria-labelledby="codex-settings-heading" className="space-y-4">
    <div>
      <h3 id="codex-settings-heading" className="text-[15px] font-semibold">ChatGPT로 Codex 연결</h3>
      <p className="mt-2 text-[#a3a3a3] leading-relaxed">공식 Codex 로그인으로 연결합니다. 별도의 API 키를 입력할 필요가 없습니다.</p>
    </div>
    <div className="p-4 bg-[#1c1c1c] border border-[#454545] rounded-md">
      <p role="status" className="font-medium">{connected ? '로그인 정보 저장됨' : signingIn ? '브라우저에서 로그인해 주세요' : status?.message ?? '로그인 상태 확인 중…'}</p>
      {connected && <p className="mt-2 text-[#a3a3a3]">{status.message}</p>}
      {connected && <p className="mt-2 text-[#a3a3a3] break-all">{status.email ?? 'ChatGPT 계정'}{status.planType ? ` · ${status.planType}` : ''}</p>}
      {signingIn && <p className="mt-2 text-[#a3a3a3]">로그인을 마치면 이 창에 연결 상태가 표시됩니다. 이 설정을 닫으면 진행 중인 로그인이 취소됩니다.</p>}
      <div className="flex flex-wrap gap-2 mt-3">
        {connected
          ? <button type="button" disabled={busy} onClick={() => void run('logout')} className="px-3 py-2 border border-[#454545] rounded-md disabled:opacity-40">로그아웃</button>
          : signingIn
            ? <button type="button" disabled={busy} onClick={() => void run('cancelLogin')} className="px-3 py-2 border border-[#454545] rounded-md disabled:opacity-40">로그인 취소</button>
            : <button type="button" disabled={busy || !status || status.phase === 'unavailable'} onClick={() => void run('login')} className="px-3 py-2 bg-[#b7a8f7] text-[#151515] rounded-md disabled:opacity-40">ChatGPT로 로그인</button>}
        <button type="button" disabled={busy} onClick={() => void run('status')} className="px-3 py-2 border border-[#454545] rounded-md disabled:opacity-40">상태 새로고침</button>
      </div>
    </div>
    <p className="text-[#a3a3a3] leading-relaxed">AI 보정에서 GPT Codex를 선택하고 요청할 때, 입력한 문장과 현재 보정값을 전송합니다. 사진 파일·사진 이름·위치 정보는 전송하지 않습니다.</p>
    <p className="text-[#a3a3a3] leading-relaxed">일반 사진 편집과 로컬 모델은 네트워크를 사용하지 않습니다. 연결 실패 시에는 오류를 표시하며 다른 AI로 자동 전환하지 않습니다.</p>
    <details className="text-[12px] text-[#a3a3a3]"><summary className="cursor-pointer">연결 정보</summary>
      <p className="mt-2 break-all">{status?.cliPath ?? '설치된 공식 Codex 실행기를 찾지 못했습니다.'}</p>
      <p className="mt-2">{status?.cliVersion}</p>
      <p className="mt-2">로그인 정보는 Luxinus 전용 Codex 설정에 저장됩니다. 개발용 Codex 계정 설정에는 영향을 주지 않습니다.</p>
    </details>
    {busy && <p role="status">연결 상태를 변경하는 중…</p>}
    {error && <p role="alert" className="whitespace-pre-wrap">{error}</p>}
  </section>
}
