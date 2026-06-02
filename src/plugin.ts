// vite-plugin-dev-fs — makes `import ... from 'fs'` work during local `vite dev`.
//
// On immediately.run the app's `fs` import resolves to a ZenFS bound context
// (async-only: `fs.promises.*` + callback style) backed by the parent window
// over a MessagePort, rooted at the project root. Locally there is no such
// bridge, so this plugin recreates the same contract over the dev server:
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
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_SHIM = path.join(here, 'client-fs.js')

export interface DevFsOptions {
  /** Globs the vite watcher should ignore, so app writes don't trigger HMR
   *  reloads. The SSE watch uses its own fs.watch, so it still sees changes. */
  ignore?: string[]
}

export function devFs(options: DevFsOptions = {}): Plugin {
  const ignore = options.ignore ?? ['**/devfs-playground/**']
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
    configureServer(server) {
      const root = server.config.root
      // More specific route first: it fully handles the request (never next()),
      // so the generic /__devfs handler never sees watch traffic.
      server.middlewares.use('/__devfs/watch', watchHandler(root))
      server.middlewares.use('/__devfs', rpcHandler(root))
    },
  }
}

// --- path scoping ----------------------------------------------------------

function fsError(code: string, message: string, p?: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: ${message}`) as NodeJS.ErrnoException
  e.code = code
  if (p) e.path = p
  return e
}

/** Map an app-rooted path (`/src/App.tsx`) to a real disk path under `root`,
 *  rejecting any path that escapes the project root. */
function resolveSafe(root: string, p: unknown): string {
  if (typeof p !== 'string') throw fsError('EINVAL', 'path must be a string')
  const rel = p.replace(/^[\\/]+/, '')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw fsError('EACCES', `path escapes project root: ${p}`, p)
  }
  return abs
}

/** Inverse of resolveSafe: a real disk path back to an app-rooted path. */
function toAppPath(root: string, abs: string): string {
  const rel = path.relative(root, abs)
  if (!rel || rel === '') return '/'
  return '/' + rel.split(path.sep).join('/')
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
      if (options?.withFileTypes) {
        const ents = await fsp.readdir(p0(), { withFileTypes: true })
        return { t: 'j', v: ents.map((e) => ({
          name: e.name, dir: e.isDirectory(), file: e.isFile(), symlink: e.isSymbolicLink(),
        })) }
      }
      return { t: 'j', v: await fsp.readdir(p0()) }
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

// connect augments IncomingMessage with originalUrl
declare module 'node:http' {
  interface IncomingMessage {
    originalUrl?: string
  }
}
