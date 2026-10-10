import { validateEditState } from '../shared/edit-validation'
import { randomUUID } from 'node:crypto'
import { CODEX_REASONING_EFFORTS } from '../shared/codex'
import { agentEditContext, applyAgentEditPatch, validateAgentActions, validateAgentContext, validateAgentToolCall, validateAgentEdit,
  type AgentAppAction, type AgentAppContext, type AgentChatRequest, type AgentToolCapabilities } from '../shared/agent-tools'
import { defaultEditState, zeroMaskAdjust, type EditState, type Mask } from '../shared/edits'
import type { PortraitAnalyzeResult, PortraitRegion, PortraitRegionResult } from '../shared/portrait'
import type { AgentCaptureResult, AgentCaptureTarget } from '../shared/agent-vision'
import type { CodexToolOutput } from './codex-client'

export interface AgentSessionVision {
  capabilities: AgentToolCapabilities
  analyze(regions?: PortraitRegion[]): Promise<PortraitAnalyzeResult>
  screenshot(target: AgentCaptureTarget, edit: EditState, overlayMaskId?: string): Promise<AgentCaptureResult>
  assertCurrent(): Promise<void>
}

export function validateChatRequest(value: unknown): AgentChatRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('잘못된 AI 대화 요청입니다.')
  const request = value as AgentChatRequest
  if (typeof request.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(request.requestId) || !['local', 'codex'].includes(request.provider) || !['ask', 'propose'].includes(request.mode)) throw new Error('AI 대화 작업 또는 제공자가 올바르지 않습니다.')
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 4000) throw new Error('요청을 1~4,000자로 입력해 주세요.')
  if (request.modelId !== undefined && (typeof request.modelId !== 'string' || !/^[a-zA-Z0-9._/-]{1,100}$/.test(request.modelId))) throw new Error('잘못된 Codex 모델 ID입니다.')
  if (request.reasoningEffort !== undefined && !CODEX_REASONING_EFFORTS.includes(request.reasoningEffort)) throw new Error('잘못된 추론 강도입니다.')
  if (request.allowVision !== undefined && typeof request.allowVision !== 'boolean') throw new Error('사진 보기 허용 여부가 올바르지 않습니다.')
  if (request.photoId !== null && (typeof request.photoId !== 'string' || request.photoId.length > 8192)) throw new Error('잘못된 현재 사진입니다.')
  if (!Array.isArray(request.history) || request.history.length > 20 || request.history.some(message => !message || !['user', 'assistant'].includes(message.role) || typeof message.text !== 'string' || message.text.length > 1500)) throw new Error('대화 기록은 메시지당 1,500자, 최대 20개까지 보낼 수 있습니다.')
  if (!Array.isArray(request.attachmentIds) || request.attachmentIds.length > 4 || new Set(request.attachmentIds).size !== request.attachmentIds.length || request.attachmentIds.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(id))) throw new Error('첨부 이미지 ID가 올바르지 않습니다.')
  const context = validateAgentContext(request.context)
  if ((request.photoId === null) !== (context.currentPhotoId === null) || (request.photoId === null) !== (request.baseEdit === null)) throw new Error('현재 사진과 보정 상태가 일치하지 않습니다.')
  const baseEdit = request.baseEdit === null ? null : validateEditState(request.baseEdit)
  if (Buffer.byteLength(JSON.stringify(baseEdit)) > 8 * 1024 * 1024) throw new Error('현재 보정 상태가 AI 요청 크기 제한을 초과했습니다.')
  return { ...request, context, baseEdit, history: request.history.map(message => ({ role: message.role, text: message.text })) }
}

/** Per-request scratch state. No IO or app mutation; only approveChat commits it. */
export class AgentChatSession {
  edit: EditState | null = null
  actions: AgentAppAction[] = []
  private reasons: string[] = []
  private regions = new Map<string, PortraitRegionResult>()
  private analyses = 0
  private screenshots = 0
  constructor(readonly mode: 'ask' | 'propose', readonly context: AgentAppContext, readonly base: EditState | null, private readonly vision?: AgentSessionVision) {}
  get reason(): string { return this.reasons.join('\n').slice(0, 1600) }
  call(name: string, input: unknown): object {
    validateAgentToolCall(this.mode, name, input, this.vision?.capabilities)
    const args = input as Record<string, any>
    if (name === 'luxinus_read_state') {
      const context = structuredClone(this.context)
      context.filter.text = ''
      return { context, edit: agentEditContext(this.base), stagedEdit: agentEditContext(this.edit), stagedActions: this.actions }
    }
    if (name === 'luxinus_list_photos') return { photos: this.context.photos, libraryIncluded: this.context.libraryIncluded }
    if (name === 'luxinus_create_mask' || name === 'luxinus_update_mask') {
      if (!this.base) throw new Error('먼저 보정할 사진을 선택해 주세요.')
      const current = this.edit ?? this.base
      const masks = structuredClone(current.masks)
      if (name === 'luxinus_create_mask') {
        if (masks.length >= 16) throw new Error('마스크는 최대 16개까지 제안할 수 있습니다.')
        const { regionId, reason: _reason, ...fields } = args
        const created: Mask = { ...fields, kind: fields.kind, name: fields.name, id: randomUUID(), enabled: fields.enabled ?? true, density: fields.density ?? 1, adjust: { ...zeroMaskAdjust(), ...fields.adjust } }
        if (created.kind === 'semantic') created.semantic = this.region(regionId).semantic
        else if (regionId !== undefined) throw new Error('인물 영역은 semantic 마스크에만 사용할 수 있습니다.')
        masks.push(created)
      } else {
        const index = masks.findIndex(mask => mask.id === args.maskId)
        if (index < 0 || index >= 16) throw new Error('공유된 마스크 ID가 아닙니다.')
        const previous = masks[index]
        const { regionId, ...patch } = args.patch
        if (patch.kind !== undefined && patch.kind !== previous.kind) throw new Error('기존 마스크 종류는 바꿀 수 없습니다.')
        const updated = { ...previous, ...patch, adjust: { ...previous.adjust, ...patch.adjust } }
        if (regionId !== undefined) {
          if (previous.kind !== 'semantic') throw new Error('인물 영역은 semantic 마스크에만 사용할 수 있습니다.')
          updated.semantic = this.region(regionId).semantic
        }
        masks[index] = updated
      }
      const edit = validateAgentEdit({ ...current, masks })
      validateAgentActions(this.actions, this.context, true)
      this.edit = edit
    } else if (name === 'luxinus_crop') {
      if (!this.base) throw new Error('먼저 자를 사진을 선택해 주세요.')
      const edit = applyAgentEditPatch(this.edit ?? this.base, { crop: args.crop })
      validateAgentActions(this.actions, this.context, true)
      this.edit = edit
    } else if (name === 'luxinus_stage_edit') {
      if (!this.base) throw new Error('먼저 보정할 사진을 선택해 주세요.')
      if ('masks' in args.patch && this.base.masks.length > 16) throw new Error('마스크 문맥이 잘린 사진은 마스크를 대체할 수 없습니다.')
      if ('curves' in args.patch && Object.values(this.base.curves).some(points => points.length > 64)) throw new Error('곡선 문맥이 잘린 사진은 곡선을 대체할 수 없습니다.')
      const edit = applyAgentEditPatch(this.edit ?? this.base, args.patch)
      validateAgentActions(this.actions, this.context, true)
      this.edit = edit
    } else if (name === 'luxinus_stage_actions') {
      const actions = validateAgentActions([...this.actions, ...args.actions], this.context, !!this.edit)
      this.actions = actions
    } else throw new Error('이 도구에는 비동기 사진 처리 경로가 필요합니다.')
    this.reasons.push(args.reason)
    return { staged: true, requiresUserApproval: true, edit: agentEditContext(this.edit), actions: this.actions }
  }
  private region(id: unknown): PortraitRegionResult {
    const result = typeof id === 'string' ? this.regions.get(id) : null
    if (!result) throw new Error('이 요청에서 실제 분석한 인물 영역 ID가 필요합니다.')
    return structuredClone(result)
  }
  async callAsync(name: string, input: unknown): Promise<object | CodexToolOutput> {
    validateAgentToolCall(this.mode, name, input, this.vision?.capabilities)
    await this.vision?.assertCurrent()
    const args = input as Record<string, any>
    if (name === 'luxinus_analyze_people') {
      if (!this.vision || !this.base || ++this.analyses > 2) throw new Error('인물 분석은 현재 사진에서 요청당 최대 2회 가능합니다.')
      const result = await this.vision.analyze(args.regions)
      await this.vision.assertCurrent()
      if (!result.ok || !result.regions?.length) {
        // Native errors can contain local file names; return fixed messages only.
        const detail = result.message ?? ''
        const message = /다른.*분석/.test(detail) ? '다른 인물 분석이 진행 중입니다. 잠시 후 다시 요청하세요.'
          : /설치|모델.*없/.test(detail) ? '로컬 인물 분석 모델이 설치되지 않았습니다.'
          : /체크섬|검증/.test(detail) ? '로컬 인물 모델 검증에 실패했습니다. 모델 상태를 확인해 주세요.'
          : /취소/.test(detail) ? '인물 분석이 취소되었습니다.'
          : /변경/.test(detail) ? '사진 또는 보정 상태가 변경되어 분석을 중단했습니다.'
          : '요청한 인물 영역을 확인하지 못했습니다. 영역을 만들지 않았습니다.'
        return { ok: false, message, regions: [] }
      }
      const regions = result.regions.map(region => {
        const id = randomUUID(); this.regions.set(id, structuredClone(region))
        return { id, label: region.label, region: region.region, bounds: region.bounds, coverageFraction: region.coverageFraction }
      })
      return { regions, facesDetected: result.facesDetected, warnings: result.warnings, sourceSpace: 'uncropped original photo' }
    }
    if (name === 'luxinus_screenshot') {
      if (!this.vision || !this.base || ++this.screenshots > 4) throw new Error('사진 미리보기는 요청당 최대 4회 가능합니다.')
      const edit = args.target === 'original' ? defaultEditState() : args.target === 'current' ? this.base : this.edit ?? this.base
      if (args.overlayMaskId && !edit.masks.some(mask => mask.id === args.overlayMaskId)) throw new Error('이 미리보기에는 해당 마스크가 없습니다.')
      const result = await this.vision.screenshot(args.target, structuredClone(edit), args.overlayMaskId)
      await this.vision.assertCurrent()
      return { contentItems: [
        { type: 'inputText', text: JSON.stringify({ target: args.target, width: result.width, height: result.height, overlayMaskId: args.overlayMaskId ?? null, staged: args.target === 'staged', saved: false }) },
        { type: 'inputImage', imageUrl: result.dataUrl }
      ] }
    }
    return this.call(name, input)
  }
}
