import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// The shipped index.html hard-codes a strict CSP (script-src 'self') that blocks
// Vite's inline react-refresh preamble in a plain browser. This preview server is
// NOT the app — strip the CSP meta here only so the design renders for review.
// The real CSP is enforced by Electron (main-process header + prod index.html).
function stripCspForPreview(): Plugin {
  return {
    name: 'luxinus-strip-csp-preview',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/<meta[^>]*Content-Security-Policy[^>]*>/i, '')
    }
  }
}

// Design-review ONLY: serves the renderer as a plain web app so it can be opened
// in a browser and screenshotted. Not part of the Electron build (electron-vite
// drives that via electron.vite.config.ts). The app degrades gracefully without
// the preload bridge — App seeds sample photos in dev when window.luxinus is absent.
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer/src'),
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  plugins: [react(), stripCspForPreview()],
  // libraw-wasm ships its own Web Worker + wasm; excluding it from dep
  // optimization keeps those asset URLs resolvable during this test.
  optimizeDeps: { exclude: ['libraw-wasm'] },
  // HMR off: an open HMR websocket keeps headless Chrome's virtual-time from
  // settling, which hangs screenshots. Static review server, no live reload.
  server: { port: 5199, strictPort: true, hmr: false }
})
