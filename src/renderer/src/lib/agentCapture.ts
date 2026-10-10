import { AGENT_SCREENSHOT_MAX_EDGE, agentEditDigest, type AgentCaptureRequest } from '../../../shared/agent-vision'
import { useStore } from '../store/useStore'
import { useAgentStore } from '../store/useAgentStore'
import { renderAgentImage } from './agentImage'

/** App-owned photo rendering only: no desktop, DOM screenshot or file URLs. */
export function listenForAgentCaptures(): () => void {
  const api = window.luxinus?.localAgent
  if (!api?.onCaptureRequest) return () => {}
  let disposed = false
  const receive = async (request: AgentCaptureRequest): Promise<void> => {
    const scope = { captureId: request.captureId, requestId: request.requestId, photoId: request.photoId }
    try {
      const initial = useStore.getState(), active = useAgentStore.getState().activeRequest
      const check = (): void => {
        const current = useStore.getState()
        const photo = current.photos.find(item => item.filePath === request.photoId)
        if (disposed || !active || useAgentStore.getState().activeRequest !== active || !active.allowVision || active.requestId !== request.requestId ||
            active.photoId !== request.photoId || current.selectedPath !== request.photoId || current.edit !== active.baseEdit ||
            current.editLoading || current.syncing || current.editGestureActive || current.proxy !== initial.proxy ||
            current.proxy.filePath !== request.photoId || current.proxy.status !== 'ready' || !current.proxy.url ||
            photo?.mtimeMs !== request.sourceMtimeMs || photo?.size !== request.sourceSize) throw new Error('사진이나 보정이 바뀌었습니다. 현재 상태에서 다시 요청해 주세요.')
      }
      check()
      if (await agentEditDigest(initial.edit) !== request.baseEditFingerprint) throw new Error('사진 확인 요청의 보정 상태가 일치하지 않습니다.')
      check()
      const restored = initial.denoiseProxy.status === 'ready' && initial.denoiseProxy.filePath === request.photoId ? initial.denoiseProxy.url : null
      const dataUrl = await renderAgentImage(initial.proxy.url!, request.edit, restored, AGENT_SCREENSHOT_MAX_EDGE, { overlayMaskId: request.overlayMaskId })
      const image = new Image(); image.src = dataUrl; await image.decode()
      check()
      api.captureResult({ ...scope, ok: true, result: { dataUrl, width: image.naturalWidth, height: image.naturalHeight } })
    } catch (error) {
      if (!disposed) api.captureResult({ ...scope, ok: false, error: (error as Error).message })
    }
  }
  const remove = api.onCaptureRequest(request => { void receive(request) })
  return () => { disposed = true; remove() }
}
