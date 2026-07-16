import { app, ipcMain } from 'electron'
import { arch, platform } from 'node:os'
import { IpcChannels, type PlatformInfo } from '../shared/ipc-channels'

// All privileged operations live in the main process and are exposed to the
// renderer only through the narrow, typed surface defined in the preload.
// Phase 0 wires the contract; heavy handlers (RAW decode, ONNX, export) are
// added in their respective phases via utility processes.

function resolvePreferredExecutionProvider(): PlatformInfo['preferredExecutionProvider'] {
  // Reported for capability display only. The real EP is negotiated in Phase 5
  // (VRAM probing + sequential session management).
  switch (platform()) {
    case 'win32':
      return 'DirectML'
    case 'darwin':
      return 'CoreML'
    default:
      return 'CPU'
  }
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannels.app.getVersion, () => app.getVersion())

  ipcMain.handle(IpcChannels.app.getPlatformInfo, (): PlatformInfo => {
    return {
      platform: platform(),
      arch: arch(),
      preferredExecutionProvider: resolvePreferredExecutionProvider()
    }
  })

  // Library/folder handlers live in ./library.ts (they own the decode process).

  // Optional, user-initiated update check. Stubbed in Phase 0; when implemented
  // it must send NO user data — only a version string request.
  ipcMain.handle(IpcChannels.update.check, async () => {
    return { available: false, latestVersion: app.getVersion() }
  })
}
