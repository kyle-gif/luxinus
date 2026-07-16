import { ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { IpcChannels } from '../shared/ipc-channels'
import {
  EDIT_SCHEMA_VERSION,
  coerceEditState,
  type EditState,
  type Sidecar
} from '../shared/edits'

// Non-destructive edit persistence. Edits live in a sidecar JSON *next to the
// original* — the original file itself is never opened for writing. Sidecar name
// mirrors the photo: IMG_1234.CR2 -> IMG_1234.CR2.lux.json.
export function sidecarPath(filePath: string): string {
  return filePath + '.lux.json'
}

export async function loadEdits(filePath: string): Promise<EditState | null> {
  try {
    const raw = await fs.readFile(sidecarPath(filePath), 'utf8')
    const parsed = JSON.parse(raw) as Partial<Sidecar>
    if (!parsed || parsed.app !== 'luxinus' || !parsed.edits) return null
    return coerceEditState(parsed.edits)
  } catch {
    return null // no sidecar yet, or unreadable — treat as unedited
  }
}

export async function saveEdits(filePath: string, edits: EditState): Promise<boolean> {
  const payload: Sidecar = {
    version: EDIT_SCHEMA_VERSION,
    app: 'luxinus',
    edits,
    // Timestamp stamped in main (renderer has no clock authority here).
    updatedAt: new Date().toISOString()
  }
  const target = sidecarPath(filePath)
  const tmp = target + '.tmp'
  try {
    // Atomic write: temp file then rename, so a crash never truncates the sidecar.
    await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
    await fs.rename(tmp, target)
    return true
  } catch (err) {
    console.error('[edits] save failed:', (err as Error).message)
    await fs.rm(tmp, { force: true }).catch(() => {})
    return false
  }
}

/** Best-effort check for which of the given files have a sidecar (edited badge). */
async function editedList(filePaths: string[]): Promise<string[]> {
  const results = await Promise.all(
    filePaths.map(async (fp) => {
      try {
        await fs.access(sidecarPath(fp))
        return fp
      } catch {
        return null
      }
    })
  )
  return results.filter((x): x is string => x !== null)
}

export function registerEditHandlers(): void {
  ipcMain.handle(IpcChannels.edits.load, (_e, filePath: string) => loadEdits(filePath))
  ipcMain.handle(IpcChannels.edits.save, (_e, filePath: string, edits: EditState) =>
    saveEdits(filePath, edits)
  )
  ipcMain.handle(IpcChannels.edits.editedList, (_e, filePaths: string[]) => editedList(filePaths))
}
