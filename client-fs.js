// Browser shim for `fs`, served in place of the Node builtin during `vite dev`
// by vite-plugin-dev-fs. Mirrors the async-only ZenFS surface that
// immediately.run exposes to apps (`fs.promises.*` + callback style + `watch`),
// but backs each call with the dev server: request/response ops over fetch,
// `watch` over a Server-Sent Events stream. Plain JS on purpose — it is not
// type-checked or linted, and it must not import anything Node-y.

const ENDPOINT = '/__devfs'

async function rpc(op, args) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, args }),
  })
  if (!res.ok) throw new Error(`[dev-fs] ${op} failed: HTTP ${res.status}`)
  const payload = await res.json()
  if (!payload.ok) throw makeError(payload.error)
  return decode(payload.value)
}

function makeError(e) {
  const err = new Error((e && e.message) || 'fs error')
  if (e) {
    if (e.code) err.code = e.code
    if (e.errno != null) err.errno = e.errno
    if (e.syscall) err.syscall = e.syscall
    if (e.path) err.path = e.path
  }
  return err
}

// --- value (de)coding ------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(bytes) {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

function encodeData(data) {
  if (typeof data === 'string') return { t: 's', v: data }
  if (data instanceof Uint8Array) return { t: 'b', v: bytesToB64(data) }
  if (data instanceof ArrayBuffer) return { t: 'b', v: bytesToB64(new Uint8Array(data)) }
  if (Array.isArray(data)) return { t: 'b', v: bytesToB64(Uint8Array.from(data)) }
  throw new Error('[dev-fs] unsupported data type for write (use string or Uint8Array)')
}

function makeStats(s) {
  return {
    ...s,
    atime: new Date(s.atimeMs),
    mtime: new Date(s.mtimeMs),
    ctime: new Date(s.ctimeMs),
    birthtime: new Date(s.birthtimeMs),
    isFile: () => s.isFile,
    isDirectory: () => s.isDirectory,
    isSymbolicLink: () => s.isSymbolicLink,
    isBlockDevice: () => !!s.isBlockDevice,
    isCharacterDevice: () => !!s.isCharacterDevice,
    isFIFO: () => !!s.isFIFO,
    isSocket: () => !!s.isSocket,
  }
}

function decode(v) {
  if (!v) return undefined
  switch (v.t) {
    case 'u': return undefined
    case 's': return v.v
    case 'b': return b64ToBytes(v.v)
    case 'j': return v.v
    case 'stats': return makeStats(v.v)
    default: return undefined
  }
}

// --- watch (Server-Sent Events → AsyncIterable) ----------------------------

function watch(p, options = {}) {
  const recursive = !!options.recursive
  const url = `${ENDPOINT}/watch?path=${encodeURIComponent(p)}&recursive=${recursive}`
  const es = new EventSource(url)

  const queue = []
  let resolveNext = null
  let done = false

  const close = () => {
    if (done) return
    done = true
    es.close()
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r({ value: undefined, done: true })
    }
  }

  es.onmessage = (ev) => {
    const data = JSON.parse(ev.data)
    if (resolveNext) {
      const r = resolveNext
      resolveNext = null
      r({ value: data, done: false })
    } else {
      queue.push(data)
    }
  }
  // EventSource auto-reconnects on transient errors; only honor explicit close.

  if (options.signal) {
    if (options.signal.aborted) close()
    else options.signal.addEventListener('abort', close, { once: true })
  }

  return {
    [Symbol.asyncIterator]() { return this },
    next() {
      if (queue.length) return Promise.resolve({ value: queue.shift(), done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => { resolveNext = resolve })
    },
    return() { close(); return Promise.resolve({ value: undefined, done: true }) },
    throw() { close(); return Promise.resolve({ value: undefined, done: true }) },
  }
}

// --- public surface --------------------------------------------------------

const promises = {
  readFile: (p, options) => rpc('readFile', [p, options]),
  writeFile: (p, data, options) => rpc('writeFile', [p, encodeData(data), options]),
  appendFile: (p, data, options) => rpc('appendFile', [p, encodeData(data), options]),
  readdir: async (p, options) => {
    const r = await rpc('readdir', [p, options])
    if (options && typeof options === 'object' && options.withFileTypes) {
      return r.map((e) => ({
        name: e.name,
        isFile: () => e.file,
        isDirectory: () => e.dir,
        isSymbolicLink: () => e.symlink,
        isBlockDevice: () => false,
        isCharacterDevice: () => false,
        isFIFO: () => false,
        isSocket: () => false,
      }))
    }
    return r
  },
  mkdir: (p, options) => rpc('mkdir', [p, options]),
  rm: (p, options) => rpc('rm', [p, options]),
  rmdir: (p, options) => rpc('rmdir', [p, options]),
  unlink: (p) => rpc('unlink', [p]),
  stat: (p) => rpc('stat', [p]),
  lstat: (p) => rpc('lstat', [p]),
  access: (p, mode) => rpc('access', [p, mode]),
  rename: (a, b) => rpc('rename', [a, b]),
  copyFile: (a, b, mode) => rpc('copyFile', [a, b, mode]),
  realpath: (p) => rpc('realpath', [p]),
  watch,
}

// Turn a promise-returning fn into Node's `(...args, callback)` form.
function cbify(fn) {
  return (...args) => {
    const cb = args.pop()
    fn(...args).then((res) => cb(null, res), (err) => cb(err))
  }
}

function watchCb(p, options, listener) {
  if (typeof options === 'function') {
    listener = options
    options = {}
  }
  const iter = watch(p, options)
  ;(async () => {
    try {
      for await (const ev of iter) {
        if (listener) listener(ev.eventType, ev.filename)
      }
    } catch {
      /* closed */
    }
  })()
  return { close: () => iter.return() }
}

const constants = { F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4, COPYFILE_EXCL: 1 }

const readFile = cbify(promises.readFile)
const writeFile = cbify(promises.writeFile)
const appendFile = cbify(promises.appendFile)
const readdir = cbify(promises.readdir)
const mkdir = cbify(promises.mkdir)
const rm = cbify(promises.rm)
const rmdir = cbify(promises.rmdir)
const unlink = cbify(promises.unlink)
const stat = cbify(promises.stat)
const lstat = cbify(promises.lstat)
const access = cbify(promises.access)
const rename = cbify(promises.rename)
const copyFile = cbify(promises.copyFile)
const realpath = cbify(promises.realpath)

const fs = {
  promises,
  constants,
  readFile, writeFile, appendFile, readdir, mkdir, rm, rmdir, unlink,
  stat, lstat, access, rename, copyFile, realpath,
  watch: watchCb,
}

export default fs
export {
  promises, constants,
  readFile, writeFile, appendFile, readdir, mkdir, rm, rmdir, unlink,
  stat, lstat, access, rename, copyFile, realpath,
}
// `watch` named export = Node's callback form (the async-iterable form lives on
// `promises.watch`).
export { watchCb as watch }
