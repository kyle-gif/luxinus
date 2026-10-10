import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

// electron-vite drives three independent builds: main, preload, and renderer.
// Native/heavy node deps are externalized so they are not bundled by Vite.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Forked as an Electron utilityProcess at runtime (heavy image work).
          'decode.worker': resolve(__dirname, 'src/workers/decode.worker.ts'),
          // ONNX inference utility process (onnxruntime-node; AI features).
          'onnx.worker': resolve(__dirname, 'src/workers/onnx.worker.ts'),
          'portrait.worker': resolve(__dirname, 'src/workers/portrait.worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          decoder: resolve(__dirname, 'src/preload/decoder.ts')
        },
        // Sandboxed preloads MUST be CommonJS. Force a .cjs extension so it is
        // unambiguously CJS and matches the path loaded in src/main/index.ts.
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    plugins: [react()],
    // libraw-wasm ships its own Web Worker + wasm; excluding it from dep
    // optimization keeps those asset URLs resolvable in the decode window.
    optimizeDeps: { exclude: ['libraw-wasm'] },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Hidden window that runs libraw-wasm in its native Chromium env.
          decoder: resolve(__dirname, 'src/renderer/decoder.html')
        }
      }
    }
  }
})
