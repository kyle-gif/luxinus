/** Each process launch owns its readiness timer; settling never affects a later
 * launch. The owner captures its process in onTimeout, not a mutable global. */
export function workerReadiness(timeoutMs: number, onTimeout: () => void): {
  ready: Promise<void>
  settle: (error?: Error) => void
} {
  let settle!: (error?: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settle(new Error('모델 프로세스가 제한 시간 안에 준비되지 않았습니다.'))
      onTimeout()
    }, timeoutMs)
    settle = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
  })
  return { ready, settle }
}
