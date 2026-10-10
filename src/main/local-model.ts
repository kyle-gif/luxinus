import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { cpus, tmpdir, totalmem } from 'node:os'
import { LOCAL_MODEL_CANDIDATE, type LocalModelStatus } from '../shared/local-agent'
import { atomicReplace, contentHash, readRegularFile, serializeFile } from './safe-file'

// The text runtime uses a local model and stdio. It receives no shell tool,
// photo path, auth environment or writable photo directory. File/exec sandbox
// failure is fatal; connection APIs are not blocked.
export function modelSandboxProfile(runtime: string, workDir: string, model?: string, libraries: string[] = []): string {
  const literal = (path: string): string => `(literal ${JSON.stringify(path)})`
  const subpath = (path: string): string => `(subpath ${JSON.stringify(path)})`
  return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* ${subpath(workDir)} (literal "/dev/null"))
(deny file-read-data)
(allow file-read-data ${[
    // macOS dyld/libignition opens the root directory before resolving its
    // system cryptex. This permits that directory handle, not descendant files.
    literal('/'),
    subpath('/System'), subpath('/usr'), subpath('/Library/Apple'),
    subpath('/opt/homebrew/Cellar'), subpath('/opt/homebrew/lib'),
    literal(runtime), literal(dirname(runtime)), subpath(workDir), literal('/dev/null'),
    literal('/dev/urandom'), literal('/private/etc/localtime'),
    ...(model ? [literal(model)] : []), ...libraries.map(literal)
  ].join(' ')})
(deny process-exec)
(allow process-exec ${literal(runtime)})`
}

// llama-completion prints this fixed transport marker after an EOS token.
// Remove only that terminal marker, never fish JSON out of arbitrary prose.
export function completionText(stdout: string): string {
  return stdout.replace(/\s*\[end of text\]\s*$/, '').trim()
}

interface ModelConfig { runtimePath: string | null; modelPath: string | null; modelSha256: string | null; runtimeSha256?: string | null }
export class LocalModel {
  private config: ModelConfig = { runtimePath: null, modelPath: null, modelSha256: null }
  private loaded = false
  private configHash: string | null = null
  private active: { id: string; child: ChildProcess; stop: (message: string) => void } | null = null
  private state: LocalModelStatus = {
    phase: 'unavailable', runtimePath: null, runtimeVersion: null, modelPath: null,
    modelBytes: null, modelSha256: null, verifiedCandidate: false,
    message: '로컬 실행기와 모델을 선택해 주세요. 사진 수동 보정은 계속 사용할 수 있습니다.',
    memoryBytes: totalmem(), contextTokens: 4096, lastTest: null,
    networkPolicy: 'local-inference-no-network-use',
    acceleration: 'CPU (명시적 설정)'
  }
  constructor(private readonly settingsDir: string) {}
  private get configPath(): string { return join(this.settingsDir, 'local-model.json') }
  private async persist(): Promise<void> {
    await fs.mkdir(this.settingsDir, { recursive: true })
    const target = join(await fs.realpath(this.settingsDir), 'local-model.json')
    await serializeFile(target, async () => {
      this.configHash = await atomicReplace(target, JSON.stringify(this.config), this.configHash, async () => {})
    })
  }
  async status(): Promise<LocalModelStatus> {
    if (!this.loaded) {
      this.loaded = true
      try {
        const raw = await readRegularFile(this.configPath, 16_384)
        if (!raw) return { ...this.state }
        this.configHash = contentHash(raw)
        const parsed = JSON.parse(raw.toString('utf8')) as ModelConfig
        const runtimePath = typeof parsed.runtimePath === 'string' && parsed.runtimePath.startsWith('/') ? parsed.runtimePath : null
        const modelPath = typeof parsed.modelPath === 'string' && parsed.modelPath.startsWith('/') &&
          parsed.modelSha256 === LOCAL_MODEL_CANDIDATE.sha256 ? parsed.modelPath : null
        this.config = { runtimePath, modelPath, modelSha256: modelPath ? parsed.modelSha256 : null,
          runtimeSha256: typeof parsed.runtimeSha256 === 'string' ? parsed.runtimeSha256 : null }
        if (runtimePath || modelPath) this.state = { ...this.state, runtimePath, modelPath,
          modelSha256: this.config.modelSha256, phase: runtimePath && modelPath ? 'untested' : 'unavailable',
          message: '설정이 복원되었습니다. 이 실행에서 실제 추론 검사를 해 주세요.' }
      } catch { this.fail('모델 설정 파일을 읽지 못했습니다. 파일 형식·권한·심볼릭 링크를 확인해 주세요.') }
    }
    return { ...this.state }
  }
  private requireIdle(): void {
    if (this.active) throw new Error('로컬 추론이 진행 중입니다. 중단한 뒤 다시 시도해 주세요.')
  }
  async selectRuntime(path: string): Promise<LocalModelStatus> {
    await this.status()
    this.requireIdle()
    const real = await fs.realpath(path)
    if (!['llama-completion', 'llama-cli'].includes(basename(real))) throw new Error('llama-completion 실행 파일을 선택해 주세요.')
    const stat = await fs.stat(real)
    if (!stat.isFile() || !(stat.mode & 0o111)) throw new Error('실행 권한이 있는 로컬 파일이 필요합니다.')
    const runtimeData = await readRegularFile(real, 128 * 1024 * 1024)
    if (!runtimeData) throw new Error('실행 파일을 찾지 못했습니다.')
    const runtimeSha256 = contentHash(runtimeData)
    const help = await this.run(real, ['--help'], 'runtime-check', 15_000, 150_000)
    for (const flag of ['--no-conversation', '--json-schema', '--no-display-prompt', '--simple-io']) {
      if (!(help.stdout + help.stderr).includes(flag)) throw new Error(`이 실행기는 ${flag}를 지원하지 않습니다. 직접 추론용 llama-completion이 필요합니다.`)
    }
    const version = await this.run(real, ['--version'], 'runtime-version', 15_000)
    this.config.runtimePath = real
    this.config.runtimeSha256 = runtimeSha256
    this.state = { ...this.state, runtimePath: real, runtimeVersion: (version.stdout + version.stderr).trim().slice(0, 300),
      phase: this.config.modelPath ? 'untested' : 'unavailable', lastTest: null,
      message: '실행기를 확인했습니다. 모델 선택 후 실제 추론 검사가 필요합니다.' }
    await this.persist()
    return this.status()
  }
  async selectModel(path: string): Promise<LocalModelStatus> {
    await this.status()
    this.requireIdle()
    const real = await fs.realpath(path)
    const stat = await fs.stat(real)
    if (!stat.isFile() || !real.toLowerCase().endsWith('.gguf') || stat.size > 2_000_000_000) throw new Error('지원하는 Qwen2.5 1.5B Q4_K_M GGUF 파일을 선택해 주세요.')
    const header = await fs.open(real, 'r')
    try {
      const bytes = Buffer.alloc(4)
      await header.read(bytes, 0, 4, 0)
      if (bytes.toString('ascii') !== 'GGUF') throw new Error('올바른 GGUF 모델 파일이 아닙니다.')
    } finally { await header.close() }
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(real)) hash.update(chunk)
    const sha256 = hash.digest('hex')
    if (sha256 !== LOCAL_MODEL_CANDIDATE.sha256) throw new Error('모델 체크섬이 지원 목록과 다릅니다. 안내된 공식 Q4_K_M 파일을 선택해 주세요.')
    this.config.modelPath = real
    this.config.modelSha256 = sha256
    this.state = { ...this.state, modelPath: real, modelBytes: stat.size, modelSha256: sha256,
      verifiedCandidate: true, phase: this.config.runtimePath ? 'untested' : 'unavailable', lastTest: null,
      message: '공식 모델 체크섬이 일치합니다. 실제 추론 검사를 실행해 주세요.' }
    await this.persist()
    return this.status()
  }
  markTest(durationMs: number): void {
    this.state = { ...this.state, phase: 'ready', message: '한국어 지시·구조화 출력 검사를 통과했습니다. 요청마다 로드하고 종료 후 메모리를 반환합니다.',
      lastTest: { at: new Date().toISOString(), durationMs, koreanInstruction: true, structuredOutput: true } }
  }
  fail(message: string): void { this.state = { ...this.state, phase: 'error', message } }
  cancel(id: string): boolean {
    if (!this.active || this.active.id !== id) return false
    this.active.stop('로컬 추론을 취소했습니다. 제안은 적용되지 않았습니다.')
    return true
  }
  unload(): Promise<LocalModelStatus> {
    if (this.active) this.active.stop('모델 작업을 중단했습니다.')
    this.state = { ...this.state, phase: this.config.modelPath && this.config.runtimePath ? 'untested' : 'unavailable',
      lastTest: null, message: '실행 중인 모델에 종료를 요청했습니다. 상주 모델은 사용하지 않습니다.' }
    return this.status()
  }
  async infer(prompt: string, schema: object, requestId: string, smoke = false, cancelled = (): boolean => false): Promise<{ text: string; durationMs: number }> {
    await this.status()
    this.requireIdle()
    const { runtimePath, modelPath, modelSha256 } = this.config
    if (!runtimePath || !modelPath || modelSha256 !== LOCAL_MODEL_CANDIDATE.sha256) throw new Error('로컬 실행기와 지원 모델을 먼저 선택해 주세요.')
    if (!smoke && !this.state.lastTest) throw new Error('모델 관리자에서 실제 추론 검사를 먼저 실행해 주세요.')
    const runtimeData = await readRegularFile(runtimePath, 128 * 1024 * 1024)
    if (!runtimeData || !this.config.runtimeSha256 || contentHash(runtimeData) !== this.config.runtimeSha256) {
      throw new Error('실행기 파일이 변경되었거나 검증 기록이 없습니다. 실행기를 다시 선택해 주세요.')
    }
    const before = await fs.stat(modelPath)
    // Revalidate the model after every launch; mtime/size alone is not an integrity guarantee.
    const hash = createHash('sha256')
    for await (const chunk of createReadStream(modelPath)) {
      if (cancelled()) throw new Error('모델 준비를 취소했습니다.')
      hash.update(chunk)
    }
    if (hash.digest('hex') !== modelSha256) throw new Error('선택한 모델 파일이 변경되었습니다. 모델을 다시 선택해 주세요.')
    const after = await fs.stat(modelPath)
    if (before.mtimeMs !== after.mtimeMs || before.ino !== after.ino || before.size !== after.size) throw new Error('모델을 확인하는 중 파일이 변경되었습니다.')
    if (cancelled()) throw new Error('모델 준비를 취소했습니다.')
    this.state = { ...this.state, phase: smoke ? 'loading' : 'running', modelBytes: after.size, verifiedCandidate: true,
      lastTest: smoke ? null : this.state.lastTest,
      message: smoke ? '실제 한국어 추론 검사 중…' : '한국어 요청을 보정 제안으로 변환 중…' }
    const started = Date.now()
    try {
      const result = await this.run(runtimePath, [
        '-m', modelPath, '--no-conversation', '--no-display-prompt', '--simple-io', '--no-escape',
        '-c', '4096', '-n', '512', '-ngl', '0', '-t', String(Math.max(1, Math.min(4, cpus().length - 2))),
        '-b', '128', '-ub', '128', '--temp', '0', '--seed', '1', '--json-schema', JSON.stringify(schema),
        '-f', '{PROMPT_FILE}'
      ], requestId, 180_000, 65_536, modelPath, prompt, cancelled)
      const durationMs = Date.now() - started
      this.state = { ...this.state, phase: this.state.lastTest ? 'ready' : 'untested', message: '추론이 끝났습니다. 제안 적용은 별도 승인이 필요합니다.' }
      return { text: completionText(result.stdout), durationMs }
    } catch (err) {
      this.fail((err as Error).message)
      throw err
    }
  }
  private async run(runtime: string, args: string[], id: string, timeout: number, maxOutput = 32_768, model?: string, prompt?: string, cancelled = (): boolean => false): Promise<{ stdout: string; stderr: string }> {
    if (process.platform !== 'darwin') throw new Error('파일 접근 보호를 적용하는 macOS 실행 경로만 지원합니다.')
    this.requireIdle()
    const work = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'luxinus-inference-')))
    try {
      // Official extracted releases load sibling @loader_path dylibs. Authorize
      // their exact real paths, never the containing (possibly home) directory.
      const entries = await fs.readdir(dirname(runtime))
      const libraryNames = entries.filter(name => name.endsWith('.dylib')).slice(0, 128)
      const libraries = await Promise.all(libraryNames.map(name => fs.realpath(join(dirname(runtime), name))))
      const promptFile = join(work, 'prompt.txt')
      if (prompt !== undefined) await fs.writeFile(promptFile, prompt, { mode: 0o600 })
      if (cancelled()) throw new Error('모델 준비를 취소했습니다.')
      return await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', ['-p', modelSandboxProfile(runtime, work, model, libraries), runtime,
          ...args.map((a) => a === '{PROMPT_FILE}' ? promptFile : a)], {
          cwd: work, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
          // No user tokens, endpoint overrides, HOME configs or proxy settings.
          // The verified b10809 Metal registry treats 0 devices as disabled.
          // -ngl 0 alone still initializes Metal kernels before CLI parsing.
          env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', GGML_METAL_DEVICES: '0' }
        })
        let stdout = '', stderr = '', bytes = 0, stopped: string | null = null
        let hardKill: ReturnType<typeof setTimeout> | undefined
        const kill = (signal: NodeJS.Signals): void => {
          try { if (child.pid) process.kill(-child.pid, signal) } catch { child.kill(signal) }
        }
        const stop = (message: string): void => {
          if (stopped) return
          stopped = message
          kill('SIGTERM')
          hardKill = setTimeout(() => kill('SIGKILL'), 1000)
        }
        this.active = { id, child, stop }
        const timer = setTimeout(() => stop(`실행 시간 제한(${Math.round(timeout / 1000)}초)을 초과했습니다.`), timeout)
        const clean = (): void => {
          clearTimeout(timer)
          if (hardKill) clearTimeout(hardKill)
          if (this.active?.child === child) this.active = null
        }
        const receive = (chunk: string, target: 'out' | 'err'): void => {
          bytes += Buffer.byteLength(chunk)
          if (bytes > maxOutput) { stop('실행기 출력이 제한을 초과했습니다.'); return }
          if (target === 'out') stdout += chunk; else stderr += chunk
        }
        child.stdout!.setEncoding('utf8').on('data', (chunk: string) => receive(chunk, 'out'))
        child.stderr!.setEncoding('utf8').on('data', (chunk: string) => receive(chunk, 'err'))
        child.on('error', (err) => { clean(); reject(new Error(`로컬 실행기를 시작하지 못했습니다: ${err.message}`)) })
        child.on('close', (code) => {
          clean()
          if (stopped) reject(new Error(stopped))
          else if (code !== 0) reject(new Error(stderr.includes('sandbox_apply')
            ? 'macOS가 추론 프로세스의 파일 접근 보호 실행을 거부했습니다. 파일 보호 없이 실행하지 않습니다.'
            : `로컬 실행기가 종료되었습니다(코드 ${code}). 실행기 호환성·모델·메모리를 확인해 주세요.`))
          else resolve({ stdout, stderr })
        })
      })
    } finally { await fs.rm(work, { recursive: true, force: true }) }
  }
}
