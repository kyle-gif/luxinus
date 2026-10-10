// Both local CNN runners share one synchronous gate. This includes model loading
// and startup, so requests in the same event-loop turn cannot launch two jobs.
export type HeavyInferenceKind = 'restoration' | 'portrait'
let active: { kind: HeavyInferenceKind; token: symbol } | null = null
export function acquireHeavyInference(kind: HeavyInferenceKind): (() => void) | null {
  if (active) return null
  const token = Symbol(kind)
  active = { kind, token }
  return () => { if (active?.token === token) active = null }
}
