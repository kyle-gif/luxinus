import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { ipcMain, type IpcMainEvent, type WebContents } from 'electron'
import { IpcChannels } from '../shared/ipc-channels'
import { AGENT_CAPTURE_TIMEOUT_MS, type AgentCaptureRequest, type AgentCaptureResponse, type AgentCaptureResult } from '../shared/agent-vision'
import { assertAuthorizedPhoto } from './file-policy'
import { sanitizeAgentCapture } from './agent-capture-image'

interface PendingCapture {
  sender: WebContents
  documentUrl: string
  request: AgentCaptureRequest
  cancelled: () => boolean
  receiving: boolean
  finish: (error: Error | null, result?: AgentCaptureResult) => void
}
const pending = new Map<string, PendingCapture>()

/** Only the active, authorized chat calls this broker. No paths come from tools. */
export async function requestAgentCapture(sender: WebContents, input: Omit<AgentCaptureRequest, 'captureId'>, cancelled: () => boolean = () => false): Promise<AgentCaptureResult> {
  if (cancelled() || sender.isDestroyed()) throw new Error('사진 확인이 취소되었습니다.')
  if ([...pending.values()].some(item => item.sender === sender)) throw new Error('다른 사진 스크린샷을 준비하고 있습니다.')
  const path = await assertAuthorizedPhoto(input.photoId)
  const source = await stat(path)
  if (cancelled() || sender.isDestroyed()) throw new Error('사진 확인이 취소되었습니다.')
  const request: AgentCaptureRequest = { ...input, captureId: randomUUID(), sourceMtimeMs: source.mtimeMs, sourceSize: source.size }
  return new Promise<AgentCaptureResult>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>, poll: ReturnType<typeof setInterval>
    const onDestroyed = (): void => finish(new Error('사진을 열었던 창이 닫혔습니다.'))
    const finish = (error: Error | null, result?: AgentCaptureResult): void => {
      if (!pending.delete(request.captureId)) return
      clearTimeout(timer); clearInterval(poll)
      sender.removeListener('destroyed', onDestroyed)
      if (error) reject(error)
      else if (result) resolve(result)
    }
    pending.set(request.captureId, { sender, request, documentUrl: sender.getURL(), cancelled, receiving: false, finish })
    sender.once('destroyed', onDestroyed)
    timer = setTimeout(() => finish(new Error('사진 스크린샷을 만드는 시간이 초과되었습니다.')), AGENT_CAPTURE_TIMEOUT_MS)
    poll = setInterval(() => { if (cancelled()) finish(new Error('사진 확인이 취소되었습니다.')) }, 100)
    try { sender.send(IpcChannels.localAgent.captureRequest, request) } catch (error) { finish(error as Error) }
  })
}

async function receiveCapture(event: IpcMainEvent, response: AgentCaptureResponse): Promise<void> {
  if (!response || typeof response.captureId !== 'string') return
  const entry = pending.get(response.captureId)
  if (!entry || entry.receiving || entry.sender !== event.sender || event.sender.isDestroyed() ||
      event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== entry.documentUrl ||
      response.requestId !== entry.request.requestId || response.photoId !== entry.request.photoId) return
  entry.receiving = true
  try {
    if (entry.cancelled()) throw new Error('사진 확인이 취소되었습니다.')
    if (response.ok !== true) throw new Error(typeof response.error === 'string' ? response.error.slice(0, 300) : '사진을 렌더링하지 못했습니다.')
    const result = await sanitizeAgentCapture(response.result)
    const source = await stat(await assertAuthorizedPhoto(entry.request.photoId))
    if (source.mtimeMs !== entry.request.sourceMtimeMs || source.size !== entry.request.sourceSize || entry.cancelled()) throw new Error('사진이 바뀌었거나 확인 요청이 취소되었습니다.')
    entry.finish(null, result)
  } catch (error) { entry.finish(error as Error) }
}

export function registerAgentCaptureHandlers(): void {
  ipcMain.on(IpcChannels.localAgent.captureResult, (event, response) => { void receiveCapture(event, response) })
}
export function cancelAgentCaptures(requestId: string): void {
  for (const entry of pending.values()) if (entry.request.requestId === requestId) entry.finish(new Error('사진 확인이 취소되었습니다.'))
}
export function shutdownAgentCaptures(): void {
  for (const entry of pending.values()) entry.finish(new Error('사진 작업실을 닫고 있습니다.'))
}
