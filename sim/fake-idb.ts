// Minimal in-memory IndexedDB shim so the real storage/db.ts persistence path
// (getPlayerStats / savePlayerStats) works in Node, letting the bot actually
// TRACK opponents during simulation and engage its exploit adjuster. Only the
// subset of the IDB API that db.ts uses is implemented, backed by plain Maps.

type Handler = ((ev: { target: { result: unknown } }) => void) | null;

class FakeRequest<T> {
  result: T | undefined;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  _succeed(v: T | undefined): void {
    this.result = v;
    queueMicrotask(() => this.onsuccess && this.onsuccess({ target: { result: v as unknown } }));
  }
}

class FakeStore {
  map = new Map<unknown, unknown>();
  private autoId = 1;
  constructor(public keyPath: string | null) {}
  get(k: unknown) { const r = new FakeRequest<unknown>(); r._succeed(this.map.get(k)); return r; }
  put(v: Record<string, unknown>) {
    const key = this.keyPath ? v[this.keyPath] : this.autoId++;
    this.map.set(key, v); const r = new FakeRequest<void>(); r._succeed(undefined); return r;
  }
  add(v: Record<string, unknown>) { return this.put(v); }
  getAll() { const r = new FakeRequest<unknown[]>(); r._succeed([...this.map.values()]); return r; }
  delete(k: unknown) { this.map.delete(k); const r = new FakeRequest<void>(); r._succeed(undefined); return r; }
  createIndex() { /* indexes are not needed for the shim */ }
}

class FakeTx {
  constructor(private db: FakeDB) {}
  objectStore(name: string) { return this.db.stores.get(name)!; }
}

class FakeDB {
  stores = new Map<string, FakeStore>();
  get objectStoreNames() { const s = this.stores; return { contains: (n: string) => s.has(n) }; }
  createObjectStore(name: string, opts?: { keyPath?: string }) {
    const st = new FakeStore(opts && opts.keyPath !== undefined ? opts.keyPath : null);
    this.stores.set(name, st); return st;
  }
  transaction(_name: string | string[], _mode?: string) { return new FakeTx(this); }
}

let theDB: FakeDB | null = null;

const factory = {
  open(_name: string, _version?: number) {
    const req = new FakeRequest<FakeDB>();
    const db = theDB ?? (theDB = new FakeDB());
    const fresh = db.stores.size === 0;
    queueMicrotask(() => {
      if (fresh && req.onupgradeneeded) { req.result = db; req.onupgradeneeded({ target: { result: db } }); }
      req.result = db;
      req.onsuccess && req.onsuccess({ target: { result: db } });
    });
    return req;
  },
};

// install
(globalThis as unknown as { indexedDB: unknown }).indexedDB = factory;

/** Wipe all stored data (call between independent matchups for clean tracking). */
export function resetFakeIdb(): void { theDB = null; }
