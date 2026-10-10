import type { AgentProvider } from '../../../../shared/agent-provider'

export function AiProviderPicker({ value, onChange, disabled = false }: {
  value: AgentProvider; onChange: (value: AgentProvider) => void; disabled?: boolean
}): JSX.Element {
  return <fieldset disabled={disabled} className="mb-4">
    <legend className="text-[12px] text-[#a3a3a3] mb-2">사용할 AI</legend>
    <div className="grid grid-cols-2 gap-2">
      {([['local', '로컬 모델', '내 Mac에서 실행'], ['codex', 'GPT Codex', 'ChatGPT 계정으로 연결']] as const).map(([id, title, detail]) =>
        <label key={id} className={`flex gap-2 items-center p-3 rounded-md border cursor-pointer ${value === id ? 'border-[#b7a8f7] bg-[#b7a8f7]/10' : 'border-[#454545]'} ${disabled ? 'opacity-50' : ''}`}>
          <input type="radio" name="ai-provider" value={id} checked={value === id} onChange={() => onChange(id)} className="accent-[#b7a8f7]" />
          <span><span className="block text-[13px] font-medium">{title}</span><span className="block text-[11px] text-[#a3a3a3] mt-0.5">{detail}</span></span>
        </label>)}
    </div>
  </fieldset>
}
