// Local-first: show the last known lists instantly, refresh in the background.
// ponytail: localStorage cache of list pages only; move to IndexedDB + Email/changes sync for full offline mode.
export const cache = {
  get<T>(key: string): T | null { try { return JSON.parse(localStorage.getItem('om:' + key) ?? 'null'); } catch { return null; } },
  set(key: string, v: unknown) { try { localStorage.setItem('om:' + key, JSON.stringify(v)); } catch {} },
  clear() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('om:') && k !== 'om:theme').forEach((k) => localStorage.removeItem(k)); } catch {}
  },
};
