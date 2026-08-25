#!/usr/bin/env node
/*
 * The `fs` types entry must be a pure re-reference of the SDK's declaration —
 * R3-276b.
 *
 * This package (`@immediately-run/dev-fs`) stopped carrying its own copy of the
 * async-only `fs` surface: the package that owns a surface declares it, and that
 * is the SDK (`ambient.d.ts` + `ambient-fs.d.ts`, `/// <reference
 * types="@immediately-run/sdk/ambient" />`). This check proves the REAL shipped
 * `fs.d.ts`, against the REAL published SDK:
 *
 *   - a fixture app referencing BOTH `@immediately-run/dev-fs/fs` and
 *     `@immediately-run/sdk/ambient` (the transition state every app repo is in
 *     until it drops the dev-fs line) type-checks;
 *   - the surface is typed, not widened (`readFile(p,'utf8')` is
 *     `Promise<string>`, not `any`), and NO `*Sync` spelling is reachable
 *     (`// @ts-expect-error` — an unused directive is itself a compile error);
 *   - a drifted second copy (the failure mode `declare module` produces by
 *     MERGING instead of erroring) fails the probe.
 *
 * The SDK comes from the npm registry (`>=0.49.0` — the first release whose tarball
 * ambient declarations include `fs`), installed INTO the fixture — this repo's
 * own lockfile stays dependency-free. For local verification against an
 * unpublished SDK, pass `--sdk <tarball-or-dir>` (npm pack the SDK checkout
 * first); what CI runs is the registry form.
 *
 * Usage:
 *   npm test                                   (registry SDK)
 *   node scripts/check-fs-types.mjs --sdk /path/to/sdk-0.47.0.tgz
 *   node scripts/check-fs-types.mjs --self-test
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TSC = join(ROOT, 'node_modules', 'typescript', 'lib', 'tsc.js');

const PROBE = `import fs from 'fs';

const text: Promise<string> = fs.promises.readFile('/app/content/a.mdx', 'utf8');

// @ts-expect-error — readFile(p,'utf8') is Promise<string>; if this assigns, the
// surface has widened to \`any\` (the double-declaration failure mode).
const widened: Promise<Uint8Array> = fs.promises.readFile('/app/content/a.mdx', 'utf8');

// @ts-expect-error — the surface is async-only: no promises readFileSync
fs.promises.readFileSync('/app/a');
// @ts-expect-error — and no top-level readFileSync
fs.readFileSync('/app/a');

export { text, widened };
`;

const TSCONFIG = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "module": "ESNext",
    "moduleResolution": "bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "esModuleInterop": true,
    "types": []
  },
  "include": ["src", "globals.d.ts"]
}
`;

const die = (msg) => {
  console.error(`error: ${msg}`);
  process.exit(1);
};

/**
 * A fixture app in the transition state: references BOTH the dev-fs path and the
 * SDK path (the two triple-slash lines every app repo carries mid-migration).
 * `sdkSpec` is what npm installs into the fixture ('>=0.49.0' or a local
 * tarball); `fsDts` overrides the shipped fs.d.ts under self-test.
 */
function makeFixture({ sdkSpec, fsDts }) {
  const dir = mkdtempSync(join(tmpdir(), 'devfs-app-'));
  const nm = join(dir, 'node_modules');
  const scope = join(nm, '@immediately-run');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(scope, { recursive: true });

  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'devfs-probe', private: true }));
  writeFileSync(join(dir, 'tsconfig.json'), TSCONFIG);
  writeFileSync(
    join(dir, 'globals.d.ts'),
    '/// <reference types="@immediately-run/sdk/ambient" />\n/// <reference types="@immediately-run/dev-fs/fs" />\n',
  );
  writeFileSync(join(dir, 'src', 'probe.ts'), PROBE);

  const install = spawnSync(
    'npm',
    ['install', '--no-audit', '--no-fund', '--no-save', `@immediately-run/sdk@${sdkSpec}`, 'react@19', '@types/react@19'],
    { cwd: dir, encoding: 'utf8' },
  );
  if (install.status !== 0) die(`fixture npm install failed:\n${install.stdout}\n${install.stderr}`);

  // AFTER npm install: it would otherwise prune the hand-placed package as
  // extraneous. The REAL package under test is copied in verbatim (or the
  // self-test's mutation of it).
  const dfDir = join(scope, 'dev-fs');
  mkdirSync(dfDir, { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dfDir, 'package.json'));
  writeFileSync(join(dfDir, 'fs.d.ts'), fsDts ?? readFileSync(join(ROOT, 'fs.d.ts'), 'utf8'));
  return dir;
}

const compile = (dir) => {
  const r = spawnSync(process.execPath, [TSC, '-p', dir], { encoding: 'utf8' });
  return { ok: r.status === 0, stdout: r.stdout + r.stderr };
};

const DRIFTED_COPY = `declare module 'fs' {
  export const promises: {
    readFile(path: string, encoding: string): Promise<string>
    readFileSync(path: string): string
  }
}
export {};
`;

async function run({ sdkSpec = '>=0.49.0' } = {}) {
  if (!existsSync(TSC)) die('typescript not installed — run npm ci.');
  if (!existsSync(join(ROOT, 'fs.d.ts'))) die('fs.d.ts missing from the repo root.');

  const dir = makeFixture({ sdkSpec });
  const r = compile(dir);
  rmSync(dir, { recursive: true, force: true });
  if (!r.ok) {
    console.error(r.stdout);
    die('the shipped fs.d.ts does not type-check as a re-reference against the SDK.');
  }
  console.log(`✓ fs.d.ts is a pure re-reference (fixture: both references, sdk ${sdkSpec})`);
}

const selfTest = async ({ sdkSpec = '>=0.49.0' } = {}) => {
  if (!existsSync(TSC)) die('self-test needs typescript installed (npm ci).');
  const cases = [
    ['a drifted own-copy fs.d.ts is caught (merge, not error)', async () => {
      const dir = makeFixture({ sdkSpec, fsDts: DRIFTED_COPY });
      const r = compile(dir);
      rmSync(dir, { recursive: true, force: true });
      return !r.ok;
    }],
    ['the empty-shell alias alone (no SDK present) fails loudly', async () => {
      const dir = makeFixture({ sdkSpec });
      rmSync(join(dir, 'node_modules', '@immediately-run', 'sdk'), { recursive: true, force: true });
      const r = compile(dir);
      rmSync(dir, { recursive: true, force: true });
      return !r.ok;
    }],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    const pass = await fn();
    console.log(`${pass ? '✓' : '✗'} ${name}`);
    if (!pass) failed++;
  }
  console.log(`\n${cases.length - failed}/${cases.length} self-test cases.`);
  return failed === 0;
};

const argv = process.argv.slice(2);
const sdkArg = (() => {
  const i = argv.indexOf('--sdk');
  return i >= 0 ? argv[i + 1] : undefined;
})();
if (argv.includes('--self-test')) {
  process.exit((await selfTest(sdkArg ? { sdkSpec: sdkArg } : {})) ? 0 : 1);
} else {
  await run(sdkArg ? { sdkSpec: sdkArg } : {});
}
