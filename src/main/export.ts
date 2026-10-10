import { validateEditState } from '../shared/edit-validation'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertTrustedSender, assertAuthorizedPhoto, authorizeExportDirectory, assertExportDirectory } from './file-policy'
import sharp, { type Sharp } from 'sharp'
import { ExifTool } from 'exiftool-vendored'
import { IpcChannels } from '../shared/ipc-channels'
import { isRawExt } from '../shared/library'
import {
  frameFields,
  renderFilename,
  type ExportItem,
  type ExportOptions,
  type ExportProgress
} from '../shared/export'
import { defaultEditState } from '../shared/edits'
import { loadEdits } from './edits'
import { assertSemanticSource } from './semantic-source'
import { cancelExportRender, renderExportViaWindow } from './decode-window'

// Formats Chromium can't decode in the render window → pre-convert to PNG here.
const NEEDS_PRECONVERT = new Set(['.tif', '.tiff', '.heic', '.heif'])

// exiftool is expensive to spawn; keep one instance for the app lifetime.
let exiftool: ExifTool | null = null
function getExifTool(): ExifTool {
  if (!exiftool) exiftool = new ExifTool({ taskTimeoutMillis: 20000 })
  return exiftool
}

function encode(pipeline: Sharp, opts: ExportOptions): { buf: Sharp; ext: string } {
  switch (opts.format) {
    case 'png':
      return { buf: pipeline.png(), ext: 'png' }
    case 'tiff':
      return { buf: pipeline.tiff({ quality: opts.quality }), ext: 'tiff' }
    case 'jpeg':
    default:
      return { buf: pipeline.jpeg({ quality: opts.quality, mozjpeg: true }), ext: 'jpg' }
  }
}

export async function exportOne(item: ExportItem, opts: ExportOptions, seq: number, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted()
  await assertAuthorizedPhoto(item.filePath)
  await assertExportDirectory(opts.destDir)
  const ext = path.extname(item.filePath).toLowerCase()
  const isRaw = isRawExt(ext)

  // Prepare source bytes for the render window (pre-convert TIFF/HEIF).
  let bytes: Uint8Array
  if (!isRaw && NEEDS_PRECONVERT.has(ext)) {
    bytes = new Uint8Array(await sharp(item.filePath).rotate().toColourspace('srgb').png().toBuffer())
  } else {
    bytes = new Uint8Array(await fs.readFile(item.filePath))
  }

  const frame =
    opts.exifMode === 'frame'
      ? { style: opts.frameStyle, fields: frameFields(item.meta, item.fileName) }
      : null

  // Active photo carries its live edit buffer; others load their sidecar.
  const editState = item.editState ?? (await loadEdits(item.filePath)) ?? defaultEditState()
  await assertSemanticSource(editState, item.filePath)

  // Full-res edit render (+ optional frame) in the hidden WebGL window.
  const rendered = await renderExportViaWindow({
    ext,
    isRaw,
    bytes,
    editState: validateEditState(editState),
    longEdge: opts.longEdge,
    frame
  })

  // Encode the final pixels with sharp.
  const pipeline = sharp(Buffer.from(rendered.rgba), {
    raw: { width: rendered.width, height: rendered.height, channels: 4 }
  })
  const { buf, ext: outExt } = encode(pipeline.withIccProfile('srgb'), opts)
  const encoded = await buf.toBuffer()

  const baseName = path.parse(item.fileName).name
  const outName =
    renderFilename(opts.filenamePattern, {
      name: baseName,
      seq,
      width: rendered.width,
      height: rendered.height
    }) + '.' + outExt
  signal?.throwIfAborted()
  await assertExportDirectory(opts.destDir)
  const temporary = path.join(opts.destDir, `.luxinus-export-${randomUUID()}.${outExt}`)
  try {
    await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 })
    // Metadata failure is a failure, never a silent successful export.
    const et = getExifTool()
    if (opts.exifMode === 'keep') {
      await et.write(temporary, { Orientation: 1, ColorSpace: 1, ExifImageWidth: rendered.width, ExifImageHeight: rendered.height }, ['-tagsFromFile', item.filePath, '-all:all', '--ICC_Profile', '--Orientation', '--ExifImageWidth', '--ExifImageHeight', '-overwrite_original'])
    } else {
      await et.write(temporary, {}, ['-all=', '-overwrite_original'])
    }
    signal?.throwIfAborted()
    await assertExportDirectory(opts.destDir)
    const proposed = path.join(opts.destDir, outName)
    const parsed = path.parse(proposed)
    for (let n = 0; n < 10000; n++) {
      const output = n ? path.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`) : proposed
      try {
        // Hard-link publishes the completed file atomically and cannot overwrite
        // an existing file or symlink, even if another job creates it meanwhile.
        await fs.link(temporary, output)
        return output
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
    }
    throw new Error('같은 이름의 파일이 너무 많습니다. 파일명 규칙을 변경하세요.')
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {})
    await fs.rm(temporary + '_original', { force: true }).catch(() => {})
  }
}

function validateOptions(opts: ExportOptions): void {
  if (!opts || !['jpeg', 'png', 'tiff'].includes(opts.format) || !['keep', 'strip', 'frame'].includes(opts.exifMode) || !['minimal', 'film'].includes(opts.frameStyle) || !Number.isInteger(opts.quality) || opts.quality < 1 || opts.quality > 100 || !Number.isInteger(opts.longEdge) || opts.longEdge < 0 || opts.longEdge > 32768 || typeof opts.filenamePattern !== 'string' || opts.filenamePattern.length > 200 || typeof opts.destDir !== 'string') throw new Error('내보내기 설정이 유효하지 않습니다.')
}
let activeExport: AbortController | null = null
export const isExportRunning = (): boolean => activeExport !== null

function emitProgress(p: ExportProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.exportr.progress, p)
  }
}

export function registerExportHandlers(): void {
  ipcMain.handle(IpcChannels.exportr.pickDir, async (event) => {
    assertTrustedSender(event)
    const res = await dialog.showOpenDialog({
      title: '내보낼 폴더 선택',
      properties: ['openDirectory', 'createDirectory']
    })
    const selected = res.canceled ? null : (res.filePaths[0] ?? null)
    return selected ? await authorizeExportDirectory(selected) : null
  })

  ipcMain.handle(IpcChannels.exportr.cancel, (event) => {
    assertTrustedSender(event)
    if (!activeExport) return false
    activeExport.abort()
    cancelExportRender()
    return true
  })
  ipcMain.handle(
    IpcChannels.exportr.run,
    async (event, items: ExportItem[], opts: ExportOptions) => {
      assertTrustedSender(event)
      if (activeExport) throw new Error('내보내기가 이미 실행 중입니다.')
      const controller = new AbortController()
      activeExport = controller
      try {
      validateOptions(opts)
      await assertExportDirectory(opts.destDir)
      if (!Array.isArray(items) || !items.length || items.length > 10000) throw new Error('내보낼 사진 범위가 유효하지 않습니다.')
      for (const item of items) {
        if (!item || typeof item.fileName !== 'string' || item.fileName.length > 1024) throw new Error('파일명이 유효하지 않습니다.')
        if (item.editState !== null) validateEditState(item.editState)
        if (item.meta !== null && (typeof item.meta !== 'object' || JSON.stringify(item.meta).length > 32000)) throw new Error('메타데이터 범위가 유효하지 않습니다.')
        await assertAuthorizedPhoto(item.filePath)
      }
      const written: string[] = []
      const errors: { file: string; message: string }[] = []
      for (let i = 0; i < items.length; i++) {
        if (controller.signal.aborted) break
        emitProgress({ done: i, total: items.length, current: items[i].fileName })
        try {
          written.push(await exportOne(items[i], opts, i + 1, controller.signal))
        } catch (err) {
          if (!controller.signal.aborted) errors.push({ file: items[i].fileName, message: (err as Error).message })
        }
      }
      emitProgress({ done: written.length + errors.length, total: items.length, current: '' })
      return { written, errors, canceled: controller.signal.aborted }
      } finally { activeExport = null }
    }
  )
}

export async function shutdownExport(): Promise<void> {
  if (exiftool) {
    await exiftool.end().catch(() => {})
    exiftool = null
  }
}
