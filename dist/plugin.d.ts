import type { Plugin } from 'vite';
export interface DevFsOptions {
    /** Globs the vite watcher should ignore, so app writes don't trigger HMR
     *  reloads. The SSE watch uses its own fs.watch, so it still sees changes. */
    ignore?: string[];
}
export declare function devFs(options?: DevFsOptions): Plugin;
declare module 'node:http' {
    interface IncomingMessage {
        originalUrl?: string;
    }
}
