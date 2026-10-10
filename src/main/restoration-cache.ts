import { app, ipcMain } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IpcChannels } from '../shared/ipc-channels'
import type { DenoiseResult, RestorationPreviewRequest } from '../shared/ai'
import { assertTrustedSender } from './file-policy'
import { getRestorationGeneration, getRestorationModelFingerprint, runRestoration } from './onnx'
import { RestorationCacheStore } from './restoration-cache-store'

interface CacheRuntime {
  fingerprint(): Promise<string | null>
  generation(): number
  infer(input: { rgba: Uint8Array; width: number; height: number; strength: number }): Promise<DenoiseResult>
}
let active = 0
export const isRestorationCacheBusy = (): boolean => active > 0

/** The result is persisted in main before it is acknowledged to the renderer. */
export async function restoreCachedPreview(cache: RestorationCacheStore, input: RestorationPreviewRequest, runtime: CacheRuntime): Promise<DenoiseResult> {
  const generation = runtime.generation()
  try {
    if (!input || typeof input.requestId !== 'string' || !/^[a-zA-Z0-9-]{8,80}$/.test(input.requestId)) throw new Error('복원 요청 식별자가 유효하지 않습니다.')
    const modelFingerprint = await runtime.fingerprint()
    if (!modelFingerprint) return { ok: false, message: '복원 모델이 설치되지 않았습니다.' }
    const ticket = await cache.prepare(input, modelFingerprint, () => generation !== runtime.generation())
    let cached: Uint8Array | null = null
    let readWarning: string | undefined
    try { cached = await cache.read(ticket) } catch (error) { readWarning = (error as Error).message }
    await ticket.assertCurrent()
    if (cached) return { ok: true, rgba: cached, width: input.width, height: input.height, modelFingerprint, cache: { status: 'hit' } }
    const result = await runtime.infer({ rgba: input.rgba, width: input.width, height: input.height, strength: 100 })
    await ticket.assertCurrent()
    if (!result.ok) return result
    if (!(result.rgba instanceof Uint8Array) || result.width !== input.width || result.height !== input.height ||
        result.rgba.length !== input.width * input.height * 4 || result.modelFingerprint !== modelFingerprint) {
      throw new Error('복원 결과의 크기 또는 모델 식별자가 입력과 일치하지 않아 저장하지 않았습니다.')
    }
    try {
      await cache.write(ticket, result.rgba)
      await ticket.assertCurrent()
      return { ...result, cache: { status: 'stored', ...(readWarning ? { message: '이전 캐시를 읽지 못해 새 복원 결과로 저장했습니다.' } : {}) } }
    } catch (error) {
      // A source change or cancellation invalidates the image as well. A disk
      // write error leaves the computed pixels available and clearly unsaved.
      await ticket.assertCurrent()
      return { ...result, cache: { status: 'error', message: `복원 결과를 디스크에 저장하지 못했습니다: ${(error as Error).message}` } }
    }
  } catch (error) { return { ok: false, message: (error as Error).message } }
}

export function registerRestorationCacheHandlers(): void {
  ipcMain.handle(IpcChannels.ai.restorePreview, async (event, input: RestorationPreviewRequest) => {
    assertTrustedSender(event)
    if (active) return { ok: false, message: '다른 복원 결과를 읽거나 저장하고 있습니다. 완료 후 다시 시도해 주세요.' }
    active++
    try {
      const root = await fs.realpath(app.getPath('userData'))
      const cache = new RestorationCacheStore(join(root, 'restoration-cache'))
      return await restoreCachedPreview(cache, input, { fingerprint: getRestorationModelFingerprint, generation: getRestorationGeneration, infer: runRestoration })
    } finally { active-- }
  })
}
