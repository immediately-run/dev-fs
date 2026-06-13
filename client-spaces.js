// dev-fs spaces substrate — served in <head> during `vite dev` by
// vite-plugin-dev-fs (NOT bundled into production).
//
// On immediately.run the host injects a runtime global the SDK reaches for:
//   module.evaluation.module.bundler.mounts       (a MountService)
//   module.evaluation.module.bundler.messageBus   (protocolRequest, ...)
// There is no host under `vite dev`, so we install the same global here, backed
// by the dev server: the `spaces` protocol over POST /__devfs/spaces, and the
// mount-set event source over SSE /__devfs/spaces/events. The result is that the
// UNMODIFIED @immediately-run/sdk works locally exactly as it does in prod.
//
// Plain JS on purpose — it is not type-checked or linted, imports nothing, and
// must run before app code (hence head-prepend).

const SPACES = '/__devfs/spaces'

// --- mount set + listeners (the "mounts" MountService) ---------------------

let mounts = []
const listeners = new Set()

function emit() {
  const snapshot = mounts.slice()
  for (const listener of listeners) listener(snapshot)
}

const mountService = {
  getMounts: () => mounts.slice(),
  // Contract: replay the current mounts to a new listener, then notify on every
  // change. The replay is deferred to a microtask (not called synchronously
  // inside onChange) so callers that reference their own unsubscribe handle from
  // within the listener — e.g. the SDK's waitForMount — don't hit a temporal
  // dead zone when a matching mount is already present at subscription time.
  onChange: (listener) => {
    listeners.add(listener)
    Promise.resolve().then(() => { if (listeners.has(listener)) listener(mounts.slice()) })
    return { dispose: () => listeners.delete(listener) }
  },
}

function replaceMounts(list) {
  mounts = Array.isArray(list) ? list : []
  emit()
}

// Optimistic add so `awaitReady`/`waitForMount` resolve without waiting on SSE.
function addMount(descriptor) {
  if (descriptor && descriptor.id && !mounts.some((m) => m.id === descriptor.id)) {
    mounts = [...mounts, descriptor]
    emit()
  }
}

// --- event source: server pushes the authoritative mount list --------------

try {
  const es = new EventSource(`${SPACES}/events`)
  es.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data)
      if (data && Array.isArray(data.mounts)) replaceMounts(data.mounts)
    } catch {
      /* ignore malformed frames */
    }
  }
  // EventSource auto-reconnects on transient errors; nothing else to do.
} catch {
  /* EventSource unavailable — getMounts() simply stays empty */
}

// --- the `spaces` protocol (messageBus.protocolRequest) --------------------

async function post(method, query) {
  try {
    const res = await fetch(SPACES, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method, query: query || {} }),
    })
    if (!res.ok) return { ok: false, code: 'unknown', message: `HTTP ${res.status}` }
    return await res.json()
  } catch (err) {
    return { ok: false, code: 'unknown', message: String((err && err.message) || err) }
  }
}

async function protocolRequest(protocol, method, params) {
  if (protocol !== 'spaces') {
    return { ok: false, code: 'unknown', message: `dev-fs: protocol "${protocol}" not supported locally` }
  }
  const query = (params && params[0]) || {}
  const res = await post(method, query)
  if (res && res.ok) addMount(res.data)
  return res
}

const messageBus = {
  protocolRequest,
  sendMessage() {},
  onMessage() { return () => {} },
}

// --- install the runtime global (merge; never clobber) ---------------------

const g = globalThis
g.module = g.module || {}
g.module.evaluation = g.module.evaluation || {}
g.module.evaluation.module = g.module.evaluation.module || {}
g.module.evaluation.module.bundler = Object.assign(
  g.module.evaluation.module.bundler || {},
  { mounts: mountService, messageBus },
)
