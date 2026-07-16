import { app, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import { coerceEditState, type EditState } from '../shared/edits'
import { PRESET_SCHEMA_VERSION, type Preset, type XmpImportResult } from '../shared/presets'
import { importXmp } from './xmp'

// Native presets are stored as individual JSON files in userData/presets/, so
// they survive updates and are easy to back up. All local; nothing transmitted.
function presetsDir(): string {
  return path.join(app.getPath('userData'), 'presets')
}

interface PresetFile {
  version: number
  preset: Preset
}

async function listPresets(): Promise<Preset[]> {
  const dir = presetsDir()
  try {
    const files = await fs.readdir(dir)
    const presets: Preset[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as PresetFile
        if (parsed?.preset?.id) {
          parsed.preset.edits = coerceEditState(parsed.preset.edits)
          presets.push(parsed.preset)
        }
      } catch {
        /* skip unreadable preset */
      }
    }
    return presets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  } catch {
    return []
  }
}

async function savePreset(
  name: string,
  edits: EditState,
  origin: 'native' | 'xmp'
): Promise<Preset> {
  await fs.mkdir(presetsDir(), { recursive: true })
  const preset: Preset = {
    id: randomUUID(),
    name: name.trim() || 'Untitled',
    edits,
    createdAt: new Date().toISOString(),
    origin
  }
  const payload: PresetFile = { version: PRESET_SCHEMA_VERSION, preset }
  const tmp = path.join(presetsDir(), preset.id + '.json.tmp')
  const target = path.join(presetsDir(), preset.id + '.json')
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8')
  await fs.rename(tmp, target)
  return preset
}

async function deletePreset(id: string): Promise<boolean> {
  try {
    await fs.rm(path.join(presetsDir(), `${id}.json`), { force: true })
    return true
  } catch {
    return false
  }
}

export function registerPresetHandlers(): void {
  ipcMain.handle(IpcChannels.presets.list, () => listPresets())

  ipcMain.handle(IpcChannels.presets.save, (_e, name: string, edits: EditState) =>
    savePreset(name, edits, 'native')
  )

  ipcMain.handle(IpcChannels.presets.delete, (_e, id: string) => deletePreset(id))

  // Import a Lightroom .xmp → map + (optionally) persist as a preset.
  ipcMain.handle(IpcChannels.presets.importXmp, async (): Promise<
    (XmpImportResult & { preset: Preset }) | null
  > => {
    const res = await dialog.showOpenDialog({
      title: 'Import Lightroom preset (.xmp)',
      properties: ['openFile'],
      filters: [{ name: 'Lightroom preset', extensions: ['xmp'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const file = res.filePaths[0]
    const xml = await fs.readFile(file, 'utf8')
    const imported = importXmp(xml, path.parse(file).name)
    const preset = await savePreset(imported.name, imported.edits, 'xmp')
    return { ...imported, preset }
  })
}
