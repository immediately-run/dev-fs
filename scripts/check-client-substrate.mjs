#!/usr/bin/env node
/*
 * The client substrate (client-spaces.js) must give the UNMODIFIED SDK what it
 * discovers at runtime — R3-421 adds the sandbox-fs global to that contract.
 *
 * What is proved, against the REAL shipped files (client-spaces.js loading
 * client-fs.js through its own lazy import, with the dev-server boundary
 * stubbed at `fetch`):
 *
 *   - importing the substrate throws nothing outside a browser (no DOM, no
 *     EventSource requirement beyond a constructor);
 *   - it publishes `globalThis.__sandpackSharedFs` SYNCHRONOUSLY, shaped the
 *     way the SDK's `sandboxFs()` probe requires (`promises.readFile` is a
 *     function), so `openFs` / `readBlob` / `readObjectUrl` / `useObjectUrl`
 *     resolve it under `vite dev`;
 *   - a read through the bridge round-trips: the forwarder lazy-loads the fs
 *     shim from /__devfs/client-fs.js and the shim's rpc hits /__devfs — both
 *     utf8 (string) and binary (Uint8Array) decode shapes;
 *   - the messageBus honours the SDK transport contract: `onMessage` returns a
 *     DISPOSABLE (`{ dispose() }`), not a bare function — the SDK's
 *     `addListener` unsubscribe calls `.dispose()` on it;
 *   - the mount service is present and starts empty.
 *
 * Usage:
 *   node --test scripts/check-client-substrate.mjs   (what `npm test` runs)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The substrate lazy-imports the fs shim by its dev-server URL; map it to the
// real shipped file so the test exercises the actual pair.
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === '/__devfs/client-fs.js') {
      return { url: pathToFileURL(join(ROOT, 'client-fs.js')).href, shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

// Stub the browser boundary. EventSource: constructed at substrate module eval
// (mount events) and per-watch in the shim — a do-nothing stand-in suffices.
class StubEventSource {
  close() {}
}
globalThis.EventSource = StubEventSource

// The dev server: answer the shim's /__devfs rpc for two known files.
const FILES = { '/app/notes/a.txt': 'hello from disk', '/app/img/dot.png': Buffer.from([1, 2, 3]) }
globalThis.fetch = async (url, opts) => {
  assert.equal(url, '/__devfs', 'only the rpc endpoint is fetched in this drill')
  const { op, args } = JSON.parse(opts.body)
  assert.equal(op, 'readFile')
  const [p, enc] = args
  const data = FILES[p]
  if (data === undefined) {
    return { ok: true, json: async () => ({ ok: false, error: { message: `ENOENT: ${p}`, code: 'ENOENT' } }) }
  }
  const value = enc
    ? { t: 's', v: data.toString() }
    : { t: 'b', v: Buffer.from(data).toString('base64') }
  return { ok: true, json: async () => ({ ok: true, value }) }
}

await test('importing the substrate outside a browser throws nothing', async () => {
  await import(pathToFileURL(join(ROOT, 'client-spaces.js')).href)
})

await test('__sandpackSharedFs is published synchronously, shaped for the SDK probe', () => {
  const shared = globalThis.__sandpackSharedFs
  assert.ok(shared, 'global exists right after module eval — before any app code runs')
  assert.equal(typeof shared.promises?.readFile, 'function', "the SDK's hasFs() probe shape")
})

await test('a utf8 read round-trips through bridge → lazy shim → rpc', async () => {
  const text = await globalThis.__sandpackSharedFs.promises.readFile('/app/notes/a.txt', 'utf8')
  assert.equal(text, 'hello from disk')
})

await test('a binary read returns a Uint8Array (what readBlob feeds to Blob)', async () => {
  const bytes = await globalThis.__sandpackSharedFs.promises.readFile('/app/img/dot.png')
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual([...bytes], [1, 2, 3])
})

await test('a missing file rejects with the mapped errno', async () => {
  await assert.rejects(globalThis.__sandpackSharedFs.promises.readFile('/app/nope', 'utf8'), (e) => e.code === 'ENOENT')
})

await test('messageBus.onMessage returns a disposable, per the SDK transport contract', () => {
  const bus = globalThis.module?.evaluation?.module?.bundler?.messageBus
  assert.ok(bus, 'messageBus is installed')
  const sub = bus.onMessage(() => {})
  assert.equal(typeof sub?.dispose, 'function', 'HostTransport.onMessage → { dispose() }')
  assert.doesNotThrow(() => sub.dispose())
  assert.doesNotThrow(() => bus.sendMessage('task-complete', {}))
})

await test('the mount service is installed and starts empty', () => {
  const mounts = globalThis.module?.evaluation?.module?.bundler?.mounts
  assert.ok(mounts, 'mount service is installed')
  assert.deepEqual(mounts.getMounts(), [])
})
