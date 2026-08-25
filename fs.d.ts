// Types for the `fs` module as immediately.run exposes it to apps.
//
// DEPRECATED HOME (R3-276b): the declaration itself now lives where the surface
// is owned — `@immediately-run/sdk`'s ambient declarations:
//
//     /// <reference types="@immediately-run/sdk/ambient" />
//
// This file remains so existing `/// <reference types="@immediately-run/dev-fs/fs" />`
// lines keep working (deprecation window per SDK_PACKAGING_SPEC §9); it resolves
// to the SDK's declaration, so there is exactly ONE copy of the `fs` surface and
// this path can never drift from it.
//
// Requires the SDK's ambient `fs` declaration — complete from sdk 0.49.0 (0.47.0
// published without `ambient-fs.d.ts`; an app on an older SDK pin should stay on
// dev-fs < 0.4.0 until it bumps the pin).
//
// The Vite plugin this package ships (bridging the same `fs` surface to real disk
// during `vite dev`) is unaffected — only the types entry changed.
/// <reference types="@immediately-run/sdk/ambient" />

export {};
