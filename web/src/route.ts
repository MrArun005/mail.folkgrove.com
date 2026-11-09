// Where you are, in the address bar: #/in/<folder>, #/search/<words>, each optionally followed by /t/<conversation>.
// So the Back button (and the phone's back gesture) closes a conversation instead of leaving the app, a reload
// keeps your place, and a conversation has a link. A hash, not a path: no server rewrite rule, works when self-hosted
// behind anything, and never reaches the server's logs.

export interface Route { view: string | null; query: string; thread: string | null }

export const HOME: Route = { view: null, query: '', thread: null };

const enc = encodeURIComponent;
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** '' for the Inbox with nothing open. A search replaces the folder (a search has no folder). */
export function formatRoute(r: Route): string {
  const parts: string[] = [];
  if (r.query) parts.push('search', enc(r.query));
  else if (r.view) parts.push('in', enc(r.view));
  if (r.thread) parts.push('t', enc(r.thread));
  return parts.length ? `#/${parts.join('/')}` : '';
}

/** Anything it doesn't understand is the Inbox: a stale or hand-edited link never breaks the app. */
export function parseRoute(hash: string): Route {
  const p = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const r: Route = { ...HOME };
  for (let i = 0; i + 1 < p.length; i += 2) {
    const v = dec(p[i + 1]);
    if (p[i] === 'in') r.view = v;
    else if (p[i] === 'search') r.query = v;
    else if (p[i] === 't') r.thread = v;
  }
  if (r.query) r.view = null;
  return r;
}

export const readRoute = (): Route => parseRoute(location.hash);

/**
 * How a change of place goes into history:
 * - 'push'    a new step Back should return from: opening a conversation, another folder, starting a search
 * - 'back'    closing the conversation we pushed: go back to the entry under it instead of adding a third
 * - 'replace' the same step, changed: the next conversation (j/k, auto-advance), more letters in a search
 */
export function step(prev: Route, next: Route, pushedThread: boolean): 'push' | 'replace' | 'back' {
  const samePlace = prev.view === next.view && prev.query === next.query;
  if (samePlace) {
    if (!prev.thread && next.thread) return 'push';
    if (prev.thread && !next.thread && pushedThread) return 'back';
    return 'replace';
  }
  if (prev.query && next.query) return 'replace'; // still typing
  return 'push';
}

/** Put `next` in the address bar. The history entry remembers whether it was a conversation opened from a list. */
export function writeRoute(prev: Route, next: Route) {
  const hash = formatRoute(next);
  if (hash === formatRoute(readRoute())) return;
  const url = location.pathname + location.search + hash;
  const pushed = !!history.state?.omThread;
  const how = step(prev, next, pushed);
  if (how === 'back') history.back();
  else if (how === 'push') history.pushState({ omThread: !prev.thread && !!next.thread }, '', url);
  else history.replaceState({ omThread: pushed && !!next.thread }, '', url);
}

/** Another account or mailbox: its folders and conversations have other ids, so start from its Inbox. */
export function clearRoute() {
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
