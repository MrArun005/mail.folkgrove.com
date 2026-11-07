// Filters ("rules") as data, compiled to a Sieve script (RFC 5228) that the mail server runs on delivery.
// The rules are also stored inside the script as a JSON comment, so the app can read them back exactly.

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
  savedSearches?: { name: string; query: string }[];
  /** Named signatures; sigNew/sigReply pick one by name ('' = none, missing = the first). */
  signatures?: { name: string; text: string }[];
  sigNew?: string;
  sigReply?: string;
  /** HEY-style Screener: mail from anyone not on `allow` waits in the Screener folder until approved. */
  screener?: { on: boolean; allow: string[] };
  /** Shared folders or mailboxes hidden from "Shared with me": "accountId" or "accountId/mailboxId". */
  hiddenShares?: string[];
}
export const SCREENER = 'Screener';
const isAddress = (a: string) => /^[^\s@"\\]+@[^\s@"\\]+\.[^\s@"\\]+$/.test(a);
export const UPDATES = '$updates';

export const SCRIPT_NAME = 'openmail';
const MARK = '# openmail-rules: ';

const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export function describeRule(r: Rule): string {
  const when = [r.from && (r.fromExact ? `from is “${r.from}”` : `from contains “${r.from}”`), r.to && `to contains “${r.to}”`, r.subject && `subject contains “${r.subject}”`]
    .filter(Boolean).join(' and ') || 'every message';
  const then = { move: `move to ${r.folder}`, read: 'mark as read', star: 'star it', trash: 'delete it', block: 'block it (send to Junk)', forward: `forward to ${r.forwardTo}` }[r.action];
  return `If ${when}, ${then}`;
}

export function validateRule(r: Rule): string | null {
  if (!r.from?.trim() && !r.to?.trim() && !r.subject?.trim()) return 'Add at least one condition (from, to or subject).';
  if (r.action === 'move' && !r.folder) return 'Choose a folder to move messages to.';
  if (r.action === 'forward' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.forwardTo ?? '')) return 'Enter a valid address to forward to.';
  return null;
}

/** Folder names on this server for the delete and block actions. Blocked mail goes to Junk, never silently lost. */
export function toSieve(data: ScriptData, folders: { trash: string; junk: string }): string {
  const { rules, vacation } = data;
  const lines = [MARK + JSON.stringify(data), 'require ["fileinto", "imap4flags", "mailbox", "copy", "vacation", "date", "relational", "spamtest"];', ''];
  if (data.categories !== false) {
    // Mailing lists, newsletters and automated senders go to the Updates tab; people stay in Primary.
    lines.push('# Inbox categories: newsletters and notifications → Updates',
      `if anyof(exists "list-unsubscribe", exists "list-id", address :localpart :contains "from" ["noreply", "no-reply", "donotreply", "notifications", "mailer-daemon"]) { addflag ${q(UPDATES)}; }`, '');
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
    lines.push(`# ${describeRule(r).replace(/\n/g, ' ')}`, `if allof(${tests.join(', ')}) { ${body} }`, '');
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
