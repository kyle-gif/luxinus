import type { Readable, Writable } from 'node:stream'

type JsonObject = Record<string, any>
const object = (value: unknown): value is JsonObject => !!value && typeof value === 'object' && !Array.isArray(value)
const TEXT_MESSAGE_BYTES = 1_048_576
// Initial four attachments (<=16MiB encoded) plus four bounded tool screenshots.
const MAX_IMAGE_ECHO_BYTES = 32 * 1_048_576

/** Newline JSON-RPC over the official app-server stdio transport. No payload logs. */
export class CodexRpc {
  private nextId = 1
  private pending = new Map<number, { resolve: (value: JsonObject) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private maxMessageBytes = TEXT_MESSAGE_BYTES
  private closed = false
  private serving = new Set<string>()
  private servingTimers = new Set<ReturnType<typeof setTimeout>>()
  constructor(private readonly input: Writable, output: Readable,
    private readonly notify: (method: string, params: JsonObject) => void,
    private readonly failed: (error: Error) => void,
    private readonly serverRequest: (method: string) => void = () => {},
    private readonly handleRequest?: (method: string, params: JsonObject) => Promise<JsonObject> | JsonObject | undefined) {
    output.setEncoding('utf8')
    output.on('data', (chunk: string) => this.receive(chunk))
    output.on('error', () => this.fail(new Error('Codex 응답 스트림을 읽지 못했습니다.')))
    input.on('error', () => this.fail(new Error('Codex 요청을 전달하지 못했습니다.')))
  }
  /** App Server may echo all submitted image URLs in userMessage/turn items. */
  allowImageEcho(imageBytes: number): void {
    if (!Number.isSafeInteger(imageBytes) || imageBytes < 0 || imageBytes > MAX_IMAGE_ECHO_BYTES) throw new Error('Codex 이미지 응답 한도가 올바르지 않습니다.')
    this.maxMessageBytes = TEXT_MESSAGE_BYTES + imageBytes
  }
  request(method: string, params: JsonObject = {}, timeoutMs = 20_000): Promise<JsonObject> {
    if (this.closed) return Promise.reject(new Error('Codex 연결이 종료되었습니다.'))
    if (this.pending.size >= 32) return Promise.reject(new Error('Codex 요청이 너무 많습니다.'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('Codex 응답 시간 제한을 초과했습니다.'))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }
  notification(method: string, params: JsonObject = {}): void { this.write({ method, params }) }
  close(error = new Error('Codex 연결이 종료되었습니다.')): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
    for (const timer of this.servingTimers) clearTimeout(timer)
    this.servingTimers.clear(); this.serving.clear()
    this.buffer = ''
  }
  private write(value: JsonObject): void {
    if (this.closed) return
    try { this.input.write(JSON.stringify(value) + '\n') } catch { this.fail(new Error('Codex 연결에 쓰지 못했습니다.')) }
  }
  private fail(error: Error): void { if (!this.closed) { this.close(error); this.failed(error) } }
  private receive(chunk: string): void {
    if (this.closed) return
    this.buffer += chunk
    let newline: number
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      // Apply the limit to each wire frame, before trimming. Multiple complete
      // frames in one transport chunk are not one oversized message.
      if (Buffer.byteLength(this.buffer.slice(0, newline)) > this.maxMessageBytes) { this.fail(new Error('Codex 응답 크기가 제한을 초과했습니다.')); return }
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message: JsonObject
      try {
        const parsed: unknown = JSON.parse(line)
        if (!object(parsed)) throw new Error()
        message = parsed
      } catch { this.fail(new Error('Codex가 올바르지 않은 프로토콜 응답을 보냈습니다.')); return }
      if (typeof message.method === 'string') {
        if ('id' in message) {
          this.serve(message)
        } else if (object(message.params)) this.notify(message.method, message.params)
        continue
      }
      if (typeof message.id !== 'number') continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id); clearTimeout(pending.timer)
      if (object(message.error)) {
        // Server errors may contain requests or sensitive diagnostic context.
        // Expose only the numeric protocol code, never arbitrary server text.
        const code = typeof message.error.code === 'number' ? ` (${message.error.code})` : ''
        pending.reject(new Error(`Codex 요청을 처리하지 못했습니다${code}. 연결·로그인 상태를 확인해 주세요.`))
      } else if (object(message.result)) pending.resolve(message.result)
      else pending.reject(new Error('Codex 응답 형식이 올바르지 않습니다.'))
    }
    if (Buffer.byteLength(this.buffer) > this.maxMessageBytes) this.fail(new Error('Codex 응답 크기가 제한을 초과했습니다.'))
  }
  private serve(message: JsonObject): void {
    if ((typeof message.id !== 'string' && typeof message.id !== 'number') || !object(message.params)) { this.fail(new Error('Codex 도구 요청 형식이 올바르지 않습니다.')); return }
    const key = `${typeof message.id}:${message.id}`
    if (this.serving.has(key) || this.serving.size >= 16) { this.fail(new Error('Codex 도구 요청이 제한을 초과했습니다.')); return }
    let response: Promise<JsonObject> | JsonObject | undefined
    try { response = this.handleRequest?.(message.method, message.params) } catch { response = Promise.reject(new Error('Invalid tool request')) }
    if (response === undefined) {
      this.write({ id: message.id, error: { code: -32601, message: 'This client does not expose that tool or approval.' } })
      this.serverRequest(message.method)
      return
    }
    this.serving.add(key)
    let timer: ReturnType<typeof setTimeout>
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Tool timeout')), 60_000) })
    this.servingTimers.add(timer!)
    void Promise.race([response, timeout]).then(result => {
      const imageOutput = object(result) && Array.isArray(result.contentItems) && result.contentItems.some(item => item?.type === 'inputImage')
      if (!object(result) || Buffer.byteLength(JSON.stringify(result)) > (imageOutput ? 3 * 1_048_576 : 262_144)) throw new Error('Invalid tool output')
      this.write({ id: message.id, result })
    }).catch(() => {
      this.write({ id: message.id, error: { code: -32602, message: 'The app tool request was invalid or cancelled.' } })
    }).finally(() => { clearTimeout(timer!); this.servingTimers.delete(timer!); this.serving.delete(key) })
  }
}

export function validatedCodexAuthUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new Error('로그인 주소가 올바르지 않습니다.')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('로그인 주소가 올바르지 않습니다.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['auth.openai.com', 'chatgpt.com', 'auth0.openai.com'].includes(url.hostname)) {
    throw new Error('공식 OpenAI 로그인 주소가 아닙니다.')
  }
  return url.href
}
