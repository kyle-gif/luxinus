import { app, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { IpcChannels } from '../shared/ipc-channels'
import type { EditState } from '../shared/edits'
import { PRESET_SCHEMA_VERSION, captureAsPreset, type Preset, type XmpImportResult } from '../shared/presets'
import { importXmp } from './xmp'
import { assertTrustedSender, validatePresetId } from './file-policy'
import { validateEditState } from '../shared/edit-validation'
import { atomicReplace, decodeUtf8, isMissing, readRegularFile } from './safe-file'

// Native presets are stored as individual JSON files in userData/presets/, so
// they survive updates and are easy to back up. All local; nothing transmitted.
function presetsDir(): string {
  return path.join(app.getPath('userData'), 'presets')
}

interface PresetFile {
  version: number
  preset: Preset
  sourceXmp?: string
}

async function listPresets(): Promise<Preset[]> {
  const dir = presetsDir()
  try {
    const files = await fs.readdir(dir)
    const presets: Preset[] = []
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      try {
        const raw = await readRegularFile(path.join(dir, f))
        if (!raw) continue
        const parsed = JSON.parse(decodeUtf8(raw)) as PresetFile
        if (parsed?.preset?.id) {
          validatePresetId(parsed.preset.id)
          if (f !== `${parsed.preset.id}.json` || typeof parsed.preset.name !== 'string') continue
          parsed.preset.edits = captureAsPreset(validateEditState(parsed.preset.edits))
          presets.push(parsed.preset)
        }
      } catch (error) {
        console.warn('[presets] unreadable preset:', f, (error as Error).message)
      }
    }
    return presets.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}

async function savePreset(
  name: string,
  edits: EditState,
  origin: 'native' | 'xmp',
  sourceXmp?: string
): Promise<Preset> {
  if (typeof name !== 'string' || name.length > 200) throw new Error('프리셋 이름은 200자 이하여야 합니다.')
  edits = captureAsPreset(validateEditState(edits))
  await fs.mkdir(presetsDir(), { recursive: true })
  const preset: Preset = {
    id: randomUUID(),
    name: name.trim() || '이름 없는 프리셋',
    edits,
    createdAt: new Date().toISOString(),
    origin
  }
  const payload: PresetFile = { version: PRESET_SCHEMA_VERSION, preset, ...(sourceXmp ? { sourceXmp } : {}) }
  const target = path.join(presetsDir(), preset.id + '.json')
  await atomicReplace(target, JSON.stringify(payload, null, 2), null, async () => {
    if (await fs.realpath(presetsDir()) !== presetsDir()) throw new Error('프리셋 폴더의 심볼릭 링크는 허용하지 않습니다.')
  })
  return preset
}

async function deletePreset(id: string): Promise<boolean> {
  validatePresetId(id)
  if (await fs.realpath(presetsDir()) !== presetsDir()) throw new Error('프리셋 폴더 위치가 변경되었습니다.')
  await fs.rm(path.join(presetsDir(), `${id}.json`), { force: true })
  return true
}

export function registerPresetHandlers(): void {
  ipcMain.handle(IpcChannels.presets.list, (event) => { assertTrustedSender(event); return listPresets() })

  ipcMain.handle(IpcChannels.presets.save, (event, name: string, edits: EditState) => {
    assertTrustedSender(event)
    return savePreset(name, edits, 'native')
  })

  ipcMain.handle(IpcChannels.presets.delete, (event, id: string) => { assertTrustedSender(event); return deletePreset(id) })

  // Import a Lightroom .xmp → map + (optionally) persist as a preset.
  ipcMain.handle(IpcChannels.presets.importXmp, async (event): Promise<
    (XmpImportResult & { preset: Preset }) | null
  > => {
    assertTrustedSender(event)
    const res = await dialog.showOpenDialog({
      title: 'Lightroom 프리셋 가져오기 (.xmp)',
      properties: ['openFile'],
      filters: [{ name: 'Lightroom preset', extensions: ['xmp'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const file = res.filePaths[0]
    const raw = await readRegularFile(file, 4 * 1024 * 1024)
    if (!raw) throw new Error('XMP 파일을 찾을 수 없습니다.')
    const xml = decodeUtf8(raw)
    const imported = importXmp(xml, path.parse(file).name)
    const preset = await savePreset(imported.name, imported.edits, 'xmp', xml)
    return { ...imported, preset }
  })
}
