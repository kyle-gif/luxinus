import { app, BrowserWindow, session, shell } from 'electron'
import { join } from 'node:path'
import { registerIpcHandlers } from './ipc'
import { registerLibraryHandlers, shutdownLibrary } from './library'
import { registerEditHandlers } from './edits'
import { registerExportHandlers, shutdownExport } from './export'
import { registerPresetHandlers } from './presets'
import { registerAiHandlers, shutdownAi } from './onnx'
import {
  registerDecodeProtocol,
  registerDecodeSchemes,
  shutdownDecodeWindow
} from './decode-window'

const isDev = !app.isPackaged

// Must run before app 'ready': privileges the lux:// scheme used to serve the
// hidden decode window + its wasm (so fetch works under file:// in production).
registerDecodeSchemes()

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL-ONLY SECURITY POLICY
//
// The renderer runs under a strict Content-Security-Policy:
//   default-src 'self'  → only bundled app resources
//   connect-src 'none'  → the renderer may NOT open any network connection
// This is the hard guarantee that photo pixels, paths, EXIF, and edit history
// can never be exfiltrated from the UI layer. In dev we relax connect-src just
// enough for Vite HMR's websocket; production is fully locked down.
// ─────────────────────────────────────────────────────────────────────────────
function buildCsp(): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Vite injects inline styles/scripts in dev; production build is clean.
    'script-src': isDev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    // Local images (proxies/thumbnails) are served via file:/data: at runtime.
    'img-src': ["'self'", 'data:', 'blob:', 'file:'],
    'font-src': ["'self'", 'data:'],
    // HARD LOCK: no outbound connections from the renderer. Dev adds only the
    // local Vite HMR websocket so hot reload works; it reaches nothing external.
    'connect-src': isDev ? ["'self'", 'ws://localhost:*', 'http://localhost:*'] : ["'none'"],
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

  // Belt-and-suspenders: block every navigation and popup to a remote origin.
  // Even if some code tried to phone home, it cannot leave the app.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event, url) => {
      const isLocal =
        url.startsWith('file:') || url.startsWith('http://localhost') || url.startsWith('lux://')
      if (!isLocal) {
        event.preventDefault()
        console.warn('[luxinus] blocked navigation to remote origin:', url)
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      // External links (e.g. help/docs) open in the OS browser, never in-app.
      if (url.startsWith('https:')) shell.openExternal(url)
      return { action: 'deny' }
    })
  })
}

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#0A0A0C',
    // Frameless with the OS traffic lights inset onto our floating top bar. The
    // renderer pads the top-left to clear them and marks the bar as a drag region,
    // so the window can be moved/closed like a native macOS app.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 18, y: 22 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      // Renderer is fully sandboxed: no Node, isolated context, no remote module.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // electron-vite exposes the dev server URL via this env var; otherwise load
  // the built renderer from disk.
  const devUrl = process.env['ELECTRON_RENDERER_URL']
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
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  shutdownLibrary()
  shutdownDecodeWindow()
  void shutdownExport()
  shutdownAi()
})
