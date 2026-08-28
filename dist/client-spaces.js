// dev-fs spaces substrate — served in <head> during `vite dev` by
// vite-plugin-dev-fs (NOT bundled into production).
//
// On immediately.run the host injects a runtime global the SDK reaches for:
//   module.evaluation.module.bundler.mounts       (a MountService)
//   module.evaluation.module.bundler.messageBus   (protocolRequest, ...)
// There is no host under `vite dev`, so we install the same global here, backed
// by the dev server: the `spaces` and `settings` protocols over POST
// /__devfs/spaces, and the mount-set event source over SSE /__devfs/spaces/events.
// The result is that the UNMODIFIED @immediately-run/sdk works locally exactly as
// it does in prod (openSettings/mountSpace/createSpace/requestMount).
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
  const query = (params && params[0]) || {}
  if (protocol === 'spaces') {
    const res = await post(method, query)
    if (res && res.ok) addMount(res.data)
    return res
  }
  // Per-user settings space: `open`/`openOf` resolve a mount (surface it like a
  // space); `importFromParent` returns a plain { copied } result (no mount).
  if (protocol === 'settings') {
    const res = await post('settings:' + method, query)
    if (res && res.ok && method !== 'importFromParent') addMount(res.data)
    return res
  }
  return { ok: false, code: 'unknown', message: `dev-fs: protocol "${protocol}" not supported locally` }
}

const messageBus = {
  protocolRequest,
  sendMessage() {},
  // The SDK's transport contract (`HostTransport.onMessage`) returns a
  // DISPOSABLE — `{ dispose() }` — not a plain function: `addListener` wraps it
  // as `() => disposable.dispose()`, so returning a bare function made every
  // unsubscribe throw under vite dev. No host messages are ever pushed locally,
  // so subscribing is inert; disposing must simply be safe.
  onMessage() { return { dispose() {} } },
}

// --- local `fs` bridge at the SDK's sandbox-fs discovery global -------------
//
// The SDK discovers the sandbox ZenFS at `globalThis.__sandpackSharedFs`
// (`sandboxFs()` in @immediately-run/sdk/fs — behind `openFs`, `readBlob`,
// `readObjectUrl`, `useObjectUrl`, `MountImage`). On immediately.run the
// sandbox publishes it; under `vite dev` nobody did, so those APIs failed
// `unavailable` even though this plugin bridges `fs`. Publish the SAME bridge
// here, at the SAME global, so the SDK's existing discovery path just works —
// no SDK special-casing, no app changes.
//
// Published SYNCHRONOUSLY (the global must exist before app code boots and
// calls `sandboxFs()`), forwarding each call to the real shim, which loads on
// first use from /__devfs/client-fs.js — the same file the `fs` import
// resolves to. That import is a second module instance, which is fine: the
// shim is stateless per call (every op is a fetch to the dev server).
let fsShim = null
const loadFsShim = () => (fsShim ||= import('/__devfs/client-fs.js').then((m) => m.default))
const fsForward = (name) => (...args) => loadFsShim().then((fs) => fs.promises[name](...args))
const sharedFs = {
  promises: {
    readFile: fsForward('readFile'),
    writeFile: fsForward('writeFile'),
    appendFile: fsForward('appendFile'),
    readdir: fsForward('readdir'),
    mkdir: fsForward('mkdir'),
    rm: fsForward('rm'),
    rmdir: fsForward('rmdir'),
    unlink: fsForward('unlink'),
    stat: fsForward('stat'),
    lstat: fsForward('lstat'),
    access: fsForward('access'),
    rename: fsForward('rename'),
    copyFile: fsForward('copyFile'),
    realpath: fsForward('realpath'),
    // `watch` hands back an async iterable synchronously; the shim resolves
    // inside the generator, before the first event is pulled.
    async *watch(...args) {
      const shim = await loadFsShim()
      yield* shim.promises.watch(...args)
    },
  },
}

// --- install the runtime globals (merge; never clobber) --------------------

const g = globalThis
if (!g.__sandpackSharedFs) g.__sandpackSharedFs = sharedFs
g.module = g.module || {}
g.module.evaluation = g.module.evaluation || {}
g.module.evaluation.module = g.module.evaluation.module || {}
g.module.evaluation.module.bundler = Object.assign(
  g.module.evaluation.module.bundler || {},
  { mounts: mountService, messageBus },
)
