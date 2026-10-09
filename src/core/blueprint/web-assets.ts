// ============================================================
// Where the in-browser blueprint's assets come from.
//
//   extension  fetch(chrome.runtime.getURL('blueprint/<file>')); the webpack
//              build copies blueprint/web/* to dist/blueprint/ and the
//              manifest lists them as web-accessible for the content script.
//              .gz files are inflated with DecompressionStream.
//   Node       (sims, tests, benches) read from GPO_BP_WEB_DIR, default
//              <repo>/blueprint/web, through process.getBuiltinModule, so the
//              extension bundle never references fs or zlib.
//
// getWebBlueprint() loads once per page (or process) and caches the result;
// a failed load is cached too, so a missing asset costs one attempt, not one
// per decision.
// ============================================================

import { AssetReader, WebBlueprint, loadWebBlueprint } from './web-blueprint';

declare const __dirname: string | undefined;

interface NodeLike {
  getBuiltinModule?: (name: string) => unknown;
  env?: Record<string, string | undefined>;
  cwd?: () => string;
}

interface ChromeLike {
  runtime?: { getURL?: (path: string) => string };
}

async function inflateWeb(bytes: ArrayBuffer): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reader for the extension: files under dist/blueprint/. */
export function extensionAssetReader(getURL: (path: string) => string): AssetReader {
  return async (file: string) => {
    const res = await fetch(getURL(`blueprint/${file}`));
    if (!res.ok) throw new Error(`blueprint web: fetch ${file} failed (${res.status})`);
    const raw = await res.arrayBuffer();
    return file.endsWith('.gz') ? inflateWeb(raw) : new Uint8Array(raw);
  };
}

/** Reader for Node: files in `dir` (default GPO_BP_WEB_DIR or <repo>/blueprint/web). */
export function nodeAssetReader(dir?: string): AssetReader | null {
  const proc = (globalThis as { process?: NodeLike }).process;
  const get = proc?.getBuiltinModule;
  if (!proc || !get) return null;
  const fs = get('fs') as { readFileSync(p: string): Uint8Array };
  const path = get('path') as { resolve(...p: string[]): string; join(...p: string[]): string };
  const zlib = get('zlib') as { gunzipSync(b: Uint8Array): Uint8Array };
  const base = dir
    ?? proc.env?.GPO_BP_WEB_DIR
    ?? (typeof __dirname === 'string' ? path.resolve(__dirname, '../../../blueprint/web') : path.resolve(proc.cwd?.() ?? '.', 'blueprint/web'));
  return async (file: string) => {
    const raw = fs.readFileSync(path.join(base, file));
    const out = file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw;
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
  };
}

/** The reader for the current runtime, or null when neither is available. */
export function defaultAssetReader(): AssetReader | null {
  const chrome = (globalThis as { chrome?: ChromeLike }).chrome;
  const getURL = chrome?.runtime?.getURL;
  if (typeof getURL === 'function') return extensionAssetReader(p => getURL(p));
  return nodeAssetReader();
}

let cached: Promise<WebBlueprint> | null = null;
let reader: AssetReader | null = null;
/** Milliseconds the last load took (null until a load finished). */
export let lastLoadMs: number | null = null;

/** Use a specific reader (tests); clears the cache. */
export function setWebBlueprintReader(r: AssetReader | null): void {
  reader = r;
  cached = null;
  lastLoadMs = null;
}

/** Load (once) and return the in-browser blueprint. Rejects when assets are missing. */
export function getWebBlueprint(): Promise<WebBlueprint> {
  if (!cached) {
    const r = reader ?? defaultAssetReader();
    const t0 = Date.now();
    cached = r
      ? loadWebBlueprint(r).then(bp => { lastLoadMs = Date.now() - t0; return bp; })
      : Promise.reject(new Error('blueprint web: no asset reader for this runtime'));
    cached.catch(() => { /* reported by the caller */ });
  }
  return cached;
}
