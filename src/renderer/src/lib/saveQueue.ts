/** Serial per-photo autosave. Failed values remain available for explicit retry. */
export class SaveQueue<T> {
  private pending = new Map<string, { value: T; revision: number; error?: string }>()
  private running = new Map<string, Promise<boolean>>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private revision = 0

  constructor(
    private write: (path: string, value: T) => Promise<boolean>,
    private changed: (status: 'idle' | 'pending' | 'saving' | 'saved' | 'error', error: string | null) => void,
    private delay = 450
  ) {}

  get(path: string): T | undefined { return this.pending.get(path)?.value }
  get dirty(): boolean { return this.pending.size > 0 || this.running.size > 0 }

  async discard(path: string): Promise<void> {
    const timer = this.timers.get(path)
    if (timer) clearTimeout(timer)
    this.timers.delete(path)
    await this.running.get(path)
    this.pending.delete(path)
    this.report()
  }

  schedule(path: string, value: T): void {
    this.pending.set(path, { value, revision: ++this.revision })
    const timer = this.timers.get(path)
    if (timer) clearTimeout(timer)
    this.timers.set(path, setTimeout(() => {
      this.timers.delete(path)
      void this.save(path)
    }, this.delay))
    this.report()
  }

  private report(): void {
    const failure = [...this.pending.values()].find((v) => v.error)
    this.changed(failure ? 'error' : this.running.size ? 'saving' : this.pending.size ? 'pending' : this.revision ? 'saved' : 'idle', failure?.error ?? null)
  }

  private async save(path: string): Promise<boolean> {
    const active = this.running.get(path)
    if (active) {
      const ok = await active
      return ok && this.pending.has(path) ? this.save(path) : ok
    }
    const entry = this.pending.get(path)
    if (!entry) return true
    const operation = Promise.resolve().then(async () => {
      try {
        if (!(await this.write(path, entry.value))) throw new Error('편집 파일을 저장하지 못했습니다.')
        if (this.pending.get(path)?.revision === entry.revision) this.pending.delete(path)
        return true
      } catch (error) {
        const current = this.pending.get(path)
        if (current) current.error = `${path.split(/[\\/]/).pop()}: ${(error as Error).message}`
        return false
      }
    })
    this.running.set(path, operation)
    this.report()
    const ok = await operation
    this.running.delete(path)
    this.report()
    return ok
  }

  async flush(): Promise<boolean> {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    const results = await Promise.all([...new Set([...this.pending.keys(), ...this.running.keys()])].map((path) => this.save(path)))
    if (results.some((ok) => !ok)) return false
    // Edits can arrive while an older value is being written.
    return this.pending.size ? this.flush() : true
  }
}
