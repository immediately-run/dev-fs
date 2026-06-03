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
  let res = await post(method, query)

  // The host shows a create-or-pick dialog when the slot is unbound. Locally we
  // render a minimal stand-in and translate the choice into create/mount.
  if (method === 'open' && res && res.ok === false && res.code === 'needs-choice') {
    const choice = await pickOrCreate(query.slot || 'default')
    if (!choice) return { ok: false, code: 'cancelled', message: 'cancelled' }
    res = choice.action === 'create'
      ? await post('create', { name: choice.name, slot: query.slot || 'default', bindToApp: true })
      : await post('mount', { spaceId: choice.spaceId, slot: query.slot || 'default' })
  }

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

// --- minimal dev create-or-pick dialog (vanilla DOM) -----------------------

async function pickOrCreate(slot) {
  const listed = await post('list', {})
  const spaces = (listed && listed.ok && Array.isArray(listed.data)) ? listed.data : []

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483647',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(8,9,14,.6)', 'backdrop-filter:blur(3px)',
      'font-family:ui-monospace,SFMono-Regular,Menlo,monospace',
    ].join(';'))

    const panel = document.createElement('div')
    panel.setAttribute('style', [
      'width:min(460px,92vw)', 'background:#13141c', 'color:#ecebf4',
      'border:1px solid #2a2c3a', 'border-radius:12px', 'padding:20px',
      'box-shadow:0 24px 60px rgba(0,0,0,.5)',
    ].join(';'))

    const done = (value) => { overlay.remove(); resolve(value) }

    const title = document.createElement('div')
    title.textContent = 'Open workspace'
    title.setAttribute('style', 'font-size:15px;font-weight:700;margin-bottom:2px')
    const sub = document.createElement('div')
    sub.textContent = `dev-fs · slot "${slot}" is empty — create or pick a space`
    sub.setAttribute('style', 'font-size:11.5px;color:#9a9bb0;margin-bottom:16px')
    panel.append(title, sub)

    // create row
    const row = document.createElement('div')
    row.setAttribute('style', 'display:flex;gap:8px;margin-bottom:14px')
    const input = document.createElement('input')
    input.placeholder = 'new space name'
    input.setAttribute('style', [
      'flex:1', 'background:#0c0d14', 'color:#ecebf4', 'border:1px solid #2a2c3a',
      'border-radius:8px', 'padding:8px 10px', 'font:inherit', 'font-size:13px',
    ].join(';'))
    const createBtn = document.createElement('button')
    createBtn.textContent = 'Create'
    createBtn.setAttribute('style', btnStyle('#c026d3'))
    createBtn.onclick = () => done({ action: 'create', name: input.value.trim() || undefined })
    input.onkeydown = (e) => { if (e.key === 'Enter') createBtn.click() }
    row.append(input, createBtn)
    panel.append(row)

    // existing spaces
    if (spaces.length) {
      const label = document.createElement('div')
      label.textContent = 'or mount existing'
      label.setAttribute('style', 'font-size:11px;color:#9a9bb0;margin:4px 0 8px')
      panel.append(label)
      for (const s of spaces) {
        const item = document.createElement('button')
        item.textContent = `${s.name || s.spaceId}  ·  ${s.spaceId}`
        item.setAttribute('style', [
          'display:block', 'width:100%', 'text-align:left', 'margin-bottom:6px',
          'background:#0c0d14', 'color:#ecebf4', 'border:1px solid #2a2c3a',
          'border-radius:8px', 'padding:8px 10px', 'font:inherit', 'font-size:12.5px', 'cursor:pointer',
        ].join(';'))
        item.onclick = () => done({ action: 'mount', spaceId: s.spaceId })
        panel.append(item)
      }
    }

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.setAttribute('style', btnStyle('transparent') + ';margin-top:8px;color:#9a9bb0')
    cancel.onclick = () => done(null)
    panel.append(cancel)

    overlay.append(panel)
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) done(null) })
    document.body.append(overlay)
    input.focus()
  })
}

function btnStyle(bg) {
  return [
    `background:${bg}`, 'color:#fff', 'border:1px solid #2a2c3a', 'border-radius:8px',
    'padding:8px 14px', 'font:inherit', 'font-size:13px', 'font-weight:600', 'cursor:pointer',
  ].join(';')
}
