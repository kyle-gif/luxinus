import { BrowserWindow, dialog, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
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
import { renderExportViaWindow } from './decode-window'

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

export async function exportOne(item: ExportItem, opts: ExportOptions, seq: number): Promise<string> {
  const ext = path.extname(item.filePath).toLowerCase()
  const isRaw = isRawExt(ext)

  // Prepare source bytes for the render window (pre-convert TIFF/HEIF).
  let bytes: Uint8Array
  if (!isRaw && NEEDS_PRECONVERT.has(ext)) {
    bytes = new Uint8Array(await sharp(item.filePath).png().toBuffer())
  } else {
    bytes = new Uint8Array(await fs.readFile(item.filePath))
  }

  const frame =
    opts.exifMode === 'frame'
      ? { style: opts.frameStyle, fields: frameFields(item.meta, item.fileName) }
      : null

  // Active photo carries its live edit buffer; others load their sidecar.
  const editState = item.editState ?? (await loadEdits(item.filePath)) ?? defaultEditState()

  // Full-res edit render (+ optional frame) in the hidden WebGL window.
  const rendered = await renderExportViaWindow({
    ext,
    isRaw,
    bytes,
    editState,
    longEdge: opts.longEdge,
    frame
  })

  // Encode the final pixels with sharp.
  const pipeline = sharp(Buffer.from(rendered.rgba), {
    raw: { width: rendered.width, height: rendered.height, channels: 4 }
  })
  const { buf, ext: outExt } = encode(pipeline, opts)
  const encoded = await buf.toBuffer()

  const baseName = path.parse(item.fileName).name
  const outName =
    renderFilename(opts.filenamePattern, {
      name: baseName,
      seq,
      width: rendered.width,
      height: rendered.height
    }) + '.' + outExt
  const outPath = await uniquePath(path.join(opts.destDir, outName))
  await fs.writeFile(outPath, encoded)

  // EXIF policy. Pixels are freshly encoded, so:
  //   keep  → copy all tags from the original onto the new file
  //   strip → ensure no metadata (also removes GPS/XMP)
  //   frame → strip (shooting info is burned into the frame)
  try {
    const et = getExifTool()
    if (opts.exifMode === 'keep') {
      await et.write(outPath, {}, ['-tagsFromFile', item.filePath, '-all:all', '-overwrite_original'])
    } else {
      await et.write(outPath, {}, ['-all=', '-overwrite_original'])
    }
    // exiftool may leave a *_original backup depending on args; clean it.
    await fs.rm(outPath + '_original', { force: true }).catch(() => {})
  } catch (err) {
    console.warn('[export] exif step failed (file still written):', (err as Error).message)
  }

  return outPath
}

async function uniquePath(p: string): Promise<string> {
  let candidate = p
  const parsed = path.parse(p)
  let n = 1
  // Don't overwrite existing exports; suffix -1, -2, …
  while (await exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`)
    n++
  }
  return candidate
}
async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

function emitProgress(p: ExportProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannels.exportr.progress, p)
  }
}

export function registerExportHandlers(): void {
  ipcMain.handle(IpcChannels.exportr.pickDir, async () => {
    const res = await dialog.showOpenDialog({
      title: 'Choose export folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  ipcMain.handle(
    IpcChannels.exportr.run,
    async (_e, items: ExportItem[], opts: ExportOptions) => {
      const written: string[] = []
      const errors: { file: string; message: string }[] = []
      for (let i = 0; i < items.length; i++) {
        emitProgress({ done: i, total: items.length, current: items[i].fileName })
        try {
          written.push(await exportOne(items[i], opts, i + 1))
        } catch (err) {
          errors.push({ file: items[i].fileName, message: (err as Error).message })
        }
      }
      emitProgress({ done: items.length, total: items.length, current: '' })
      return { written, errors }
    }
  )
}

export async function shutdownExport(): Promise<void> {
  if (exiftool) {
    await exiftool.end().catch(() => {})
    exiftool = null
  }
}
