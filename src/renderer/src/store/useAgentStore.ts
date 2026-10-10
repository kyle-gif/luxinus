import { create } from 'zustand'
import type { EditState } from '../../../shared/edits'
import type { AgentProvider } from '../../../shared/agent-provider'

export interface AgentComparison {
  photoId: string
  before: EditState
  after: EditState
  mode: 'before' | 'after' | 'split'
  label: string
  proposalId?: string
}
function savedProvider(): AgentProvider {
  try { return localStorage.getItem('luxinus.aiProvider') === 'codex' ? 'codex' : 'local' } catch { return 'local' }
}
interface AgentState {
  open: boolean
  setOpen: (open: boolean) => void
  provider: AgentProvider
  setProvider: (provider: AgentProvider) => void
  comparison: AgentComparison | null
  setComparison: (comparison: AgentComparison | null) => void
  activeRequest: { requestId: string; photoId: string | null; allowVision: boolean; baseEdit: EditState } | null
  setActiveRequest: (request: AgentState['activeRequest']) => void
}
export const useAgentStore = create<AgentState>((set) => ({
  open: true,
  setOpen: (open) => set(open ? { open } : { open, comparison: null }),
  provider: savedProvider(),
  setProvider: (provider) => {
    try { localStorage.setItem('luxinus.aiProvider', provider) } catch { /* Session choice remains usable. */ }
    set({ provider, comparison: null })
  },
  comparison: null,
  setComparison: (comparison) => set({ comparison }),
  activeRequest: null,
  setActiveRequest: (activeRequest) => set({ activeRequest })
}))
