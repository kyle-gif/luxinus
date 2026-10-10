import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { registerLocalAgentHandlers, stopLocalAgent, isLocalAgentBusy } from './local-agent'
import { registerXmpHandlers, isXmpBusy } from './xmp-handlers'
import { trustRenderer } from './file-policy'
import { IpcChannels } from '../shared/ipc-channels'
import { app, BrowserWindow, session, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { registerLibraryHandlers, shutdownLibrary } from './library'
import { registerEditHandlers } from './edits'
import { registerExportHandlers, shutdownExport, isExportRunning } from './export'
import { registerPresetHandlers } from './presets'
import { registerAiHandlers, shutdownAi } from './onnx'
import { registerRestorationCacheHandlers, isRestorationCacheBusy } from './restoration-cache'
import { registerAgentCaptureHandlers, shutdownAgentCaptures } from './agent-capture'
import { registerPortraitHandlers, isPortraitBusy, shutdownPortrait } from './portrait'
import {
  registerDecodeProtocol,
  registerDecodeSchemes,
  shutdownDecodeWindow
} from './decode-window'

const isDev = !app.isPackaged
let quitting = false

// Must run before app 'ready': privileges the lux:// scheme used to serve the
// hidden decode window + its wasm (so fetch works under file:// in production).
registerDecodeSchemes()

// Keep executable resources local and the app document fixed. Connections are
// permitted; photo processing and local inference simply do not request them.
function buildCsp(): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Vite injects inline styles/scripts in dev; production build is clean.
    'script-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Local images (proxies/thumbnails) are served via file:/data: at runtime.
    'img-src': ["'self'", 'data:', 'blob:', 'file:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", 'http:', 'https:', 'ws:', 'wss:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'", 'blob:']
  }
  return Object.entries(directives)
    .map(([key, vals]) => `${key} ${vals.join(' ')}`)
    .join('; ')
}

function applySecurityPolicies(): void {
  const csp = buildCsp()
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp]
      }
    })
  })

  // Untrusted documents must not replace the app or inherit its preload API.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      const parsed = new URL(url)
      const dev = process.env.ELECTRON_RENDERER_URL
      const allowed = dev ? [dev.replace(/\/$/, '') + '/', dev.replace(/\/$/, '') + '/decoder.html'] : [pathToFileURL(join(__dirname, '../renderer/index.html')).href, 'lux://app/decoder.html']
      const isLocal = allowed.includes(parsed.href)
      if (!isLocal) {
        event.preventDefault()
        console.warn('[luxinus] blocked navigation to remote origin:', url)
      }
    })
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#151515',
    // Frameless with the OS traffic lights inset onto our floating top bar. The
    // renderer pads the top-left to clear them and marks the bar as a drag region,
    // so the window can be moved/closed like a native macOS app.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 16, y: 16 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Renderer is fully sandboxed: no Node, isolated context, no remote module.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const entryUrl = isDev && devUrl ? devUrl.replace(/\/$/, '') + '/' : pathToFileURL(join(__dirname, '../renderer/index.html')).href
  trustRenderer(mainWindow.webContents, entryUrl)
  let approvedClose = false
  let closing = false
  let closeToken: string | null = null
  let rendererFailed = false
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let recoveryShowing = false
  function clearCloseTimer(): void {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = null
  }
  function finishClose(): void {
    approvedClose = true
    if (quitting) app.quit()
    else mainWindow.close()
  }
  async function recoverClose(): Promise<void> {
    clearCloseTimer()
    closing = false
    closeToken = null
    if (recoveryShowing || mainWindow.isDestroyed()) return
    recoveryShowing = true
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning', title: '보정 저장을 확인할 수 없습니다',
        message: '화면이 응답하지 않아 저장 완료를 확인하지 못했습니다.',
        detail: '계속 열어두고 복구할 수 있습니다. 저장하지 않고 닫으면 아직 저장하지 못한 보정은 사라질 수 있습니다.',
        buttons: ['계속 열어두기', '저장하지 않고 닫기'], defaultId: 0, cancelId: 0
      })
      if (result.response === 1 && !isExportRunning() && !isLocalAgentBusy() && !isXmpBusy() && !isRestorationCacheBusy() && !isPortraitBusy()) finishClose()
      else quitting = false
    } finally { recoveryShowing = false }
  }
  const onCloseResult = async (event: Electron.IpcMainEvent, saved: boolean, token: string): Promise<void> => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame || !closing || token !== closeToken) return
    clearCloseTimer()
    closing = false
    if (saved !== true) { quitting = false; return }
    if (isExportRunning() || isLocalAgentBusy() || isXmpBusy() || isRestorationCacheBusy() || isPortraitBusy()) {
      quitting = false
      await dialog.showMessageBox(mainWindow, { type: 'info', message: '진행 중인 사진 작업이 있습니다.', detail: '작업이 끝난 뒤 닫거나 해당 작업의 중단 버튼을 사용해 주세요.' })
      return
    }
    finishClose()
  }
  ipcMain.on(IpcChannels.app.closeResult, onCloseResult)
  mainWindow.on('close', (event) => {
    if (approvedClose) return
    event.preventDefault()
    if (closing || recoveryShowing) return
    if (rendererFailed) { void recoverClose(); return }
    closing = true
    closeToken = randomUUID()
    closeTimer = setTimeout(() => { void recoverClose() }, 15000)
    mainWindow.webContents.send(IpcChannels.app.prepareClose, closeToken)
  })
  mainWindow.webContents.on('render-process-gone', () => {
    rendererFailed = true
    if (closing) void recoverClose()
  })
  mainWindow.webContents.on('did-fail-load', (_event, code) => { if (code !== -3) rendererFailed = true })
  mainWindow.webContents.on('did-finish-load', () => { rendererFailed = false })
  mainWindow.once('closed', () => { clearCloseTimer(); ipcMain.removeListener(IpcChannels.app.closeResult, onCloseResult) })
  mainWindow.once('ready-to-show', () => mainWindow.show())

  // electron-vite exposes the dev server URL via this env var; otherwise load
  // the built renderer from disk.
  if (isDev && devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  applySecurityPolicies()
  registerDecodeProtocol()
  registerIpcHandlers()
  registerLibraryHandlers()
  registerEditHandlers()
  registerExportHandlers()
  registerPresetHandlers()
  registerAiHandlers()
  registerRestorationCacheHandlers()
  registerPortraitHandlers()
  registerAgentCaptureHandlers()
  registerLocalAgentHandlers()
  registerXmpHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => { quitting = true })

app.on('will-quit', () => {
  shutdownLibrary()
  shutdownDecodeWindow()
  void shutdownExport()
  shutdownAi()
  shutdownPortrait()
  shutdownAgentCaptures()
  stopLocalAgent()
})
