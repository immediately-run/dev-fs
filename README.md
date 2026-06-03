# @immediately-run/dev-fs

A Vite plugin that makes `import ... from 'fs'` work during local `vite dev` for
[immediately.run](https://immediately.run) apps.

immediately.run apps can use a Node-like filesystem by importing `fs` — it is
**async only** (`fs.promises.*` and callback style; no `*Sync` methods) and, in
the hosted sandbox, backed by ZenFS persisted in the browser. There is no such
filesystem when you run the app locally with Vite, so `import 'fs'` would
normally fail in the browser.

This plugin fills that gap: during `vite dev` it serves a browser shim in place
of the `fs` builtin and bridges every call to your **real local disk**, rooted
at the project directory. It is **dev-only** — it never runs in `vite build`,
and on immediately.run the real ZenFS is used instead.

```
app code  →  fs shim (browser)  →  HTTP /__devfs      →  node:fs   (read/write/stat/…)
                                 →  SSE  /__devfs/watch ←  fs.watch  (change events)
```

## Install

```bash
npm install -D @immediately-run/dev-fs
```

## Usage

Add the plugin to your Vite config:

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { devFs } from '@immediately-run/dev-fs'

export default defineConfig({
  plugins: [
    devFs(),
    react(),
  ],
})
```

For TypeScript types on the `fs` import (so app code type-checks without pulling
all of `@types/node` into your browser project), add a one-line reference in any
`.d.ts` file your `tsconfig` includes — for example `src/devfs.d.ts`:

```ts
/// <reference types="@immediately-run/dev-fs/fs" />
```

Now `fs` works the same locally as it does on immediately.run:

```ts
import fs from 'fs'

await fs.promises.mkdir('/data', { recursive: true })
await fs.promises.writeFile('/data/notes.txt', 'hello', 'utf8')

const text = await fs.promises.readFile('/data/notes.txt', 'utf8') // string

// watch is an async iterable of change events
for await (const ev of fs.promises.watch('/data', { recursive: true })) {
  console.log(ev.eventType, ev.filename)
}
```

Paths are rooted at your project directory, matching the sandbox: an app path
of `/src/App.tsx` maps to `<project>/src/App.tsx` on disk.

## Options

```ts
devFs({
  // Globs the Vite file watcher should ignore, so writes your app makes during
  // dev don't trigger HMR reloads. The plugin's own `watch` uses an independent
  // fs.watch, so it still reports these changes.
  // Default: ['**/devfs-playground/**']
  ignore: ['**/my-scratch-dir/**'],
})
```

## Supported `fs` surface

Async only — there are no synchronous (`*Sync`) methods, matching what
immediately.run exposes.

`readFile`, `writeFile`, `appendFile`, `readdir` (incl. `withFileTypes`),
`mkdir`, `rm`, `rmdir`, `unlink`, `stat`, `lstat`, `access`, `rename`,
`copyFile`, `realpath`, and `watch` — available on `fs.promises.*`, plus the
Node callback forms on the default export (e.g. `fs.readFile(path, cb)`).

## Good to know

- **No sync methods.** The bridge is request/response and can't service
  synchronous calls — the same constraint immediately.run has.
- **Binary reads return a `Uint8Array`, not a Node `Buffer`.** Pass an encoding
  (`readFile(path, 'utf8')`) when you want a string.
- **`watch` on Linux:** the bridge uses recursive `fs.watch`, which is
  unsupported on Linux — `watch` works on macOS/Windows but may miss nested
  changes in a Linux dev container. immediately.run's own `watch` is unaffected.
- **Scope:** the bridge only reads and writes under the project root; paths that
  escape it are rejected with `EACCES`.
- **Dev-only:** the plugin sets `apply: 'serve'`, so it is absent from
  production builds and has no effect on immediately.run.

## Spaces (Firestore-backed filesystems)

On immediately.run, apps can request **spaces** — Firestore-backed user
filesystems — through `@immediately-run/sdk` (`openAppSpace`, `createSpace`,
`mountSpace`, `listSpaces`, `unmountSpace`). The host signs the user in, renders
the create / pick UI, mounts the space at `/spaces/{id}`, and exposes a runtime
global the SDK talks to. Once mounted, a space is read and written through the
ordinary `fs` module at its mount path — no separate API.

There is no host under `vite dev`, so this plugin **emulates** it, letting the
**unmodified** SDK work locally exactly as it does in production:

```
app code → @immediately-run/sdk (unchanged)
              │  reads module.evaluation.module.bundler.{mounts, messageBus}
              ▼
       client-spaces.js (installed in <head>, before app code)
              →  POST /__devfs/spaces        →  registry + node:fs   (open/create/mount/list/unmount)
              →  SSE  /__devfs/spaces/events  ←  mount-set changes    (so useMounts/waitForMount fire)
```

- Each space is a **real directory** at `<project>/spaces/{id}`, so the existing
  `fs` bridge reads and writes it at `/spaces/{id}` with no special-casing.
- A registry at `<project>/.devfs/spaces.json` tracks space names, slot bindings,
  and which spaces are mounted.
- When the SDK calls `openAppSpace()` on an unbound slot, the plugin renders a
  minimal create-or-pick dialog in the page — the local stand-in for the host's
  sign-in / create UX. `createSpace` / `mountSpace` need no dialog.

This is **dev-only**, like the `fs` bridge: the substrate is injected via
`transformIndexHtml` under `apply: 'serve'` and is absent from `vite build`. No
app code changes are needed — import the real SDK; it just works in both places.

Add `spaces/` and `.devfs/` to your `.gitignore` so dev space data isn't
committed.

## How it works

`resolveId` redirects the bare `'fs'` / `'node:fs'` specifier to a browser shim
(`client-fs.js`). The shim implements the async `fs` surface over the dev
server: request/response operations go over `fetch` to a `/__devfs` middleware
that runs `node:fs` under the project root; `fs.promises.watch` opens a
Server-Sent Events stream at `/__devfs/watch` backed by `fs.watch`. SSE
(rather than polling or a WebSocket) gives push-based change events with
auto-reconnect and no extra dependencies.

## License

MIT
