export interface CodexStatus {
  phase: 'unavailable' | 'signed-out' | 'signing-in' | 'ready' | 'error'
  cliPath: string | null
  cliVersion: string | null
  email: string | null
  planType: string | null
  message: string
  loginId: string | null
}
export interface CodexLogin { loginId: string; authUrl: string }
export const CODEX_REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number]
export interface CodexModel {
  id: string
  displayName: string
  isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: CodexReasoningEffort; description: string }[]
  defaultReasoningEffort: CodexReasoningEffort | null
  inputModalities: ('text' | 'image')[]
}
