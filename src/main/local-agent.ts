import { app, dialog, ipcMain, shell } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { defaultEditState } from '../shared/edits'
import { validateEditState } from '../shared/edit-validation'
import { AGENT_CONTROLS, agentOutputSchema, agentPrompt, editFingerprint, parseAgentOutput, unsupportedAgentRequest, validateRequestedAgentPatch,
  type AgentRequest, type AgentApproval, type AgentProposal, type ApprovedAgentEdit } from '../shared/local-agent'
import { assertAuthorizedPhoto, assertTrustedSender } from './file-policy'
import { readEditSnapshot, saveEdits } from './edits'
import { LocalModel } from './local-model'
import { CodexClient, type CodexToolOutput } from './codex-client'
import { codexOutputSchema, codexPrompt, parseCodexOutput } from '../shared/agent-provider'
import { atomicReplace, contentHash, readRegularFile, serializeFile } from './safe-file'
import { AgentAttachments } from './agent-attachments'
import { agentChatPrompt, agentToolDefinitions,
  type AgentChatResponse, type AgentChatProposal, type AgentChatApproval, type ApprovedAgentChat, type AgentAttachment } from '../shared/agent-tools'
import { AgentChatSession, validateChatRequest } from './agent-chat-session'
import { agentEditDigest, type AgentToolProgress } from '../shared/agent-vision'
import { requestAgentCapture, cancelAgentCaptures } from './agent-capture'
import { analyzePortraitImage, cancelPortrait } from './portrait'
import { getPortraitModelFingerprint } from './portrait-model-runner'
import { IpcChannels } from '../shared/ipc-channels'

interface StagedProposal { proposal: AgentProposal; diskHash: string | null; expiresAt: number }
const stages = new Map<string, StagedProposal>()
const chatStages = new Map<string, { proposal: AgentChatProposal; owner: number; diskHash: string | null; expiresAt: number }>()
const attachments = new AgentAttachments()
let model: LocalModel | null = null
let codex: CodexClient | null = null
let busy = false
let requestInFlight: string | null = null
let chatOwner: number | null = null
const cancelledRequests = new Set<string>()

function validateId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(value)) throw new Error('잘못된 작업 ID입니다.')
}
async function audit(event: string, photoId: string | null, detail: object): Promise<void> {
  const dir = join(app.getPath('userData'), 'agent-journal')
  await fs.mkdir(dir, { recursive: true })
  // Do not persist prompts, model prose, paths, EXIF or environment variables.
  const line = { at: new Date().toISOString(), event,
    photo: photoId ? createHash('sha256').update(photoId).digest('hex') : null, ...detail }
  const target = join(await fs.realpath(dir), `${new Date().toISOString().slice(0, 10)}.jsonl`)
  await serializeFile(target, async () => {
    const previous = await readRegularFile(target, 8 * 1024 * 1024)
    await atomicReplace(target, (previous?.toString('utf8') ?? '') + JSON.stringify(line) + '\n',
      previous ? contentHash(previous) : null, async () => {})
  })
}
async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('다른 AI 보정 작업이 진행 중입니다. 먼저 끝내거나 중단해 주세요.')
  busy = true
  try { return await fn() } finally {
    if (requestInFlight) {
      cancelAgentCaptures(requestInFlight)
      if (chatOwner !== null) await cancelPortrait(chatOwner, requestInFlight).catch(() => false)
    }
    busy = false; requestInFlight = null; chatOwner = null; cancelledRequests.clear()
  }
}
export const isLocalAgentBusy = (): boolean => busy
export function stopLocalAgent(): void {
  if (requestInFlight) {
    cancelledRequests.add(requestInFlight); cancelAgentCaptures(requestInFlight)
    if (chatOwner !== null) void cancelPortrait(chatOwner, requestInFlight).catch(() => false)
  }
  void model?.unload(); void codex?.shutdown(); attachments.clear(); stages.clear(); chatStages.clear()
}

export function registerLocalAgentHandlers(): void {
  model = new LocalModel(join(app.getPath('userData'), 'models'))
  codex = new CodexClient(join(app.getPath('userData'), 'codex'))
  const codexHandle = (name: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(`codex:${name}`, (event, ...args: unknown[]) => { assertTrustedSender(event); return fn(...args) })
  }
  codexHandle('status', () => codex!.status())
  codexHandle('login', () => exclusive(async () => {
    const login = await codex!.login()
    try { await shell.openExternal(login.authUrl) }
    catch { await codex!.cancelLogin(login.loginId); throw new Error('브라우저를 열지 못했습니다. 다시 로그인해 주세요.') }
    return codex!.status()
  }))
  codexHandle('cancelLogin', async (loginId?: unknown) => {
    if (loginId !== undefined && (typeof loginId !== 'string' || loginId.length > 128)) throw new Error('잘못된 로그인 작업 ID입니다.')
    await codex!.cancelLogin(loginId as string | undefined)
    return codex!.status()
  })
  codexHandle('logout', () => exclusive(() => codex!.logout()))
  codexHandle('models', () => codex!.models())
  const handle = (name: string, fn: (...args: any[]) => unknown): void => {
    ipcMain.handle(`localAgent:${name}`, (event, ...args: unknown[]) => {
      assertTrustedSender(event)
      return fn(...args)
    })
  }
  ipcMain.handle('localAgent:pickImages', async event => {
    assertTrustedSender(event)
    const selected = await dialog.showOpenDialog({ title: 'AI 대화에 첨부할 이미지 선택', properties: ['openFile', 'multiSelections'], filters: [{ name: '이미지', extensions: ['jpg', 'jpeg', 'png', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif'] }] })
    if (selected.canceled) return []
    if (selected.filePaths.length > 4) throw new Error('이미지는 한 번에 최대 4개 선택해 주세요.')
    const prepared: AgentAttachment[] = []
    try {
      for (const path of selected.filePaths) {
        const bytes = await readRegularFile(path, 16 * 1024 * 1024)
        if (!bytes) throw new Error('선택한 이미지를 찾을 수 없습니다.')
        prepared.push(await attachments.prepare(event.sender.id, bytes, path))
      }
      return prepared
    } catch (error) { attachments.release(event.sender.id, prepared.map(item => item.id)); throw error }
  })
  ipcMain.handle('localAgent:prepareImage', (event, input: unknown) => { assertTrustedSender(event); return attachments.prepareDataUrl(event.sender.id, input) })
  ipcMain.handle('localAgent:releaseImages', (event, ids: unknown) => { assertTrustedSender(event); attachments.release(event.sender.id, ids) })
  handle('status', () => model!.status())
  handle('pickRuntime', () => exclusive(async () => {
    const result = await dialog.showOpenDialog({ title: 'llama-completion 실행 파일 선택', properties: ['openFile'] })
    return result.canceled ? model!.status() : model!.selectRuntime(result.filePaths[0])
  }))
  handle('pickModel', () => exclusive(async () => {
    const result = await dialog.showOpenDialog({ title: '공식 Qwen2.5 1.5B Q4_K_M 모델 선택', properties: ['openFile'], filters: [{ name: 'GGUF 모델', extensions: ['gguf'] }] })
    return result.canceled ? model!.status() : model!.selectModel(result.filePaths[0])
  }))
  handle('unload', () => {
    if (requestInFlight) cancelledRequests.add(requestInFlight)
    return model!.unload()
  })
  handle('cancel', (id: unknown) => {
    validateId(id)
    if (id !== requestInFlight) return false
    cancelledRequests.add(id)
    cancelAgentCaptures(id)
    if (chatOwner !== null) void cancelPortrait(chatOwner, id)
    model!.cancel(id)
    codex!.cancel(id)
    return true
  })
  handle('smokeTest', (id: unknown) => exclusive(async () => {
    validateId(id)
    requestInFlight = id
    const scope = randomUUID()
    try {
      const result = await model!.infer(agentPrompt(scope, defaultEditState(), '그림자 값을 정확히 20으로 바꿔줘. 다른 항목은 바꾸지 마.'), agentOutputSchema(scope), id, true, () => cancelledRequests.has(id))
      if (cancelledRequests.has(id)) throw new Error('모델 검사를 취소했습니다.')
      const output = parseAgentOutput(result.text, scope)
      if (output.tool !== 'proposeEditPatch' || output.patch.shadows !== 20 || Object.keys(output.patch).length !== 1 || !/[가-힣]/.test(output.reason)) {
        throw new Error('한국어 지시 검사에 실패했습니다. 그림자 20만 변경하고 한국어로 이유를 설명해야 합니다.')
      }
      model!.markTest(result.durationMs)
      await audit('smoke-test-passed', null, { durationMs: result.durationMs })
      return model!.status()
    } catch (err) { model!.fail((err as Error).message); throw err }
  }))
  const propose = async (input: AgentRequest): Promise<AgentProposal> => {
    if (!input || typeof input !== 'object') throw new Error('잘못된 보정 요청입니다.')
    validateId(input.requestId)
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 1500) throw new Error('요청을 1~1,500자로 입력해 주세요.')
    const provider = input.provider ?? 'local'
    if (provider !== 'local' && provider !== 'codex') throw new Error('지원하지 않는 AI 제공자입니다.')
    if (input.modelId !== undefined && (typeof input.modelId !== 'string' || !/^[a-zA-Z0-9._/-]{1,100}$/.test(input.modelId))) throw new Error('잘못된 Codex 모델 이름입니다.')
    const unsupported = provider === 'local' ? unsupportedAgentRequest(input.prompt) : null
    if (unsupported) throw new Error(`현재 지원 범위 밖의 요청입니다: ${unsupported}`)
    requestInFlight = input.requestId
    const photoId = await assertAuthorizedPhoto(input.photoId)
    const baseEdit = validateEditState(input.baseEdit)
    const snapshot = await readEditSnapshot(photoId)
    if (editFingerprint(snapshot.edits ?? defaultEditState()) !== editFingerprint(baseEdit)) throw new Error('사진의 저장 상태가 바뀌었습니다. 저장을 완료한 뒤 다시 요청해 주세요.')
    const scope = randomUUID()
    const result = provider === 'codex'
      ? await codex!.infer(codexPrompt(scope, baseEdit, input.prompt), codexOutputSchema(scope), input.requestId, () => cancelledRequests.has(input.requestId), input.modelId)
      : await model!.infer(agentPrompt(scope, baseEdit, input.prompt), agentOutputSchema(scope), input.requestId, false, () => cancelledRequests.has(input.requestId))
    if (cancelledRequests.has(input.requestId)) throw new Error('AI 요청을 취소했습니다. 적용된 변경은 없습니다.')
    const output = provider === 'codex' ? parseCodexOutput(result.text, scope) : parseAgentOutput(result.text, scope)
    if (output.tool === 'unsupported') throw new Error(`현재 지원 범위 밖의 요청입니다: ${output.reason}`)
    if (provider === 'local') validateRequestedAgentPatch(input.prompt, output.patch)
    for (const key of Object.keys(output.patch) as (keyof typeof AGENT_CONTROLS)[]) {
      if (output.patch[key] === baseEdit[key]) delete output.patch[key]
    }
    if (!Object.keys(output.patch).length) throw new Error('현재 보정값과 다른 제안이 없습니다.')
    const proposal: AgentProposal = { proposalId: randomUUID(), photoId, baseEdit, patch: output.patch,
      reason: output.reason, createdAt: new Date().toISOString(), durationMs: result.durationMs }
    const now = Date.now()
    for (const [key, entry] of stages) if (entry.expiresAt < now) stages.delete(key)
    if (stages.size >= 20) stages.delete(stages.keys().next().value!)
    stages.set(proposal.proposalId, { proposal, diskHash: snapshot.hash, expiresAt: now + 10 * 60_000 })
    await audit('proposed', photoId, { provider, proposalId: proposal.proposalId, before: Object.fromEntries(Object.keys(proposal.patch).map(k => [k, baseEdit[k as keyof typeof AGENT_CONTROLS]])), after: proposal.patch })
    return proposal
  }
  handle('propose', (input: AgentRequest) => exclusive(() => propose(input)))
  ipcMain.handle('localAgent:chat', (event, value: unknown) => {
    assertTrustedSender(event)
    return exclusive(async (): Promise<AgentChatResponse> => {
      const input = validateChatRequest(value)
      requestInFlight = input.requestId
      chatOwner = event.sender.id
      const images = attachments.resolve(event.sender.id, input.attachmentIds)
      const photoId = input.photoId === null ? null : await assertAuthorizedPhoto(input.photoId)
      const baseEdit = input.baseEdit
      const snapshot = photoId ? await readEditSnapshot(photoId) : { edits: null, hash: null }
      if (baseEdit && editFingerprint(snapshot.edits ?? defaultEditState()) !== editFingerprint(baseEdit)) throw new Error('사진의 저장 상태가 바뀌었습니다. 저장을 완료한 뒤 다시 요청해 주세요.')
      let message: string, proposedEdit: typeof baseEdit = null, durationMs = 0, reason = ''
      const source = photoId ? await fs.stat(photoId) : null
      const cancelled = (): boolean => cancelledRequests.has(input.requestId) || requestInFlight !== input.requestId || event.sender.isDestroyed()
      const assertCurrent = async (): Promise<void> => {
        if (cancelled()) throw new Error('사진 작업이 취소되었습니다.')
        if (photoId && source) {
          const current = await fs.stat(await assertAuthorizedPhoto(photoId))
          if (['dev', 'ino', 'mtimeMs', 'ctimeMs', 'size'].some(key => current[key as keyof typeof current] !== source[key as keyof typeof source])) throw new Error('원본 사진이 변경되었습니다. 다시 요청해 주세요.')
          if ((await readEditSnapshot(photoId)).hash !== snapshot.hash) throw new Error('보정 저장 상태가 바뀌었습니다. 다시 요청해 주세요.')
        }
        if (cancelled()) throw new Error('사진 작업이 취소되었습니다.')
      }
      const capabilities = { vision: input.provider === 'codex' && input.allowVision === true && !!photoId && !!baseEdit && codex!.supportsImages(input.modelId), portrait: false }
      if (capabilities.vision) capabilities.portrait = !!await getPortraitModelFingerprint().catch(() => null)
      const baseDigest = baseEdit ? await agentEditDigest(baseEdit) : ''
      const session = new AgentChatSession(input.mode, input.context, baseEdit, {
        capabilities, assertCurrent,
        analyze: async regions => {
          if (!capabilities.portrait || !photoId || !source) throw new Error('현재 사진의 인물 분석이 허용되지 않았습니다.')
          const capture = await requestAgentCapture(event.sender, { requestId: input.requestId, photoId, baseEditFingerprint: baseDigest, edit: defaultEditState(), target: 'original' }, cancelled)
          await assertCurrent()
          return analyzePortraitImage(event.sender.id, { requestId: input.requestId, filePath: photoId, sourceMtimeMs: source.mtimeMs, sourceSize: source.size, dataUrl: capture.dataUrl, regions })
        },
        screenshot: async (target, edit, overlayMaskId) => {
          if (!capabilities.vision || !photoId) throw new Error('현재 사진의 추가 전송이 허용되지 않았습니다.')
          await assertCurrent()
          return requestAgentCapture(event.sender, { requestId: input.requestId, photoId, baseEditFingerprint: baseDigest, edit, target, overlayMaskId }, cancelled)
        }
      })
      if (input.provider === 'local') {
        if (images.length || input.mode === 'ask' || !photoId || !baseEdit) throw new Error('설치된 로컬 모델은 사진 한 장의 기본 보정값 제안만 지원합니다. 이미지 대화와 앱 동작은 ChatGPT Codex를 선택해 주세요.')
        const suggestion = await propose({ ...input, photoId, baseEdit })
        stages.delete(suggestion.proposalId)
        proposedEdit = validateEditState({ ...baseEdit, ...suggestion.patch })
        message = reason = suggestion.reason; durationMs = suggestion.durationMs
      } else {
        const result = await codex!.infer(agentChatPrompt(input.context, baseEdit, input.history, input.prompt, !!images.length, input.mode, capabilities) + '\n' + attachments.describe(event.sender.id, input.attachmentIds), null,
          input.requestId, () => cancelledRequests.has(input.requestId), input.modelId,
          { images, reasoningEffort: input.reasoningEffort, dynamicTools: agentToolDefinitions(input.mode, capabilities), allowImageResults: capabilities.vision,
            onToolCall: async (name, args) => {
              const operationId = randomUUID()
              const labels: Record<string, string> = { luxinus_read_state: '사진 상태 확인', luxinus_list_photos: '사진 목록 확인', luxinus_stage_edit: '보정 제안', luxinus_stage_actions: '앱 동작 제안', luxinus_analyze_people: '인물 영역 분석', luxinus_create_mask: '마스크 만들기', luxinus_update_mask: '마스크 수정', luxinus_crop: '자르기 제안', luxinus_screenshot: '사진 미리보기 확인' }
              const progress = (status: AgentToolProgress['status'], message: string, imageDataUrl?: string): void => {
                if (!cancelled()) event.sender.send(IpcChannels.localAgent.toolProgress, { requestId: input.requestId, operationId, tool: name, status, message, imageDataUrl } satisfies AgentToolProgress)
              }
              await assertCurrent()
              progress('started', labels[name] ?? '사진 도구 실행')
              try {
                const output = await session.callAsync(name, args)
                await assertCurrent()
                if ('ok' in output && output.ok === false) {
                  const message = (output as { message?: unknown }).message
                  progress('failed', typeof message === 'string' ? message : '사진 도구 결과를 확인하지 못했습니다.')
                  return output
                }
                let thumbnail: string | undefined
                if ('contentItems' in output) {
                  const image = (output as CodexToolOutput).contentItems.find(item => item.type === 'inputImage')
                  if (image?.type === 'inputImage') {
                    const bytes = Buffer.from(image.imageUrl.slice(image.imageUrl.indexOf(',') + 1), 'base64')
                    const preview = await sharp(bytes).resize({ width: 384, height: 384, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer()
                    thumbnail = `data:image/jpeg;base64,${preview.toString('base64')}`
                  }
                }
                await assertCurrent()
                progress('completed', `${labels[name] ?? '사진 도구'} 완료${name.includes('mask') || name === 'luxinus_crop' || name.startsWith('luxinus_stage') ? ' · 적용 대기' : ''}`, thumbnail)
                return output
              } catch (error) {
                progress('failed', '사진 도구를 완료하지 못했습니다. 적용된 변경은 없습니다.')
                throw error
              }
            } })
        message = result.text; durationMs = result.durationMs; proposedEdit = session.edit; reason = session.reason
      }
      await assertCurrent()
      if (proposedEdit && baseEdit && editFingerprint(proposedEdit) === editFingerprint(baseEdit)) proposedEdit = null
      if (!proposedEdit && !session.actions.length) return { message, proposal: null }
      const proposal: AgentChatProposal = { proposalId: randomUUID(), photoId, baseEdit, edit: proposedEdit,
        actions: session.actions, reason, createdAt: new Date().toISOString(), durationMs }
      const now = Date.now()
      for (const [key, entry] of chatStages) if (entry.expiresAt < now) chatStages.delete(key)
      if (chatStages.size >= 20) chatStages.delete(chatStages.keys().next().value!)
      chatStages.set(proposal.proposalId, { proposal, owner: event.sender.id, diskHash: snapshot.hash, expiresAt: now + 10 * 60_000 })
      await audit('chat-proposed', photoId, { provider: input.provider, proposalId: proposal.proposalId, edit: !!proposal.edit, actions: proposal.actions.map(action => action.kind), attachments: images.length })
      return { message, proposal }
    })
  })
  ipcMain.handle('localAgent:approveChat', (event, input: AgentChatApproval) => {
    assertTrustedSender(event)
    return exclusive(async (): Promise<ApprovedAgentChat> => {
      if (!input || typeof input !== 'object') throw new Error('잘못된 승인 요청입니다.')
      validateId(input.proposalId)
      const entry = chatStages.get(input.proposalId)
      if (!entry || entry.owner !== event.sender.id || entry.expiresAt < Date.now()) throw new Error('제안이 만료되었거나 이미 적용되었습니다. 다시 요청해 주세요.')
      const photoId = input.photoId === null ? null : await assertAuthorizedPhoto(input.photoId)
      const baseEdit = input.baseEdit === null ? null : validateEditState(input.baseEdit)
      if (photoId !== entry.proposal.photoId || (baseEdit ? editFingerprint(baseEdit) : null) !== (entry.proposal.baseEdit ? editFingerprint(entry.proposal.baseEdit) : null)) throw new Error('제안 이후 사진 또는 보정값이 바뀌었습니다. 다시 요청해 주세요.')
      if (photoId) {
        const current = await readEditSnapshot(photoId)
        if (current.hash !== entry.diskHash) throw new Error('제안 이후 저장 상태가 변경되었습니다. 다시 요청해 주세요.')
      }
      let saved = false
      if (entry.proposal.edit) {
        if (!photoId || !baseEdit) throw new Error('보정할 사진이 없습니다.')
        await audit('chat-approved', photoId, { proposalId: input.proposalId })
        saved = await saveEdits(photoId, validateEditState(entry.proposal.edit), entry.diskHash)
        if (!saved) throw new Error('보정 저장에 실패했습니다. 제안은 유지됩니다.')
      }
      chatStages.delete(input.proposalId)
      await audit('chat-released', photoId, { proposalId: input.proposalId, saved, actions: entry.proposal.actions.map(action => action.kind) }).catch(() => {})
      return { photoId, baseEdit: entry.proposal.baseEdit, edit: entry.proposal.edit, saved, actions: entry.proposal.actions }
    })
  })
  handle('approve', (input: AgentApproval) => exclusive(async (): Promise<ApprovedAgentEdit> => {
    if (!input || typeof input !== 'object') throw new Error('잘못된 승인 요청입니다.')
    validateId(input.proposalId)
    const entry = stages.get(input.proposalId)
    if (!entry || entry.expiresAt < Date.now()) throw new Error('제안이 만료되었거나 이미 적용되었습니다. 다시 요청해 주세요.')
    const photoId = await assertAuthorizedPhoto(input.photoId)
    const baseEdit = validateEditState(input.baseEdit)
    if (photoId !== entry.proposal.photoId || editFingerprint(baseEdit) !== editFingerprint(entry.proposal.baseEdit)) throw new Error('제안 이후 사진 또는 보정값이 바뀌었습니다. 다시 요청해 주세요.')
    const edit = validateEditState({ ...entry.proposal.baseEdit, ...entry.proposal.patch })
    await audit('approved', photoId, { proposalId: input.proposalId, before: entry.proposal.baseEdit, after: edit })
    const saved = await saveEdits(photoId, edit, entry.diskHash)
    if (!saved) throw new Error('보정 저장에 실패했습니다. 파일 권한 또는 외부 변경을 확인해 주세요. 제안은 유지됩니다.')
    stages.delete(input.proposalId)
    // Saving succeeded; a journal append failure must never masquerade as an
    // unapplied edit and cause the renderer to retry the same transaction.
    await audit('saved', photoId, { proposalId: input.proposalId }).catch(() => {})
    return { photoId, baseEdit: entry.proposal.baseEdit, edit, saved: true }
  }))
}
