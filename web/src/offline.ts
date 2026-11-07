// Offline mail: recent lists and opened conversations are kept in IndexedDB, and mail sent while offline waits in an
// outbox until the connection is back. Only on trusted devices ("Keep me signed in"): a shared computer never keeps
// mail after the tab closes, and signing out wipes it.
// ponytail: stored unencrypted, like the browser's own cache; device encryption (FileVault/BitLocker) covers it at rest.

const DB = 'openmail-offline', STORE = 'kv';
let dbp: Promise<IDBDatabase> | null = null;
const db = () => (dbp ??= new Promise((ok, fail) => {
  const r = indexedDB.open(DB, 1);
  r.onupgradeneeded = () => r.result.createObjectStore(STORE);
  r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error);
}));
const tx = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => {
  const d = await db();
  return new Promise<T>((ok, fail) => { const q = fn(d.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => ok(q.result); q.onerror = () => fail(q.error); });
};

export const offlineStore = {
  get: <T>(key: string) => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, v: unknown) => tx('readwrite', (s) => s.put(v, key)).catch(() => undefined),
  /** Everything for one account ("<username>:…"). */
  async clear(prefix: string) {
    const d = await db().catch(() => null);
    if (!d) return;
    await new Promise<void>((ok) => {
      const s = d.transaction(STORE, 'readwrite').objectStore(STORE);
      const r = s.openCursor();
      r.onsuccess = () => { const c = r.result; if (!c) return ok(); if (String(c.key).startsWith(prefix)) c.delete(); c.continue(); };
      r.onerror = () => ok();
    });
  },
};

/** A request failed because there's no connection (not because the server said no). */
export const isOffline = (e: unknown) => !navigator.onLine || (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));
