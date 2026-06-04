// vite-plugin-dev-fs — makes `import ... from 'fs'` work during local `vite dev`.
//
// On immediately.run the app's `fs` import resolves to a ZenFS bound context
// (async-only: `fs.promises.*` + callback style) rooted at `/`, with the repo
// mounted at /app over a MessagePort to the parent window and pwd = /app.
// Locally there is no such bridge, so this plugin recreates the same contract
// (including the /app layout — see "path scoping" below) over the dev server:
//
//   app code  →  client-fs.js shim  →  HTTP /__devfs  →  node:fs (this file)
//                                    →  SSE  /__devfs/watch  ←  fs.watch
//
// Request/response ops go over plain fetch; `watch` is a one-way Server-Sent
// Events stream (auto-reconnecting, no extra deps). Dev only: `apply: 'serve'`
// keeps it out of `vite build`, and on immediately.run the real ZenFS is used.
import type { Plugin } from 'vite'
import { watch as fsWatch } from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SHIM = path.join(here, 'client-fs.js')
const CLIENT_SPACES = path.join(here, 'client-spaces.js')

export interface DevFsOptions {
  /** Globs the vite watcher should ignore, so app writes don't trigger HMR
   *  reloads. The SSE watch uses its own fs.watch, so it still sees changes. */
  ignore?: string[]
}

export function devFs(options: DevFsOptions = {}): Plugin {
  // `.devfs` holds the scratch root (virtual `/` outside /app) and the spaces
  // registry — app writes there must not bounce the vite watcher.
  const ignore = options.ignore ?? ['**/.devfs/**', '**/devfs-playground/**']
  return {
    name: 'immediately-dev-fs',
    apply: 'serve',
    enforce: 'pre',
    config() {
      return { server: { watch: { ignored: ignore } } }
    },
    resolveId(id) {
      if (id === 'fs' || id === 'node:fs') return CLIENT_SHIM
      return null
    },
    // Inject the spaces substrate before app code so the (unmodified) SDK finds
    // its runtime global. Serve-only, so it never ships to `vite build`.
    transformIndexHtml() {
      return [{
        tag: 'script',
        attrs: { type: 'module', src: '/__devfs/spaces/client.js' },
        injectTo: 'head-prepend',
      }]
    },
    configureServer(server) {
      const root = server.config.root
      // Materialize the scratch root so virtual `/` stats/watches from the
      // first request (readdir of `/` tolerates its absence regardless).
      void fsp.mkdir(scratchDir(root), { recursive: true }).catch(() => {})
      const spaces = createSpaces(root)
      // More specific routes first: each fully handles its request (never
      // next()), so the generic /__devfs handler never sees their traffic.
      server.middlewares.use('/__devfs/spaces/events', spaces.events)
      server.middlewares.use('/__devfs/spaces/client.js', spaces.client)
      server.middlewares.use('/__devfs/spaces', spaces.rpc)
      server.middlewares.use('/__devfs/watch', watchHandler(root))
      server.middlewares.use('/__devfs', rpcHandler(root))
    },
  }
}

// --- path scoping ----------------------------------------------------------
//
// The sandbox filesystem layout on immediately.run: the repo is mounted at
// /app, and the rest of `/` is scratch space (plus dynamic mounts like
// /spaces/{id}). Dev mirrors that layout, chrooted to the project directory:
//
//   virtual /app/...   →  <project>/...              (the repo itself)
//   virtual /<else>    →  <project>/.devfs/root/...  (scratch)
//
// Relative paths resolve against /app, matching the sandbox's pwd.

/** The repo's mount point in the sandbox filesystem. */
const APP_ROOT = '/app'

/** On-disk home of the virtual root outside /app — scratch space, kept inside
 *  the project so dev-fs never touches anything beyond it. */
function scratchDir(root: string): string {
  return path.join(root, '.devfs', 'root')
}

function fsError(code: string, message: string, p?: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException
  e.code = code
  if (p) e.path = p
  return e
}

/** Normalize an app path to a clean absolute virtual path. Relative paths
 *  resolve against /app (the sandbox's pwd). `..` is collapsed here, in
 *  virtual space, so `/spaces/../app/x` resolves like it would in prod and a
 *  leading `..` clamps at `/` instead of escaping a disk base. */
function virtualPath(p: unknown): string {
  if (typeof p !== 'string') throw fsError('EINVAL', 'path must be a string')
  const norm = path.posix.normalize(p.startsWith('/') ? p : `${APP_ROOT}/${p}`)
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm
}

/** Map an app path to a real disk path: `/app/...` lands in the project root
 *  (the repo, as in prod), everything else in the scratch dir. The escape
 *  check is defense in depth — `..` is already collapsed by virtualPath; this
 *  catches platform oddities like `\` separators on Windows. */
function resolveSafe(root: string, p: unknown): string {
  const v = virtualPath(p)
  const inApp = v === APP_ROOT || v.startsWith(APP_ROOT + '/')
  // `.devfs` is this plugin's own on-disk state, which the chroot forces inside
  // the project dir — but prod's /app has no such entry. Reaching it through
  // /app would alias the scratch tree (a recursive copy of /app could even
  // copy scratch into itself), so it's reserved: hidden from /app listings
  // (see readdir) and rejected here.
  if (v === `${APP_ROOT}/.devfs` || v.startsWith(`${APP_ROOT}/.devfs/`)) {
    throw fsError('EACCES', `path is reserved by dev-fs: ${v}`, v)
  }
  const base = inApp ? root : scratchDir(root)
  const rel = (inApp ? v.slice(APP_ROOT.length) : v).replace(/^\/+/, '')
  const abs = path.resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw fsError('EACCES', `path escapes project root: ${v}`, v)
  }
  return abs
}

/** Inverse of resolveSafe: a real disk path back to a virtual path. Scratch is
 *  checked first since it lives inside the project root. */
function toAppPath(root: string, abs: string): string {
  for (const [base, prefix] of [[scratchDir(root), ''], [root, APP_ROOT]] as const) {
    const rel = path.relative(base, abs)
    if (rel === '') return prefix || '/'
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return `${prefix}/${rel.split(path.sep).join('/')}`
    }
  }
  return APP_ROOT // unreachable for paths produced by resolveSafe
}

// --- request/response ops --------------------------------------------------

type Wire =
  | { t: 'u' }
  | { t: 's'; v: string }
  | { t: 'b'; v: string }
  | { t: 'j'; v: unknown }
  | { t: 'stats'; v: Record<string, unknown> }

function decodeData(wire: unknown): string | Buffer {
  if (wire && typeof wire === 'object' && 't' in wire) {
    const w = wire as { t: string; v: string }
    if (w.t === 's') return w.v
    if (w.t === 'b') return Buffer.from(w.v, 'base64')
  }
  throw fsError('EINVAL', 'unsupported write payload')
}

function encodeStats(s: import('node:fs').Stats): Wire {
  return {
    t: 'stats',
    v: {
      size: s.size, mode: s.mode, uid: s.uid, gid: s.gid,
      dev: s.dev, ino: s.ino, nlink: s.nlink, rdev: s.rdev,
      blksize: s.blksize, blocks: s.blocks,
      atimeMs: s.atimeMs, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs,
      isFile: s.isFile(), isDirectory: s.isDirectory(), isSymbolicLink: s.isSymbolicLink(),
      isBlockDevice: s.isBlockDevice(), isCharacterDevice: s.isCharacterDevice(),
      isFIFO: s.isFIFO(), isSocket: s.isSocket(),
    },
  }
}

async function handleOp(root: string, op: string, args: unknown[]): Promise<Wire> {
  const p0 = () => resolveSafe(root, args[0])
  switch (op) {
    case 'readFile': {
      const options = args[1]
      const enc = typeof options === 'string' ? options
        : (options as { encoding?: string } | undefined)?.encoding
      if (enc) return { t: 's', v: await fsp.readFile(p0(), enc as BufferEncoding) }
      return { t: 'b', v: (await fsp.readFile(p0())).toString('base64') }
    }
    case 'writeFile':
      await fsp.writeFile(p0(), decodeData(args[1]), normOptions(args[2]))
      return { t: 'u' }
    case 'appendFile':
      await fsp.appendFile(p0(), decodeData(args[1]), normOptions(args[2]))
      return { t: 'u' }
    case 'readdir': {
      const options = args[1] as { withFileTypes?: boolean } | undefined
      // The virtual root lists the scratch dir plus a synthesized `app` entry —
      // the repo mount point, just as the sandbox shows it. Scratch may not
      // exist yet on a fresh project; treat that as empty rather than ENOENT.
      // `/app` hides `.devfs` (reserved — see resolveSafe).
      const v = virtualPath(args[0])
      const isRoot = v === '/'
      const hidden = isRoot ? 'app' : v === APP_ROOT ? '.devfs' : null
      if (options?.withFileTypes) {
        let ents: import('node:fs').Dirent[] = []
        try {
          ents = await fsp.readdir(p0(), { withFileTypes: true })
        } catch (err) {
          if (!isRoot || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        }
        // A stray on-disk `app` in scratch is unreachable through the virtual
        // tree (that prefix always maps to the repo) — drop it over duplicating.
        const list = ents
          .filter((e) => e.name !== hidden)
          .map((e) => ({
            name: e.name, dir: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink(),
          }))
        if (isRoot) {
          list.unshift({ name: 'app', dir: true, file: false, symlink: false })
        }
        return { t: 'j', v: list }
      }
      let names: string[] = []
      try {
        names = await fsp.readdir(p0())
      } catch (err) {
        if (!isRoot || (err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      names = names.filter((n) => n !== hidden)
      return { t: 'j', v: isRoot ? ['app', ...names] : names }
    }
    case 'mkdir': {
      const r = await fsp.mkdir(p0(), args[1] as Parameters<typeof fsp.mkdir>[1])
      return typeof r === 'string' ? { t: 's', v: toAppPath(root, r) } : { t: 'u' }
    }
    case 'rm':
      await fsp.rm(p0(), args[1] as Parameters<typeof fsp.rm>[1])
      return { t: 'u' }
    case 'rmdir':
      await fsp.rmdir(p0(), args[1] as Parameters<typeof fsp.rmdir>[1])
      return { t: 'u' }
    case 'unlink':
      await fsp.unlink(p0())
      return { t: 'u' }
    case 'stat':
      return encodeStats(await fsp.stat(p0()))
    case 'lstat':
      return encodeStats(await fsp.lstat(p0()))
    case 'access':
      await fsp.access(p0(), args[1] as number | undefined)
      return { t: 'u' }
    case 'rename':
      await fsp.rename(p0(), resolveSafe(root, args[1]))
      return { t: 'u' }
    case 'copyFile':
      await fsp.copyFile(p0(), resolveSafe(root, args[1]), args[2] as number | undefined)
      return { t: 'u' }
    case 'realpath':
      return { t: 's', v: toAppPath(root, await fsp.realpath(p0())) }
    default:
      throw fsError('ENOSYS', `unsupported fs op: ${op}`)
  }
}

function normOptions(o: unknown): { encoding?: BufferEncoding } | BufferEncoding | undefined {
  if (typeof o === 'string') return o as BufferEncoding
  if (o && typeof o === 'object') return o as { encoding?: BufferEncoding }
  return undefined
}

function rpcHandler(root: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('error', () => sendJson(res, { ok: false, error: { message: 'request error' } }))
    req.on('end', async () => {
      try {
        const { op, args } = JSON.parse(body) as { op: string; args: unknown[] }
        const value = await handleOp(root, op, args ?? [])
        sendJson(res, { ok: true, value })
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        sendJson(res, { ok: false, error: {
          message: e.message, code: e.code, errno: e.errno, syscall: e.syscall, path: e.path,
        } })
      }
    })
  }
}

function sendJson(res: ServerResponse, payload: unknown) {
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(payload))
}

// --- watch (Server-Sent Events) --------------------------------------------

function watchHandler(root: string) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.originalUrl ?? req.url ?? '', 'http://localhost')
    const p = url.searchParams.get('path') ?? '/'
    const recursive = url.searchParams.get('recursive') === 'true'

    let abs: string
    try {
      abs = resolveSafe(root, p)
    } catch (e) {
      res.statusCode = 400
      res.end(String(e))
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('retry: 1000\n\n')

    let watcher: import('node:fs').FSWatcher | undefined
    try {
      watcher = fsWatch(abs, { recursive }, (eventType, filename) => {
        res.write(`data: ${JSON.stringify({
          eventType,
          filename: filename != null ? String(filename) : null,
        })}\n\n`)
      })
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: String(e) })}\n\n`)
    }

    const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000)
    req.on('close', () => {
      clearInterval(heartbeat)
      watcher?.close()
    })
  }
}

// --- spaces (Firestore-backed user filesystems, dev emulation) -------------
//
// On immediately.run, apps call the SDK's openAppSpace/createSpace/mountSpace;
// the host mounts a Firestore-backed "space" at /spaces/{id} and exposes a
// runtime global (`module.evaluation.module.bundler.{mounts, messageBus}`) the
// SDK talks to. There is no host under `vite dev`, so we emulate that contract:
//
//   - each space is a real directory at <root>/.devfs/root/spaces/{id} — i.e.
//     /spaces/{id} in the virtual layout — so the existing fs bridge
//     reads/writes it with no special-casing,
//   - a registry at <root>/.devfs/spaces.json tracks names, slot bindings, and
//     which spaces are currently "mounted",
//   - this server answers the SDK's `spaces` protocol over /__devfs/spaces and
//     streams mount-set changes over /__devfs/spaces/events (SSE),
//   - client-spaces.js installs the runtime global in the browser, so the
//     unmodified SDK works exactly as in production.

interface SpaceMeta { name: string; owner: string; createdAt: number }
interface SpacesReg {
  spaces: Record<string, SpaceMeta>
  slots: Record<string, string>      // slot name -> spaceId (dev: one user, no appKey)
  bindings: Record<string, true>     // spaceId -> bound to this app
  mounted: string[]                  // spaceIds currently mounted
}
type SpaceResult = { ok: true; data: unknown } | { ok: false; code: string; message: string }

function createSpaces(root: string) {
  const dir = path.join(root, '.devfs')
  const regFile = path.join(dir, 'spaces.json')
  const spacesRoot = path.join(scratchDir(root), 'spaces')
  const clients = new Set<ServerResponse>()

  // One-time migration from the pre-/app layout, where virtual `/` mapped
  // straight to the project dir and space data lived at <root>/spaces/{id}.
  // Move each space dir into the scratch tree so existing registries keep
  // working, and drop the legacy dir if that empties it. Every spaces request
  // awaits this (via load), so it always wins the race.
  // Only ids the registry knows are moved — a repo's own `spaces/` dir (or
  // anything else in one) is none of our business.
  const migrated = (async () => {
    let ids: string[] = []
    try {
      const reg = JSON.parse(await fsp.readFile(regFile, 'utf8')) as Partial<SpacesReg>
      ids = Object.keys(reg.spaces ?? {})
    } catch { return } // no registry — nothing to migrate
    const legacy = path.join(root, 'spaces')
    let names: string[] = []
    try { names = await fsp.readdir(legacy) } catch { return } // no legacy dir
    await fsp.mkdir(spacesRoot, { recursive: true })
    for (const name of names.filter((n) => ids.includes(n))) {
      await fsp.rename(path.join(legacy, name), path.join(spacesRoot, name))
        .catch(() => { /* already migrated or not movable — leave it */ })
    }
    await fsp.rmdir(legacy).catch(() => { /* not empty — leave it */ })
  })()

  const load = async (): Promise<SpacesReg> => {
    await migrated
    try {
      const reg = JSON.parse(await fsp.readFile(regFile, 'utf8')) as Partial<SpacesReg>
      return { spaces: {}, slots: {}, bindings: {}, mounted: [], ...reg }
    } catch {
      return { spaces: {}, slots: {}, bindings: {}, mounted: [] }
    }
  }
  const save = async (reg: SpacesReg): Promise<void> => {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(regFile, JSON.stringify(reg, null, 2))
  }
  const descriptor = (id: string) => ({ path: `/spaces/${id}`, type: 'firestore', id })
  const mountList = (reg: SpacesReg) => reg.mounted.filter((id) => reg.spaces[id]).map(descriptor)
  const broadcast = (reg: SpacesReg): void => {
    const payload = `data: ${JSON.stringify({ mounts: mountList(reg) })}\n\n`
    for (const res of clients) res.write(payload)
  }
  const mount = async (reg: SpacesReg, id: string): Promise<void> => {
    if (!reg.mounted.includes(id)) { reg.mounted.push(id); await save(reg); broadcast(reg) }
  }

  const handle = async (method: string, q: Record<string, any>): Promise<SpaceResult> => {
    const reg = await load()
    switch (method) {
      case 'open': {
        const slot = q.slot || 'default'
        const id = reg.slots[slot]
        if (id && reg.spaces[id]) { await mount(reg, id); return { ok: true, data: descriptor(id) } }
        return { ok: false, code: 'needs-choice', message: `no workspace bound to slot "${slot}"` }
      }
      case 'create': {
        const id = randomUUID().slice(0, 8)
        await fsp.mkdir(path.join(spacesRoot, id), { recursive: true })
        reg.spaces[id] = { name: q.name || `space-${id}`, owner: 'dev', createdAt: Date.now() }
        if (q.bindToApp) { reg.bindings[id] = true; reg.slots[q.slot || 'default'] = id }
        await mount(reg, id)
        return { ok: true, data: descriptor(id) }
      }
      case 'mount': {
        const id = q.spaceId
        if (!id || !reg.spaces[id]) return { ok: false, code: 'not-found', message: `no such space: ${id}` }
        if (q.slot) { reg.slots[q.slot] = id }
        await mount(reg, id)
        return { ok: true, data: descriptor(id) }
      }
      case 'list': {
        let entries = Object.entries(reg.spaces)
        if (q.app) entries = entries.filter(([id]) => reg.bindings[id])
        return { ok: true, data: entries.map(([spaceId, s]) => ({ spaceId, role: 'owner', owner: s.owner, name: s.name })) }
      }
      case 'unmount': {
        reg.mounted = reg.mounted.filter((x) => x !== q.spaceId)
        await save(reg); broadcast(reg)
        return { ok: true, data: null }
      }
      default:
        return { ok: false, code: 'unknown', message: `unknown spaces method: ${method}` }
    }
  }

  const rpc = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'POST') { res.statusCode = 405; res.end('method not allowed'); return }
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('error', () => sendJson(res, { ok: false, code: 'unknown', message: 'request error' }))
    req.on('end', async () => {
      try {
        const { method, query } = JSON.parse(body || '{}') as { method: string; query?: Record<string, any> }
        sendJson(res, await handle(method, query ?? {}))
      } catch (err) {
        sendJson(res, { ok: false, code: 'unknown', message: String((err as Error)?.message ?? err) })
      }
    })
  }

  const events = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
    res.write('retry: 1000\n\n')
    clients.add(res)
    void load().then((reg) => res.write(`data: ${JSON.stringify({ mounts: mountList(reg) })}\n\n`))
    const heartbeat = setInterval(() => res.write(': hb\n\n'), 30000)
    req.on('close', () => { clearInterval(heartbeat); clients.delete(res) })
  }

  const client = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      res.setHeader('Content-Type', 'text/javascript')
      res.end(await fsp.readFile(CLIENT_SPACES, 'utf8'))
    } catch {
      res.statusCode = 404
      res.end('// dev-fs: client-spaces.js not found (run the dev-fs build)')
    }
  }

  return { rpc, events, client }
}

// connect augments IncomingMessage with originalUrl
declare module 'node:http' {
  interface IncomingMessage {
    originalUrl?: string
  }
}
