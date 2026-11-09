// Privacy report: what the reader blocked for you, kept on this device only (localStorage, per account).
// Nothing here goes to a server: it is a tally of trackers that were removed while you read your own mail.

export interface PrivacyTally {
  /** When counting started on this device. */
  since: string;
  /** Messages that carried at least one tracker. */
  messages: number;
  /** Trackers removed (a message can carry several). */
  trackers: number;
  /** By sender address: display name and how many of their messages tracked. */
  senders: Record<string, { name: string; n: number }>;
  /** By tracking company's host. */
  hosts: Record<string, number>;
  /** Trackers removed per day (local date YYYY-MM-DD), the last two months: for "this week". */
  days: Record<string, number>;
  /** Message ids already counted, newest last: opening a message twice counts once. */
  seen: string[];
}

const SEEN_MAX = 3000, KEEP = 200, DAYS = 62; // bounded: the report is "who tracks you most", not an archive
const key = (user: string) => `om:privacy:${user}`;
const empty = (): PrivacyTally => ({ since: new Date().toISOString(), messages: 0, trackers: 0, senders: {}, hosts: {}, days: {}, seen: [] });

/** Local calendar day, YYYY-MM-DD. */
export const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function readTally(user: string, store: Pick<Storage, 'getItem'> = localStorage): PrivacyTally {
  try { return { ...empty(), ...JSON.parse(store.getItem(key(user)) ?? '{}') }; } catch { return empty(); }
}

/** The `keep` largest entries of a tally, so years of mail can't grow the record without end. */
const top = <T>(o: Record<string, T>, n: (v: T) => number, keep = KEEP) =>
  Object.fromEntries(Object.entries(o).sort((a, b) => n(b[1]) - n(a[1])).slice(0, keep));

/** Pure: the tally after one message's trackers. A message already counted changes nothing. */
export function addTrackers(t: PrivacyTally, messageId: string, sender: { name?: string | null; email: string } | undefined, hosts: string[], now = new Date()): PrivacyTally {
  if (!hosts.length || t.seen.includes(messageId)) return t;
  const email = sender?.email.toLowerCase() ?? '';
  const senders = { ...t.senders };
  if (email) senders[email] = { name: sender?.name?.trim() || senders[email]?.name || email, n: (senders[email]?.n ?? 0) + 1 };
  const byHost = { ...t.hosts };
  for (const h of hosts) byHost[h] = (byHost[h] ?? 0) + 1;
  const today = dayKey(now);
  const days = Object.fromEntries(Object.entries({ ...t.days, [today]: (t.days?.[today] ?? 0) + hosts.length }).sort().slice(-DAYS));
  return { ...t, days, messages: t.messages + 1, trackers: t.trackers + hosts.length,
    senders: top(senders, (s) => s.n), hosts: top(byHost, (c) => c), seen: [...t.seen, messageId].slice(-SEEN_MAX) };
}

export function recordTrackers(user: string, messageId: string, sender: { name?: string | null; email: string } | undefined, hosts: string[]) {
  if (!hosts.length) return;
  try {
    const before = readTally(user), after = addTrackers(before, messageId, sender, hosts);
    if (after !== before) localStorage.setItem(key(user), JSON.stringify(after));
  } catch { /* storage blocked or full: the mail is still protected, only the count is lost */ }
}

export function clearTally(user: string) { try { localStorage.removeItem(key(user)); } catch { /* nothing to clear */ } }

/** Sorted for the report: most first. */
export const ranked = (t: PrivacyTally) => ({
  senders: Object.entries(t.senders).map(([email, s]) => ({ email, ...s })).sort((a, b) => b.n - a.n),
  hosts: Object.entries(t.hosts).map(([host, n]) => ({ host, n })).sort((a, b) => b.n - a.n),
});

/** The last seven days (oldest first, today last), their total, and the total of the seven days before. */
export function week(t: PrivacyTally, now = new Date()) {
  const at = (back: number) => { const d = new Date(now); d.setDate(d.getDate() - back); return t.days?.[dayKey(d)] ?? 0; };
  const days = [6, 5, 4, 3, 2, 1, 0].map((back) => ({ date: (() => { const d = new Date(now); d.setDate(d.getDate() - back); return d; })(), n: at(back) }));
  const sum = (from: number) => Array.from({ length: 7 }, (_, i) => at(from + i)).reduce((a, b) => a + b, 0);
  return { days, total: sum(0), previous: sum(7) };
}
