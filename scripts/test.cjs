const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const out = path.join(root, '.omc', 'test-build')
fs.mkdirSync(out, { recursive: true })
const tests = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.ts')).sort()
for (const test of tests) {
  esbuild.buildSync({ entryPoints: [path.join(root, 'tests', test)], outfile: path.join(out, test.replace('.ts', '.cjs')), bundle: true, packages: 'external', platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning' })
}
const result = spawnSync(process.execPath, ['--test', ...tests.map((test) => path.join(out, test.replace('.ts', '.cjs')))], { cwd: root, stdio: 'inherit' })
process.exit(result.status ?? 1)
