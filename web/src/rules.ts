// Filters ("rules") as data, compiled to a Sieve script (RFC 5228) that the mail server runs on delivery.
// The rules are also stored inside the script as a JSON comment, so the app can read them back exactly.
import { t, type Key, type Vars } from './i18n';
import { en } from './i18n/en';

export type RuleAction = 'move' | 'read' | 'star' | 'trash' | 'block' | 'forward';
export interface Rule {
  id: string;
  from?: string;          // sender address or domain contains (or equals, with fromExact)
  fromExact?: boolean;    // exact address match: used by Block sender so it can't over-match
  to?: string;            // any recipient contains
  subject?: string;       // subject contains
  action: RuleAction;
  folder?: string;        // for move: mailbox name
  forwardTo?: string;     // for forward: address
}

/** Out-of-office reply. Lives in the same script as the filters: Sieve allows only one active script,
 *  so a separate vacation script (the JMAP VacationResponse object) would switch the filters off. */
export interface Vacation { enabled: boolean; from?: string | null; to?: string | null; subject?: string; body?: string }
/** Everything this app keeps on the server in its Sieve script: synced to every device, private to the account. */
export interface ScriptData {
  rules: Rule[];
  vacation: Vacation;
  /** Sort newsletters and notifications into Updates (keyword $updates), Gmail-style. On unless turned off. */
  categories?: boolean;
  /** Which tabs show next to Primary (with categories on). Missing: only Updates (saved before the other tabs). */
  tabs?: Tab[];
  savedSearches?: { name: string; query: string }[];
  /** Named signatures; sigNew/sigReply pick one by name ('' = none, missing = the first). */
  signatures?: { name: string; text: string }[];
  sigNew?: string;
  sigReply?: string;
  /** HEY-style Screener: mail from anyone not on `allow` waits in the Screener folder until approved. */
  screener?: { on: boolean; allow: string[] };
  /** Colours you chose for your folders: mailbox id → hue (0–359). A folder without one gets a colour from its name. */
  colors?: Record<string, number>;
  /** Shared folders or mailboxes hidden from "Shared with me": "accountId" or "accountId/mailboxId". */
  hiddenShares?: string[];
}
export const SCREENER = 'Screener';
const isAddress = (a: string) => /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/.test(a);
export const UPDATES = '$updates';

/** Inbox tabs next to Primary, in the order shown. Each is a keyword the server's Sieve script sets on delivery. */
export const TABS = ['promotions', 'social', 'updates', 'forums'] as const;
export type Tab = typeof TABS[number];
export const tabKeyword = (k: Tab) => `$${k}`;
export const TAB_LABEL = { primary: 'mail.primary', promotions: 'smarts.promotions', social: 'smarts.social', updates: 'folder.updates',
  forums: 'smarts.forums' } as const satisfies Record<string, Key>;
/** What a new account gets (Gmail's default set, plus Updates, which we had first). */
export const DEFAULT_TABS: Tab[] = ['promotions', 'social', 'updates'];
/** Receipts, deliveries and bookings: mail carrying schema.org order/travel data. The "Purchases & trips" search. */
export const PURCHASE = '$purchase';
// ponytail: a fixed list of the big social networks; a sender not on it is sorted by its list headers instead.
const SOCIAL = ['facebook.com', 'facebookmail.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'pinterest.com',
  'tiktok.com', 'reddit.com', 'redditmail.com', 'snapchat.com', 'tumblr.com', 'quora.com', 'youtube.com', 'discord.com',
  'nextdoor.com', 'meetup.com', 'threads.net', 'bsky.app', 'strava.com', 'whatsapp.com', 'mastodon.social'];
const AUTOMATED = ['noreply', 'no-reply', 'donotreply', 'notifications', 'mailer-daemon'];
const FORUM_LISTS = ['googlegroups.com', 'groups.io'];
const PURCHASE_MARKS = ['ParcelDelivery', 'FlightReservation', 'LodgingReservation', 'EventReservation', 'schema.org/Order', '"Order"'];
// First match wins, in this order (a social network's digest has list headers too).
const SORT_ORDER = ['social', 'forums', 'promotions', 'updates'] as const;

/** The headers the sorting looks at, for mail that arrived before the rule did. */
export interface CategoryHeaders { from: string; listId?: string | null; listUnsubscribe?: string | null; listPost?: string | null; precedence?: string | null; mailman?: string | null }
/** The same decision as the Sieve rule in toSieve (except the purchase check, which reads the body on the server). */
export function categorize(h: CategoryHeaders, tabs: readonly Tab[]): Tab | null {
  const at = h.from.lastIndexOf('@'), domain = h.from.slice(at + 1).toLowerCase(), local = h.from.slice(0, Math.max(at, 0)).toLowerCase();
  const prec = (h.precedence ?? '').trim().toLowerCase(), automated = AUTOMATED.some((a) => local.includes(a));
  const tests: Record<Tab, boolean> = {
    social: SOCIAL.some((d) => domain === d || domain.endsWith('.' + d)),
    forums: !!h.listPost || !!h.mailman || prec === 'list' || FORUM_LISTS.some((d) => (h.listId ?? '').toLowerCase().includes(d)),
    promotions: (prec === 'bulk' || !!h.listUnsubscribe) && !automated,
    updates: !!h.listUnsubscribe || !!h.listId || automated,
  };
  return SORT_ORDER.find((k) => tabs.includes(k) && tests[k]) ?? null;
}

export const SCRIPT_NAME = 'openmail';
const MARK = '# openmail-rules: ';

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const list = (a: readonly string[]) => `[${a.map(q).join(', ')}]`;

type Tr = (k: Key, v?: Vars) => string;
/** The script is data, not interface: its comments stay English whatever language is on screen. */
const english: Tr = (k, v) => (en[k] as string).replace(/\{(\w+)\}/g, (all, n: string) => (v && n in v ? String(v[n]) : all));

export function describeRule(r: Rule, tr: Tr = t): string {
  const when = [r.from && tr(r.fromExact ? 'rules.fromIs' : 'rules.fromContains', { value: r.from }), r.to && tr('rules.toContains', { value: r.to }),
    r.subject && tr('rules.subjectContains', { value: r.subject })].filter(Boolean).join(tr('rules.and')) || tr('rules.every');
  const then = {
    move: () => tr('rules.move', { folder: r.folder ?? '' }), read: () => tr('rules.read'), star: () => tr('rules.star'), trash: () => tr('rules.trash'),
    block: () => tr('rules.block'), forward: () => tr('rules.forward', { address: r.forwardTo ?? '' }),
  }[r.action]();
  return tr('rules.if', { when, then });
}

/**
 * Would this rule have caught this message? The same tests the server runs (toSieve below): "contains", ignoring
 * case, on the sender's address, the recipients' addresses and the subject; every filled-in field must match.
 * For the "try it on your recent mail" preview, so a filter can be checked before it is saved.
 */
export function matchesRule(r: Pick<Rule, 'from' | 'fromExact' | 'to' | 'subject'>,
  m: { from?: { email: string }[] | null; to?: { email: string }[] | null; cc?: { email: string }[] | null; subject?: string | null }): boolean {
  const has = (list: { email: string }[] | null | undefined, part: string) => !!list?.some((a) => a.email.toLowerCase().includes(part));
  const from = r.from?.trim().toLowerCase(), to = r.to?.trim().toLowerCase(), subject = r.subject?.trim().toLowerCase();
  if (!from && !to && !subject) return false; // an empty rule is not a rule
  if (from && !(r.fromExact ? !!m.from?.some((a) => a.email.toLowerCase() === from) : has(m.from, from))) return false;
  if (to && !has(m.to, to) && !has(m.cc, to)) return false;
  if (subject && !(m.subject ?? '').toLowerCase().includes(subject)) return false;
  return true;
}

export function validateRule(r: Rule): string | null {
  if (!r.from?.trim() && !r.to?.trim() && !r.subject?.trim()) return t('rules.needCondition');
  if (r.action === 'move' && !r.folder) return t('rules.needFolder');
  if (r.action === 'forward' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.forwardTo ?? '')) return t('rules.needAddress');
  return null;
}

/** Folder names on this server for the delete and block actions. Blocked mail goes to Junk, never silently lost. */
export function toSieve(data: ScriptData, folders: { trash: string; junk: string }): string {
  const { rules, vacation } = data;
  const lines = [MARK + JSON.stringify(data), 'require ["fileinto", "imap4flags", "mailbox", "copy", "vacation", "date", "relational", "spamtest", "body"];', ''];
  // Before the tabs: a receipt with an unsubscribe link is still a receipt (Updates), not an advert.
  lines.push('# Purchases and trips: orders, deliveries and bookings that carry schema.org data',
    `if body :content "text/html" :contains ${list(PURCHASE_MARKS)} { addflag ${q(PURCHASE)}; }`, '');
  if (data.categories !== false) {
    // One tab per message, first match wins; a tab that's switched off lets its mail fall through to the next one.
    // People stay in Primary. ponytail: header heuristics, no learning; Gmail's model sorts the borderline cases better.
    const tabs = data.tabs ?? ['updates'];
    const tests: Record<Tab, string> = {
      social: `address :domain :matches "from" ${list(SOCIAL.flatMap((d) => [d, `*.${d}`]))}`,
      forums: `anyof(exists "list-post", exists "x-mailman-version", header :is "precedence" "list", header :contains "list-id" ${list(FORUM_LISTS)})`,
      promotions: `allof(not hasflag ${q(PURCHASE)}, anyof(header :is "precedence" "bulk", exists "list-unsubscribe"), not address :localpart :contains "from" ${list(AUTOMATED)})`,
      updates: `anyof(exists "list-unsubscribe", exists "list-id", address :localpart :contains "from" ${list(AUTOMATED)})`,
    };
    const on = SORT_ORDER.filter((k) => tabs.includes(k));
    if (on.length) lines.push('# Inbox categories: social networks, discussion lists, marketing, other automated mail',
      on.map((k, i) => `${i ? 'elsif' : 'if'} ${tests[k]} { addflag ${q(tabKeyword(k))}; }`).join('\n'), '');
  }
  // Order: blocks first (no auto-reply to blocked senders), then the out-of-office reply, then everything else.
  const ordered = [...rules.filter((r) => r.action === 'block'), ...rules.filter((r) => r.action !== 'block')];
  let vacationDone = false;
  const emitVacation = () => {
    if (vacationDone || !vacation.enabled) return;
    vacationDone = true;
    const dates = [vacation.from && `currentdate :value "ge" "date" ${q(vacation.from.slice(0, 10))}`,
      vacation.to && `currentdate :value "le" "date" ${q(vacation.to.slice(0, 10))}`].filter(Boolean);
    const reply = `vacation :days 1 :subject ${q(vacation.subject || 'Out of office')} ${q(vacation.body || 'I’m away and will reply when I’m back.')};`;
    lines.push('# Out-of-office reply', dates.length ? `if allof(${dates.join(', ')}) { ${reply} }` : reply, '');
  };
  for (const r of ordered) {
    if (r.action !== 'block') emitVacation();
    if (validateRule(r)) continue; // never emit a half-made rule
    const tests: string[] = [];
    if (r.from?.trim()) tests.push(`address ${r.fromExact ? ':is' : ':contains'} "from" ${q(r.from.trim())}`);
    if (r.to?.trim()) tests.push(`address :contains ["to", "cc"] ${q(r.to.trim())}`);
    if (r.subject?.trim()) tests.push(`header :contains "subject" ${q(r.subject.trim())}`);
    const body = {
      move: () => `fileinto :create ${q(r.folder!)}; stop;`,
      read: () => 'addflag "\\\\Seen";',
      star: () => 'addflag "\\\\Flagged";',
      trash: () => `fileinto ${q(folders.trash)}; stop;`,
      block: () => `fileinto ${q(folders.junk)}; addflag "\\\\Seen"; stop;`,
      forward: () => `redirect :copy ${q(r.forwardTo!)};`,
    }[r.action]();
    lines.push(`# ${describeRule(r, english).replace(/\n/g, ' ')}`, `if allof(${tests.join(', ')}) { ${body} }`, '');
  }
  emitVacation();
  if (data.screener?.on) {
    // After your own filters (they win), so a filter for a new sender still applies.
    // ponytail: the allow list lives in the script (twice: JSON marker + test). Ceiling ~1,500 senders before
    // Stalwart's default script size limit; upgrade to a server-side address-book lookup if people need more.
    const allow = [...new Set(data.screener.allow.map((a) => a.trim().toLowerCase()).filter(isAddress))];
    lines.push('# Screener: first-time senders wait until you approve them',
      // Spam stays Stalwart's job (Junk), not the Screener's. spamtest (RFC 5235) asks the server for its own
      // verdict, so a sender can't skip the Screener by adding a fake X-Spam-Status header. Unscanned mail is 0.
      `if allof(not spamtest :value "ge" :comparator "i;ascii-numeric" "6"${allow.length ? `, not address :is "from" [${allow.map(q).join(', ')}]` : ''}) { fileinto :create ${q(SCREENER)}; stop; }`, '');
  }
  return lines.join('\n');
}

export function parseScript(script: string): ScriptData {
  const line = script.split('\n').find((l) => l.startsWith(MARK));
  try {
    const data = line ? JSON.parse(line.slice(MARK.length)) : null;
    if (Array.isArray(data)) return { rules: data, vacation: { enabled: false } }; // first format: rules only
    return { ...data, rules: data?.rules ?? [], vacation: data?.vacation ?? { enabled: false } };
  } catch { return { rules: [], vacation: { enabled: false } }; }
}
export const parseRules = (script: string) => parseScript(script).rules;
