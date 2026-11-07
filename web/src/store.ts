// Local-first: show the last known lists instantly, refresh in the background.
// sessionStorage, not localStorage: cached mail must not outlive the sign-in (shared computers).
// ponytail: list pages only; full offline mode needs IndexedDB encrypted with a per-session key.
export const cache = {
  get<T>(key: string): T | null { try { return JSON.parse(sessionStorage.getItem('om:' + key) ?? 'null'); } catch { return null; } },
  set(key: string, v: unknown) { try { sessionStorage.setItem('om:' + key, JSON.stringify(v)); } catch {} },
  clear() {
    try { Object.keys(sessionStorage).filter((k) => k.startsWith('om:')).forEach((k) => sessionStorage.removeItem(k)); } catch {}
  },
};
