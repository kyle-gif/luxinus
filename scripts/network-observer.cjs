// Harness-only observation. Forward every call unchanged; never deny, redirect,
// or synthesize a response. This observes JS APIs, not native-code packets.
function observeNodeNetwork(record) {
  const restore = []
  const wrap = (object, key, kind, shouldRecord = () => true) => {
    const original = object[key]
    object[key] = function (...args) {
      if (shouldRecord(args)) record({ api: kind })
      return Reflect.apply(original, this, args)
    }
    restore.push(() => { object[key] = original })
  }
  wrap(require('node:net').Socket.prototype, 'connect', 'tcp', args => {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    return typeof first === 'number' || !!(first && typeof first === 'object' && first.port !== undefined)
  })
  wrap(require('node:tls'), 'connect', 'tls')
  wrap(require('node:dgram').Socket.prototype, 'send', 'udp')
  wrap(globalThis, 'fetch', 'fetch')
  return () => { for (const reset of restore.reverse()) reset() }
}
module.exports = { observeNodeNetwork }
