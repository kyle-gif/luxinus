import sharp from 'sharp'
import { AGENT_SCREENSHOT_MAX_BYTES, AGENT_SCREENSHOT_MAX_EDGE, type AgentCaptureResult } from '../shared/agent-vision'

/** Validate and strip metadata before an app-rendered photo enters the model. */
export async function sanitizeAgentCapture(value: unknown): Promise<AgentCaptureResult> {
  const input = value as Partial<AgentCaptureResult> | null
  if (!input || typeof input.dataUrl !== 'string' || input.dataUrl.length > Math.ceil(AGENT_SCREENSHOT_MAX_BYTES * 4 / 3) + 64 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(input.dataUrl) ||
      !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width! < 1 || input.height! < 1 ||
      input.width! > AGENT_SCREENSHOT_MAX_EDGE || input.height! > AGENT_SCREENSHOT_MAX_EDGE) throw new Error('사진 스크린샷의 형식이나 크기가 올바르지 않습니다.')
  const encoded = input.dataUrl.slice('data:image/jpeg;base64,'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length > AGENT_SCREENSHOT_MAX_BYTES || bytes.toString('base64') !== encoded) throw new Error('사진 스크린샷의 인코딩이 올바르지 않습니다.')
  const image = sharp(bytes, { limitInputPixels: AGENT_SCREENSHOT_MAX_EDGE ** 2, failOn: 'error', animated: false })
  const meta = await image.metadata()
  if (meta.format !== 'jpeg' || meta.width !== input.width || meta.height !== input.height || (meta.pages ?? 1) !== 1) throw new Error('사진 스크린샷의 실제 크기가 일치하지 않습니다.')
  const clean = await image.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer()
  if (clean.length > AGENT_SCREENSHOT_MAX_BYTES) throw new Error('사진 스크린샷이 너무 큽니다.')
  return { dataUrl: `data:image/jpeg;base64,${clean.toString('base64')}`, width: input.width!, height: input.height! }
}
