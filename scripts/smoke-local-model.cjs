// Actual macOS inference and policy checks; requires an already installed model.
const assert = require('node:assert/strict')
const { isDeepStrictEqual } = require('node:util')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const net = require('node:net')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const out = path.join(root, '.omc', 'local-agent-smoke')
fs.mkdirSync(out, { recursive: true })
for (const [name, source] of [['local-model', 'src/main/local-model.ts'], ['shared', 'src/shared/local-agent.ts'], ['edits', 'src/shared/edits.ts']]) {
  esbuild.buildSync({ entryPoints: [path.join(root, source)], outfile: path.join(out, name + '.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'warning' })
}
const networkRequests = []
require('./network-observer.cjs').observeNodeNetwork(event => networkRequests.push(event))
const { LocalModel, modelSandboxProfile } = require(path.join(out, 'local-model.cjs'))
const { agentPrompt, agentOutputSchema, parseAgentOutput, unsupportedAgentRequest, validateRequestedAgentPatch } = require(path.join(out, 'shared.cjs'))
const { defaultEditState } = require(path.join(out, 'edits.cjs'))
const runtimePath = process.argv[2]
const modelPath = process.argv[3]
if (!runtimePath || !modelPath || process.platform !== 'darwin') throw new Error('Usage: node scripts/smoke-local-model.cjs /absolute/llama-completion /absolute/model.gguf (macOS)')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function probeSandbox(work) {
  const source = path.join(work, 'probe.c')
  const binary = path.join(work, 'sandbox-probe')
  const scratch = path.join(work, 'scratch')
  fs.mkdirSync(scratch)
  const denied = path.join(work, 'unapproved-photo-fixture.txt')
  fs.writeFileSync(denied, 'synthetic fixture remains unchanged')
  fs.writeFileSync(source, `#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  int sock=socket(AF_INET,SOCK_STREAM,0); int networkAllowed=0;
  if(sock>=0) { struct sockaddr_in addr={0}; addr.sin_family=AF_INET; addr.sin_port=htons(atoi(argv[3])); addr.sin_addr.s_addr=htonl(0x7f000001);
    int result=connect(sock,(struct sockaddr*)&addr,sizeof(addr)); networkAllowed=(result==0); close(sock); }
  int f=open(argv[1],O_RDONLY); int readDenied=(f<0 && (errno==EPERM || errno==EACCES)); if(f>=0) close(f);
  f=open(argv[1],O_WRONLY|O_TRUNC); int writeDenied=(f<0 && (errno==EPERM || errno==EACCES)); if(f>=0) close(f);
  f=open(argv[2],O_WRONLY|O_CREAT|O_EXCL,0600); int scratchAllowed=(f>=0); if(f>=0) {write(f,"ok",2);close(f);}
  pid_t child=fork(); int execDenied=0; if(child==0) {execl("/bin/sh","sh","-c","exit 99",NULL); _exit(errno==EPERM || errno==EACCES ? 111 : 112);}
  if(child>0) {int status;waitpid(child,&status,0);execDenied=WIFEXITED(status)&&WEXITSTATUS(status)==111;}
  printf("{\\"networkAllowed\\":%d,\\"readDenied\\":%d,\\"writeDenied\\":%d,\\"scratchAllowed\\":%d,\\"execDenied\\":%d}\\n",networkAllowed,readDenied,writeDenied,scratchAllowed,execDenied);
  return networkAllowed&&readDenied&&writeDenied&&scratchAllowed&&execDenied ? 0 : 1;
}`)
  const compile = spawnSync('/usr/bin/clang', [source, '-o', binary], { encoding: 'utf8' })
  assert.equal(compile.status, 0, compile.stderr)
  let connections = 0
  const server = net.createServer(socket => { connections++; socket.destroy() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const result = spawnSync('/usr/bin/sandbox-exec', ['-p', modelSandboxProfile(binary, scratch), binary, denied, path.join(scratch, 'allowed.txt'), String(server.address().port)], {
      encoding: 'utf8', timeout: 10_000, cwd: scratch, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', GGML_METAL_DEVICES: '0' }
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    await delay(100)
    assert.equal(connections, 1)
    assert.equal(fs.readFileSync(denied, 'utf8'), 'synthetic fixture remains unchanged')
    assert.equal(fs.readFileSync(path.join(scratch, 'allowed.txt'), 'utf8'), 'ok')
    return { ...JSON.parse(result.stdout), loopbackConnections: connections, profile: 'exact production modelSandboxProfile with synthetic executable' }
  } finally { await new Promise(resolve => server.close(resolve)) }
}

;(async () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'luxinus-model-smoke-')))
  try {
    const model = new LocalModel(path.join(work, 'settings'))
    await model.selectRuntime(runtimePath)
    await model.selectModel(modelPath)
    const report = { at: new Date().toISOString(), runtime: runtimePath, model: modelPath, status: await model.status(), cases: [], cancellation: null, sandbox: null }
    const runCase = async (request, base, expectedPatch, exampleCase) => {
      const unsupported = unsupportedAgentRequest(request)
      if (unsupported) {
        assert.equal(exampleCase, false, 'Supported request must reach actual model')
        const item = { request, blockedBeforeInference: true, reason: unsupported }
        report.cases.push(item)
        console.log(JSON.stringify(item))
        return
      }
      const id = require('node:crypto').randomUUID()
      let sampledPeakRSSKiB = 0
      const sample = setInterval(() => {
        const pid = model.active?.child.pid
        if (pid) {
          const rss = spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
          sampledPeakRSSKiB = Math.max(sampledPeakRSSKiB, Number(rss.stdout.trim()) || 0)
        }
      }, 100)
      try {
        const result = await model.infer(agentPrompt(id, base, request), agentOutputSchema(id), id, true)
        const output = parseAgentOutput(result.text, id)
        let rejectedOutputReason = null
        try { validateRequestedAgentPatch(request, output.patch) } catch (error) { rejectedOutputReason = error.message }
        const koreanReason = /[가-힣]/.test(output.reason)
        const patchMatches = isDeepStrictEqual(output.patch, expectedPatch)
        const item = { request, current: { exposure: base.exposure, saturation: base.saturation, shadows: base.shadows, contrast: base.contrast }, exampleCase, output, rejectedOutputReason, durationMs: result.durationMs, sampledPeakRSSMiB: Math.round(sampledPeakRSSKiB / 1024 * 10) / 10, samplingMs: 100, koreanReason, patchMatches }
        report.cases.push(item)
        console.log(JSON.stringify(item))
        if (exampleCase && !rejectedOutputReason) { assert.equal(koreanReason, true); assert.deepEqual(output.patch, expectedPatch) }
      } finally { clearInterval(sample) }
    }
    await runCase('그림자 값을 정확히 20으로 바꿔줘. 다른 항목은 바꾸지 마.', defaultEditState(), { shadows: 20 }, true)
    await runCase('노출을 +0.5EV 올리고 채도를 12 낮춰줘', defaultEditState(), { exposure: 25, saturation: -12 }, false)
    await runCase('그림자를 지금보다 10 더 밝게 해줘', { ...defaultEditState(), shadows: 20 }, { shadows: 30 }, false)
    await runCase('노출을 +1.2EV로 설정해줘', defaultEditState(), { exposure: 60 }, false)
    await runCase('현재 대비를 4 더 올려줘', { ...defaultEditState(), contrast: 8 }, { contrast: 12 }, false)
    await runCase('사진 1장 노출을 25로, 채도를 -12로 설정해줘.', defaultEditState(), { exposure: 25, saturation: -12 }, true)
    await runCase('대비를 17로 설정해줘.', defaultEditState(), { contrast: 17 }, true)
    const id = 'actual-cancellation'
    const pending = model.infer(agentPrompt(id, defaultEditState(), '그림자를 25로 바꿔줘'), agentOutputSchema(id), id, true).then(() => ({ success: true }), error => ({ success: false, error: error.message }))
    const deadline = Date.now() + 10_000
    while (!model.active?.child.pid && Date.now() < deadline) await delay(10)
    assert.ok(model.active?.child.pid, 'Actual model child must start before cancellation')
    const pid = model.active.child.pid
    const started = Date.now()
    assert.equal(model.cancel(id), true)
    const cancelled = await pending
    assert.equal(cancelled.success, false)
    assert.match(cancelled.error, /취소/)
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH')
    report.cancellation = { ...cancelled, terminatedPid: pid, stoppedMs: Date.now() - started, childGone: true }
    console.log(JSON.stringify({ cancellation: report.cancellation }))
    assert.deepEqual(networkRequests, [], 'Local inference host made an unexpected network request')
    report.network = { normalHostRequests: [...networkRequests], scope: 'Node host JS API observation; native inference is not packet-captured' }
    report.sandbox = await probeSandbox(work)
    report.policyPassed = report.cases.every(item => item.blockedBeforeInference || item.rejectedOutputReason || (item.koreanReason && item.patchMatches))
    report.allSupportedCasesMatched = report.cases.filter(item => !item.blockedBeforeInference).every(item => item.koreanReason && item.patchMatches)
    fs.writeFileSync(path.join(out, 'model-smoke.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ sandbox: report.sandbox, policyPassed: report.policyPassed, allSupportedCasesMatched: report.allSupportedCasesMatched, report: path.join(out, 'model-smoke.json') }))
    if (!report.policyPassed || !report.allSupportedCasesMatched) process.exitCode = 2
  } finally { fs.rmSync(work, { recursive: true, force: true }) }
})().catch(error => { console.error(error); process.exitCode = 1 })
