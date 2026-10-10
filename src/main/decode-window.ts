import { app, BrowserWindow, ipcMain, protocol, session } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { runRestoration, shutdownAi } from './onnx'
import { randomUUID } from 'node:crypto'
import type { RawDecodeMode, RawDecodeResult } from '../shared/library'
import type { ExportRenderRequest, ExportRenderResult } from '../shared/export'

// Hosts the hidden Chromium "decode window" that runs libraw-wasm in its native
// environment (Web Worker + wasm fetch), which the Node utility process cannot.
// The window is served over a privileged custom protocol so its wasm loads via
// fetch under file:// in production. Decoding loads bundled resources only.

const isDev = !app.isPackaged
const SCHEME = 'lux'
// The dedicated session uses decoder.html's CSP, including WebAssembly support,
// independently of the UI document's script policy.
const PARTITION = 'persist:lux-decode'

// Registered BEFORE app ready.
export function registerDecodeSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true }
    }
  ])
}

function mimeFor(file: string): string {
  const ext = path.extname(file).toLowerCase()
  const map: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.mjs': 'text/javascript',
    '.css': 'text/css',
    '.wasm': 'application/wasm',
    '.json': 'application/json',
    '.map': 'application/json',
    '.svg': 'image/svg+xml'
  }
  return map[ext] ?? 'application/octet-stream'
}

// Registered AFTER app ready. Serves the built renderer dir under lux://app/ on
// the decode window's dedicated session.
export function registerDecodeProtocol(): void {
  const rendererDir = path.join(__dirname, '../renderer')
  const ses = session.fromPartition(PARTITION)
  ses.protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'decoder.html'
    const filePath = path.normalize(path.join(rendererDir, rel))
    if (url.hostname !== 'app' || !filePath.startsWith(rendererDir + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }
    try {
      const data = await fs.readFile(filePath)
      return new Response(data, { headers: { 'content-type': mimeFor(filePath) } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

// ── window lifecycle + request correlation ──────────────────────────────────
let win: BrowserWindow | null = null
let readyPromise: Promise<void> | null = null

interface Pending {
  resolve: (r: RawDecodeResult) => void
  reject: (e: Error) => void
}
const pending = new Map<string, Pending>()
interface ExportPending {
  resolve: (r: ExportRenderResult) => void
  reject: (e: Error) => void
}
const exportPending = new Map<string, ExportPending>()
let listenersBound = false

function bindListeners(): void {
  if (listenersBound) return
  listenersBound = true
  ipcMain.handle('decoder:restore', (event, payload) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame || !exportPending.has(payload.id)) throw new Error('승인된 내보내기 작업이 아닙니다.')
    return runRestoration(payload)
  })
  ipcMain.on('decoder:reply', (event, payload: { id: string } & RawDecodeResult) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) return
    const p = pending.get(payload.id)
    if (p) {
      pending.delete(payload.id)
      const { id: _id, ...result } = payload
      p.resolve(result)
    }
  })
  ipcMain.on('decoder:fail', (event, payload: { id: string; message: string }) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) return
    const p = pending.get(payload.id)
    if (p) {
      pending.delete(payload.id)
      p.reject(new Error(payload.message))
    }
  })
  ipcMain.on('decoder:export-reply', (event, payload: { id: string } & ExportRenderResult) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) return
    const p = exportPending.get(payload.id)
    if (p) {
      exportPending.delete(payload.id)
      const { id: _id, ...result } = payload
      p.resolve(result)
    }
  })
  ipcMain.on('decoder:export-fail', (event, payload: { id: string; message: string }) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== event.sender.mainFrame) return
    const p = exportPending.get(payload.id)
    if (p) {
      exportPending.delete(payload.id)
      p.reject(new Error(payload.message))
    }
  })
}

function createWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  bindListeners()
  win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      preload: path.join(__dirname, '../preload/decoder.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      partition: PARTITION
    }
  })

  readyPromise = new Promise<void>((resolve, reject) => {
    const created = win!
    const timer = setTimeout(() => { cleanup(); reject(new Error('디코더 초기화 제한 시간을 초과했습니다.')) }, 20000)
    const cleanup = (): void => { clearTimeout(timer); ipcMain.removeListener('decoder:ready', onReady) }
    const onReady = (event: Electron.IpcMainEvent): void => {
      if (event.sender === created.webContents) { cleanup(); resolve() }
    }
    ipcMain.on('decoder:ready', onReady)
    created.webContents.once('did-fail-load', (_event, _code, message) => { cleanup(); reject(new Error(`디코더 로드 실패: ${message}`)) })
    created.once('closed', () => { cleanup(); reject(new Error('디코더 창이 닫혔습니다.')) })
  })

  // Warmup can start the window before a caller awaits readiness.
  void readyPromise.catch(() => {})
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    win.loadURL(`${devUrl}/decoder.html`)
  } else {
    win.loadURL(`${SCHEME}://app/decoder.html`)
  }

  win.on('closed', () => {
    win = null
    readyPromise = null
  })
  return win
}

// Create the decode window early (e.g. when a folder with RAWs is opened) so the
// first RAW selection doesn't pay window-creation + page-load latency.
export function warmupDecodeWindow(): void {
  createWindow()
}

export async function decodeRawViaWindow(
  filePath: string,
  mode: RawDecodeMode
): Promise<RawDecodeResult> {
  const w = createWindow()
  await readyPromise
  const bytes = await fs.readFile(filePath)
  const id = randomUUID()
  return new Promise<RawDecodeResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.webContents.send('decoder:request', { id, bytes: new Uint8Array(bytes), mode })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error('RAW decode timed out'))
      }
    }, 60000)
  })
}

// Full-resolution export render in the hidden window (edit shader + optional
// Frame composite). `req` carries the original bytes + edit state; returns the
// final upright RGBA for main to encode.
export async function renderExportViaWindow(
  req: Omit<ExportRenderRequest, 'id'>
): Promise<ExportRenderResult> {
  const w = createWindow()
  await readyPromise
  const id = randomUUID()
  return new Promise<ExportRenderResult>((resolve, reject) => {
    exportPending.set(id, { resolve, reject })
    w.webContents.send('decoder:export-request', { id, ...req })
    setTimeout(() => {
      if (exportPending.has(id)) {
        exportPending.delete(id)
        reject(new Error('내보내기 제한 시간을 초과했습니다. 복원 작업을 중단했습니다.'))
        cancelExportRender()
      }
    }, req.editState.denoise > 0 ? 360000 : 120000)
  })
}

export function cancelExportRender(): void {
  shutdownAi()
  for (const [id, item] of exportPending) { item.reject(new Error('내보내기가 취소되었습니다.')); exportPending.delete(id) }
  shutdownDecodeWindow()
}

export function shutdownDecodeWindow(): void {
  for (const [id, item] of pending) { item.reject(new Error('디코딩이 중단되었습니다.')); pending.delete(id) }
  for (const [id, item] of exportPending) { item.reject(new Error('내보내기가 중단되었습니다.')); exportPending.delete(id) }
  if (win && !win.isDestroyed()) win.destroy()
  win = null
  readyPromise = null
}
