import test from 'node:test'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexRpc, validatedCodexAuthUrl } from '../src/main/codex-protocol'
import { CodexClient, codexArguments, codexEnvironment } from '../src/main/codex-client'

test('RPC matches out-of-order responses and preserves split UTF-8 Korean', async () => {
  const input = new PassThrough(), output = new PassThrough()
  const notices: string[] = []
  const rpc = new CodexRpc(input, output, (_method, params) => notices.push(params.delta), () => {})
  const first = rpc.request('first'), second = rpc.request('second')
  output.write('{"id":2,"result":{"value":2}}\n')
  const bytes = Buffer.from('{"method":"item/agentMessage/delta","params":{"delta":"그림자"}}\n')
  const boundary = bytes.indexOf(Buffer.from('그')) + 1
  output.write(bytes.subarray(0, boundary)); output.write(bytes.subarray(boundary))
  output.write('{"id":1,"result":{"value":1}}\n')
  assert.deepEqual(await first, { value: 1 }); assert.deepEqual(await second, { value: 2 })
  assert.deepEqual(notices, ['그림자']); rpc.close()
})
test('RPC rejects server tools and never exposes raw errors or credentials', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let writes = '', forbidden = ''
  input.on('data', chunk => { writes += chunk.toString() })
  const rpc = new CodexRpc(input, output, () => {}, () => {}, method => { forbidden = method })
  output.write('{"id":"tool-1","method":"item/commandExecution/requestApproval","params":{"command":"read private file"}}\n')
  assert.equal(forbidden, 'item/commandExecution/requestApproval')
  assert.match(writes, /-32601/); assert.doesNotMatch(writes, /read private file/)
  const pending = rpc.request('account/read')
  output.write('{"id":1,"error":{"code":-32000,"message":"Bearer secret-token"}}\n')
  await assert.rejects(pending, error => /-32000/.test((error as Error).message) && !/secret-token/.test((error as Error).message))
  rpc.close()
})
test('RPC handles malformed, bounded output, timeout, and close without hanging callers', async () => {
  for (const payload of ['not-json\n', 'x'.repeat(1_048_577)]) {
    const input = new PassThrough(), output = new PassThrough()
    let failures = 0
    const rpc = new CodexRpc(input, output, () => {}, () => { failures++ })
    const pending = rpc.request('initialize')
    output.write(payload)
    await assert.rejects(pending); assert.equal(failures, 1)
  }
  const rpc = new CodexRpc(new PassThrough(), new PassThrough(), () => {}, () => {})
  await assert.rejects(rpc.request('never-responds', {}, 5), /시간 제한/)
  const pending = rpc.request('closed'); rpc.close(); await assert.rejects(pending, /종료/)
})
test('RPC bounds individual frames and only grants a finite explicit image echo allowance', async () => {
  const input = new PassThrough(), output = new PassThrough()
  let notices = 0
  const rpc = new CodexRpc(input, output, () => { notices++ }, () => {})
  const smallFrame = JSON.stringify({ method: 'synthetic', params: { text: 'a'.repeat(600_000) } }) + '\n'
  output.write(smallFrame + smallFrame)
  assert.equal(notices, 2, 'Two valid frames in one chunk must not share one frame limit')
  assert.throws(() => rpc.allowImageEcho(Infinity))
  assert.throws(() => rpc.allowImageEcho(32 * 1_048_576 + 1))
  rpc.allowImageEcho(32 * 1_048_576)
  rpc.allowImageEcho(1_200_000)
  const largeFrame = JSON.stringify({ method: 'synthetic', params: { text: 'b'.repeat(1_200_000) } }) + '\n'
  output.write(largeFrame)
  assert.equal(notices, 3)
  rpc.allowImageEcho(0)
  const pending = rpc.request('bounded')
  output.write(largeFrame)
  await assert.rejects(pending, /응답 크기/)

  const overflow = new PassThrough()
  const limited = new CodexRpc(new PassThrough(), overflow, () => {}, () => {})
  limited.allowImageEcho(200_000)
  const tooLarge = limited.request('bounded-image')
  overflow.write(' '.repeat(1_248_577) + '\n')
  await assert.rejects(tooLarge, /응답 크기/, 'Whitespace cannot evade the wire-frame limit')
})
test('login URLs accept exact official HTTPS hosts and reject lookalikes and credentials', () => {
  assert.match(validatedCodexAuthUrl('https://auth.openai.com/oauth/authorize?state=synthetic'), /^https:/)
  assert.match(validatedCodexAuthUrl('https://chatgpt.com/auth/login'), /^https:/)
  for (const value of ['http://auth.openai.com/', 'https://auth.openai.com.evil.invalid/', 'file:///tmp/a', 'https://evil@auth.openai.com/', 'https://auth.openai.com:444/', 'https://openai.com.evil.invalid/']) assert.throws(() => validatedCodexAuthUrl(value))
})
test('Codex keeps hosted app-tool orchestration while native capabilities stay restricted', () => {
  const environment = codexEnvironment('/tmp/lx-codex', '/tmp/lx-empty')
  assert.equal(environment.CODEX_HOME, '/tmp/lx-codex')
  assert.equal(environment.HOME, '/tmp/lx-empty')
  assert.equal(environment.OPENAI_API_KEY, undefined)
  assert.equal(environment.HTTPS_PROXY, undefined)
  const args = codexArguments().join(' ')
  assert.match(args, /cli_auth_credentials_store="file"/)
  assert.match(args, /features.shell_tool=false/)
  assert.match(args, /features.apps=false/)
  assert.match(args, /features.code_mode_host=true/)
  assert.match(args, /features.code_mode=false/)
  assert.match(args, /web_search="disabled"/)
  assert.doesNotMatch(args, /sandbox-exec|deny-network|networkAccess=false/)
})

class MockServer extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly pid = 999_999_999
  readonly stdin: Writable
  killed = false
  sent: any[] = []
  constructor(private readonly handle: (message: any, server: MockServer) => void) {
    super()
    this.stdin = new Writable({ write: (chunk, _encoding, callback) => {
      const message = JSON.parse(chunk.toString())
      this.sent.push(message)
      queueMicrotask(() => { if (!this.killed) this.handle(message, this) })
      callback()
    } })
  }
  reply(id: number, result: object): void { this.stdout.write(JSON.stringify({ id, result }) + '\n') }
  notify(method: string, params: object): void { this.stdout.write(JSON.stringify({ method, params }) + '\n') }
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => { this.emit('exit', 0); this.emit('close', 0) })
    return true
  }
}
const fixture = async (handle: (message: any, server: MockServer) => void, findCli = async (): Promise<string | null> => '/synthetic/codex', toolTimeoutMs?: number) => {
  const dir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'lx-codex-test-')))
  const servers: MockServer[] = []
  const client = new CodexClient(dir, { findCli, toolTimeoutMs, spawn: (() => {
    const server = new MockServer(handle); servers.push(server); return server
  }) as any })
  return { client, servers, dir, cleanup: async () => { await client.shutdown(); await fs.rm(dir, { recursive: true, force: true }) } }
}
const common = (message: any, server: MockServer): boolean => {
  if (message.method === 'initialize') { server.reply(message.id, { userAgent: 'codex/0.153.4' }); return true }
  if (message.method === 'account/read') { server.reply(message.id, { account: { type: 'chatgpt', email: 'synthetic@example.test', planType: 'plus' }, requiresOpenaiAuth: true }); return true }
  return false
}
test('status only checks installed files and a local metadata cache; never starts a server', async () => {
  const f = await fixture(common)
  try {
    assert.equal(f.servers.length, 0)
    const status = await f.client.status()
    assert.equal(status.phase, 'signed-out')
    assert.equal(f.servers.length, 0)
  } finally { await f.cleanup() }
})
test('a delayed passive status cannot overwrite a newer login or upgrade itself to an account query', async () => {
  let lookups = 0
  let finishLookup!: (path: string) => void
  const lookup = new Promise<string>(resolve => { finishLookup = resolve })
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: 'new-login', authUrl: 'https://auth.openai.com/oauth/authorize' })
    if (message.method === 'account/login/cancel') server.reply(message.id, { status: 'canceled' })
  }, async () => ++lookups === 1 ? lookup : '/synthetic/codex')
  try {
    const oldStatus = f.client.status()
    const login = await f.client.login()
    finishLookup('/synthetic/codex')
    const result = await oldStatus
    assert.equal(result.phase, 'signing-in'); assert.equal(result.loginId, login.loginId)
    assert.equal(f.servers[0].sent.some(message => message.method === 'account/read'), false)
    await f.client.cancelLogin(login.loginId)
  } finally { await f.cleanup() }
})
test('an old login account poll cannot overwrite completion or its fresh account metadata', async () => {
  const reads: { id: number; server: MockServer }[] = []
  let oldReadSeen!: () => void, completionReadSeen!: () => void
  const oldSeen = new Promise<void>(resolve => { oldReadSeen = resolve })
  const completionSeen = new Promise<void>(resolve => { completionReadSeen = resolve })
  const f = await fixture((message, server) => {
    if (message.method === 'account/read') {
      reads.push({ id: message.id, server })
      if (reads.length === 1) oldReadSeen(); else completionReadSeen()
      return
    }
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: 'finishing-login', authUrl: 'https://auth.openai.com/oauth/authorize' })
  })
  try {
    const login = await f.client.login()
    const oldStatus = f.client.status()
    await oldSeen
    f.servers[0].notify('account/login/completed', { loginId: login.loginId, success: true })
    await completionSeen
    reads[0].server.reply(reads[0].id, { account: null, requiresOpenaiAuth: true })
    const result = await oldStatus
    assert.equal(result.phase, 'ready'); assert.equal(result.loginId, null)
    const closed = new Promise<void>(resolve => { f.servers[0].once('close', () => resolve()) })
    reads[1].server.reply(reads[1].id, { account: { type: 'chatgpt', email: 'new@example.test', planType: 'plus' }, requiresOpenaiAuth: true })
    await closed
    const cached = await f.client.status()
    assert.equal(cached.email, 'new@example.test'); assert.match(cached.message, /저장된/)
  } finally { await f.cleanup() }
})
test('client accepts only matching turn completion even when events arrive before start reply', async () => {
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'thread-1' }, model: 'gpt-synthetic' })
    if (message.method === 'turn/start') {
      server.notify('item/agentMessage/delta', { threadId: 'other-thread', turnId: 'other-turn', itemId: 'bad', delta: 'forged' })
      server.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: '{"ok":true}' } })
      server.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } })
      server.reply(message.id, { turn: { id: 'turn-1' } })
    }
  })
  try {
    const result = await f.client.infer('synthetic edit values only', { type: 'object' }, 'request-123')
    assert.equal(result.text, '{"ok":true}')
    const thread = f.servers[0].sent.find(message => message.method === 'thread/start')
    assert.equal(thread.params.ephemeral, true); assert.equal(thread.params.sandbox, 'read-only')
    const turn = f.servers[0].sent.find(message => message.method === 'turn/start')
    assert.deepEqual(turn.params.sandboxPolicy, { type: 'readOnly', networkAccess: true })
    assert.deepEqual(turn.params.input, [{ type: 'text', text: 'synthetic edit values only' }])
    assert.equal(f.servers[0].killed, true)
  } finally { await f.cleanup() }
})
test('cancel during startup rejects inference and late completion cannot revive it', async () => {
  const f = await fixture(() => {})
  try {
    const pending = f.client.infer('synthetic', {}, 'request-cancel')
    while (!f.servers.length) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(f.client.cancel('other-request'), false)
    assert.equal(f.client.cancel('request-cancel'), true)
    await assert.rejects(pending, /취소/)
    f.servers[0].reply(1, { userAgent: 'late' })
    assert.equal(f.servers[0].sent.some(message => message.method === 'thread/start'), false)
  } finally { await f.cleanup() }
})
test('login cancellation uses only the current login ID', async () => {
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: 'login-1', authUrl: 'https://auth.openai.com/oauth/authorize?state=synthetic' })
    if (message.method === 'account/login/cancel') server.reply(message.id, { status: 'canceled' })
  })
  try {
    const login = await f.client.login(); assert.equal(login.loginId, 'login-1')
    const before = f.servers[0].sent.length
    await f.client.cancelLogin('wrong-id')
    assert.equal(f.servers[0].sent.length, before, 'Stale ID does not send a cancellation')
    assert.equal(f.servers[0].killed, false)
    assert.equal((await f.client.status()).loginId, 'login-1')
    await f.client.cancelLogin('login-1')
    assert.deepEqual(f.servers[0].sent.at(-1).params, { loginId: 'login-1' })
  } finally { await f.cleanup() }
})
test('a stale login ID cannot cancel new startup before its login ID arrives', async () => {
  let starts = 0
  let resumeInitialize!: { id: number; server: MockServer }
  let startupSeen!: () => void
  const startup = new Promise<void>(resolve => { startupSeen = resolve })
  const f = await fixture((message, server) => {
    if (message.method === 'initialize' && ++starts === 2) {
      resumeInitialize = { id: message.id, server }; startupSeen(); return
    }
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: `login-${starts}`, authUrl: 'https://auth.openai.com/oauth/authorize' })
    if (message.method === 'account/login/cancel') server.reply(message.id, { status: 'canceled' })
  })
  try {
    const first = await f.client.login()
    await f.client.cancelLogin(first.loginId)
    const second = f.client.login()
    await startup
    await f.client.cancelLogin(first.loginId)
    assert.equal(f.servers[1].killed, false)
    assert.equal(f.servers[1].sent.some(message => message.method === 'account/login/cancel'), false)
    resumeInitialize.server.reply(resumeInitialize.id, { userAgent: 'codex/0.153.4' })
    assert.equal((await second).loginId, 'login-2', 'New login generation remains valid')
    assert.equal((await f.client.status()).loginId, 'login-2')
    await f.client.cancelLogin('login-2')
    assert.deepEqual(f.servers[1].sent.at(-1).params, { loginId: 'login-2' })
  } finally { await f.cleanup() }
})
test('a delayed cancellation reply cannot terminate a newer login on the same server', async () => {
  let logins = 0
  let heldCancel!: { id: number; server: MockServer }
  let cancelSeen!: () => void
  const cancellation = new Promise<void>(resolve => { cancelSeen = resolve })
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: `login-${++logins}`, authUrl: 'https://auth.openai.com/oauth/authorize' })
    if (message.method === 'account/login/cancel') {
      if (message.params.loginId === 'login-1') { heldCancel = { id: message.id, server }; cancelSeen() }
      else server.reply(message.id, { status: 'canceled' })
    }
  })
  try {
    const first = await f.client.login()
    const pendingCancel = f.client.cancelLogin(first.loginId)
    await cancellation
    const second = await f.client.login()
    assert.equal(second.loginId, 'login-2')
    assert.equal(f.servers.length, 1, 'New login uses the still-active server')
    heldCancel.server.reply(heldCancel.id, { status: 'canceled' })
    await pendingCancel
    assert.equal(f.servers[0].killed, false)
    assert.equal((await f.client.status()).loginId, 'login-2')
    await f.client.cancelLogin('login-2')
    assert.equal(f.servers[0].killed, true)
  } finally { await f.cleanup() }
})
test('completed login persists only an account summary, status reads it without starting, logout clears it', async () => {
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'account/login/start') server.reply(message.id, { type: 'chatgpt', loginId: 'login-2', authUrl: 'https://auth.openai.com/oauth/authorize' })
    if (message.method === 'account/logout') server.reply(message.id, {})
  })
  try {
    await f.client.login()
    const live = await f.client.status()
    assert.equal(live.email, 'synthetic@example.test')
    assert.equal(live.phase, 'signing-in', 'An old authenticated account does not finish a new login flow')
    assert.equal(live.loginId, 'login-2')
    f.servers[0].notify('account/login/completed', { loginId: 'login-2', success: true })
    await f.client.shutdown()
    const cached = await f.client.status()
    assert.equal(cached.phase, 'ready'); assert.match(cached.message, /저장된/)
    assert.equal(cached.email, 'synthetic@example.test')
    assert.equal(f.servers.length, 1, 'No server spawned by cached status')
    await f.client.logout()
    assert.equal((await f.client.status()).phase, 'signed-out')
  } finally { await f.cleanup() }
})
test('an explicit inference discovers expired authentication and clears cached ready state', async () => {
  const f = await fixture((message, server) => {
    if (message.method === 'initialize') server.reply(message.id, { userAgent: 'codex/0.153.4' })
    if (message.method === 'account/read') server.reply(message.id, { account: null, requiresOpenaiAuth: true })
  })
  try {
    await fs.writeFile(join(f.dir, 'connection-state.json'), JSON.stringify({ version: 1, email: 'cached@example.test', planType: 'plus' }))
    assert.equal((await f.client.status()).phase, 'ready')
    await assert.rejects(f.client.infer('synthetic', {}, 'request-expired'), /로그인/)
    assert.equal((await f.client.status()).phase, 'signed-out')
    assert.equal(f.servers[0].sent.some(message => message.method === 'thread/start'), false)
  } finally { await f.cleanup() }
})
test('unexpected tool activity rejects a turn and stops its server', async () => {
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'thread-2' }, model: 'gpt-synthetic' })
    if (message.method === 'turn/start') {
      server.reply(message.id, { turn: { id: 'turn-2' } })
      server.notify('item/started', { threadId: 'thread-2', turnId: 'turn-2', item: { id: 'tool-1', type: 'fileChange' } })
    }
  })
  try {
    await assert.rejects(f.client.infer('synthetic', {}, 'request-tool'), /도구 작업/)
    assert.equal(f.servers[0].killed, true)
  } finally { await f.cleanup() }
})
test('a canceled startup cannot close a replacement inference connection', async () => {
  let initialized = 0
  const f = await fixture((message, server) => {
    if (message.method === 'initialize' && ++initialized === 1) return
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'replacement-thread' }, model: 'gpt-synthetic' })
    if (message.method === 'turn/start') {
      server.reply(message.id, { turn: { id: 'replacement-turn' } })
      server.notify('item/completed', { threadId: 'replacement-thread', turnId: 'replacement-turn', item: { id: 'reply', type: 'agentMessage', text: '{"replacement":true}' } })
      server.notify('turn/completed', { threadId: 'replacement-thread', turn: { id: 'replacement-turn', status: 'completed' } })
    }
  })
  try {
    const first = f.client.infer('first', {}, 'request-first').catch(error => error)
    while (!f.servers.length) await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(f.client.cancel('request-first'), true)
    const second = f.client.infer('second', {}, 'request-second')
    assert.match((await first).message, /취소/)
    assert.equal((await second).text, '{"replacement":true}')
    assert.equal(f.servers.length, 2)
  } finally { await f.cleanup() }
})

test('explicit model catalog preserves advertised reasoning and modalities without background refresh', async () => {
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'model/list') server.reply(message.id, { data: [
      { model: 'text-synthetic', displayName: 'Text', isDefault: true, inputModalities: ['text'], defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high', description: 'Detailed' }] },
      { model: 'legacy-synthetic', supportedReasoningEfforts: [] }
    ] })
  })
  try {
    assert.equal(f.servers.length, 0)
    await assert.rejects(f.client.infer('test', null, 12345678 as any), /형식 또는 크기/)
    const models = await f.client.models()
    assert.deepEqual(models[0].inputModalities, ['text'])
    assert.deepEqual(models[0].supportedReasoningEfforts.map(item => item.reasoningEffort), ['low', 'high'])
    assert.deepEqual(models[1].inputModalities, ['text', 'image'])
    assert.equal(f.servers[0].killed, true)
    await assert.rejects(f.client.infer('test', null, 'request-image', undefined, 'text-synthetic', { images: ['data:image/jpeg;base64,YQ=='] }), /이미지 입력/)
    await assert.rejects(f.client.infer('test', null, 'request-effort', undefined, 'text-synthetic', { reasoningEffort: 'ultra' }), /지원하는 추론 강도/)
    assert.equal(f.servers.length, 1)
  } finally { await f.cleanup() }
})

test('image/effort input and early app dynamic call use official protocol and stage once', async () => {
  const calls: string[] = []
  const tool = { type: 'function' as const, name: 'luxinus_read_state', description: 'Read supplied state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'model/list') server.reply(message.id, { data: [{ model: 'vision-synthetic', inputModalities: ['text', 'image'], isDefault: true, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'high', description: 'Detailed' }] }] })
    if (message.method === 'thread/start') {
      assert.deepEqual(message.params.dynamicTools, [tool])
      assert.equal(message.params.config['features.code_mode_host'], true)
      assert.equal(message.params.config['features.shell_tool'], false)
      assert.equal(message.params.config['web_search'], 'disabled')
      server.reply(message.id, { thread: { id: 'vision-thread' }, model: 'vision-synthetic' })
    }
    if (message.method === 'turn/start') {
      assert.equal(message.params.effort, 'high')
      assert.deepEqual(message.params.input[1], { type: 'image', url: 'data:image/jpeg;base64,YQ==' })
      assert.equal('outputSchema' in message.params, false)
      server.notify('item/started', { threadId: 'vision-thread', turnId: 'vision-turn', item: { id: 'call-a', type: 'dynamicToolCall', tool: tool.name } })
      server.stdout.write(JSON.stringify({ id: 'server-tool-1', method: 'item/tool/call', params: { threadId: 'vision-thread', turnId: 'vision-turn', callId: 'call-a', namespace: null, tool: tool.name, arguments: {} } }) + '\n')
      server.reply(message.id, { turn: { id: 'vision-turn' } })
    }
    if (message.id === 'server-tool-1') {
      assert.deepEqual(message.result, { success: true, contentItems: [{ type: 'inputText', text: '{"supplied":true}' }] })
      server.notify('item/completed', { threadId: 'vision-thread', turnId: 'vision-turn', item: { id: 'reply', type: 'agentMessage', text: '첨부를 참고한 답변입니다.' } })
      server.notify('turn/completed', { threadId: 'vision-thread', turn: { id: 'vision-turn', status: 'completed' } })
    }
  })
  try {
    await f.client.models()
    const output = await f.client.infer('synthetic attached prompt', null, 'request-vision', undefined, 'vision-synthetic', {
      images: ['data:image/jpeg;base64,YQ=='], reasoningEffort: 'high', dynamicTools: [tool], onToolCall: name => { calls.push(name); return { supplied: true } }
    })
    assert.equal(output.text, '첨부를 참고한 답변입니다.')
    assert.deepEqual(calls, ['luxinus_read_state'])
    assert.equal(f.servers[1].sent.find(message => message.method === 'initialize').params.capabilities.experimentalApi, true)
    assert.equal(f.servers[1].killed, true)
  } finally { await f.cleanup() }
})

test('unknown app tool requests stop inference without executing callbacks', async () => {
  let invoked = 0
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'tool-thread' } })
    if (message.method === 'turn/start') {
      server.reply(message.id, { turn: { id: 'tool-turn' } })
      server.stdout.write(JSON.stringify({ id: 'forbidden-1', method: 'item/tool/call', params: { threadId: 'tool-thread', turnId: 'tool-turn', callId: 'call-1', tool: 'luxinus_run_shell', arguments: {} } }) + '\n')
    }
  })
  try {
    await assert.rejects(f.client.infer('synthetic', null, 'request-forbidden', undefined, undefined, { dynamicTools: [{ type: 'function', name: 'luxinus_read_state', description: 'Read', inputSchema: {} }], onToolCall: () => { invoked++; return {} } }), /허용되지 않은/)
    assert.equal(invoked, 0)
  } finally { await f.cleanup() }
})

test('multimodal turns accept large userMessage and turn response echoes while next text turn stays bounded', async () => {
  const images = Array.from({ length: 2 }, () => `data:image/jpeg;base64,${'A'.repeat(700_000)}`)
  let echoBytes = 0
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'echo-thread' } })
    if (message.method === 'turn/start') {
      const item = { id: 'user-echo', type: 'userMessage', content: message.params.input.length > 1 ? message.params.input : [{ type: 'image', url: images[0] }, { type: 'image', url: images[1] }] }
      server.notify('turn/started', { threadId: 'echo-thread', turn: { id: 'echo-turn', items: [item], status: 'inProgress' } })
      echoBytes = Buffer.byteLength(JSON.stringify(item))
      server.notify('item/completed', { threadId: 'echo-thread', turnId: 'echo-turn', item })
      if (server.killed) return
      server.reply(message.id, { turn: { id: 'echo-turn', items: [item] } })
      server.notify('item/completed', { threadId: 'echo-thread', turnId: 'echo-turn', item: { id: 'reply', type: 'agentMessage', text: '이미지 응답 확인' } })
      server.notify('turn/completed', { threadId: 'echo-thread', turn: { id: 'echo-turn', status: 'completed' } })
    }
  })
  try {
    const result = await f.client.infer('synthetic image prompt', null, 'request-large-images', undefined, undefined, { images })
    assert.ok(echoBytes > 1_048_576)
    assert.equal(result.text, '이미지 응답 확인')
    await assert.rejects(f.client.infer('synthetic text prompt', null, 'request-text-bounded'), /응답 크기/)
    assert.equal(f.servers.length, 2)
    assert.ok(f.servers.every(server => server.killed))
  } finally { await f.cleanup() }
})

test('dynamic screenshot returns actual inputImage and accepts its bounded large echo', async () => {
  const imageUrl = `data:image/jpeg;base64,${Buffer.alloc(1_100_000, 7).toString('base64')}`
  const tool = { type: 'function' as const, name: 'luxinus_screenshot', description: 'Photo image', inputSchema: {} }
  let imageReplies = 0
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'shot-thread' } })
    if (message.method === 'turn/start') {
      server.reply(message.id, { turn: { id: 'shot-turn' } })
      server.stdout.write(JSON.stringify({ id: 'screenshot-reply', method: 'item/tool/call', params: { threadId: 'shot-thread', turnId: 'shot-turn', callId: 'shot-1', tool: tool.name, arguments: {} } }) + '\n')
    }
    if (message.id === 'screenshot-reply') {
      assert.equal(message.result.success, true)
      assert.deepEqual(message.result.contentItems, [{ type: 'inputText', text: 'photo only' }, { type: 'inputImage', imageUrl }]); imageReplies++
      server.notify('item/completed', { threadId: 'shot-thread', turnId: 'shot-turn', item: { id: 'shot-1', type: 'dynamicToolCall', tool: tool.name, contentItems: message.result.contentItems, status: 'completed' } })
      server.notify('item/completed', { threadId: 'shot-thread', turnId: 'shot-turn', item: { id: 'answer', type: 'agentMessage', text: '실제 이미지 응답 형식 확인' } })
      server.notify('turn/completed', { threadId: 'shot-thread', turn: { id: 'shot-turn', status: 'completed' } })
    }
  })
  try {
    const result = await f.client.infer('synthetic', null, 'request-shot', undefined, undefined, { dynamicTools: [tool], allowImageResults: true, onToolCall: () => ({ contentItems: [{ type: 'inputText', text: 'photo only' }, { type: 'inputImage', imageUrl }] }) })
    assert.equal(result.text, '실제 이미지 응답 형식 확인'); assert.equal(imageReplies, 1)
  } finally { await f.cleanup() }
})

test('dynamic image permission, byte limits, and count limits reject unapproved outputs', async () => {
  for (const options of [ { allowed: false, url: 'data:image/jpeg;base64,YQ==' }, { allowed: true, url: `data:image/jpeg;base64,${Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64')}` }, { allowed: true, url: 'https://example.test/photo.jpg' } ]) {
    const tool = { type: 'function' as const, name: 'luxinus_screenshot', description: 'Photo image', inputSchema: {} }
    let rejected = false
    const f = await fixture((message, server) => {
      if (common(message, server)) return
      if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'scope-thread' } })
      if (message.method === 'turn/start') {
        server.reply(message.id, { turn: { id: 'scope-turn' } })
        server.stdout.write(JSON.stringify({ id: 'scope-reply', method: 'item/tool/call', params: { threadId: 'scope-thread', turnId: 'scope-turn', callId: 'scope-1', tool: tool.name, arguments: {} } }) + '\n')
      }
      if (message.id === 'scope-reply') {
        assert.equal(message.result.success, false); assert.equal(message.result.contentItems.some(item => item.type === 'inputImage'), false); rejected = true
        server.notify('item/completed', { threadId: 'scope-thread', turnId: 'scope-turn', item: { id: 'answer', type: 'agentMessage', text: 'blocked' } })
        server.notify('turn/completed', { threadId: 'scope-thread', turn: { id: 'scope-turn', status: 'completed' } })
      }
    })
    try {
      await f.client.infer('synthetic', null, 'request-scope', undefined, undefined, { dynamicTools: [tool], allowImageResults: options.allowed, onToolCall: () => ({ contentItems: [{ type: 'inputImage', imageUrl: options.url }] }) })
      assert.equal(rejected, true)
    } finally { await f.cleanup() }
  }
})

test('a stalled photo tool has a bounded deadline that cancels the turn and cannot respond later', async () => {
  let resume!: (value: object) => void
  const tool = { type: 'function' as const, name: 'luxinus_screenshot', description: 'Photo image', inputSchema: {} }
  const f = await fixture((message, server) => {
    if (common(message, server)) return
    if (message.method === 'thread/start') server.reply(message.id, { thread: { id: 'timeout-thread' } })
    if (message.method === 'turn/start') {
      server.reply(message.id, { turn: { id: 'timeout-turn' } })
      server.stdout.write(JSON.stringify({ id: 'late-output', method: 'item/tool/call', params: { threadId: 'timeout-thread', turnId: 'timeout-turn', callId: 'timeout-1', tool: tool.name, arguments: {} } }) + '\n')
    }
  }, undefined, 20)
  try {
    await assert.rejects(f.client.infer('synthetic', null, 'request-timeout', undefined, undefined, { dynamicTools: [tool], onToolCall: () => new Promise(resolve => { resume = resolve }) }), /시간 제한/)
    assert.equal(f.servers[0].killed, true)
    resume({ contentItems: [{ type: 'inputText', text: 'late' }] })
    await Promise.resolve(); await Promise.resolve()
    assert.equal(f.servers[0].sent.some(message => message.id === 'late-output'), false)
  } finally { await f.cleanup() }
})
