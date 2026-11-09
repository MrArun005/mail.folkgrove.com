// Audit log for the admin console: one line of JSON per change an administrator makes through /api/admin/*
// (admin.mjs writes it in the one place every admin request passes through). A line says who, what, to whom, when
// and how it ended: { at, admin, ip, action, target, detail?, outcome }.
//
// Never in here: passwords (the ones the console generates included), sign-in tokens, request bodies, subjects or
// message text. admin.mjs passes only names, addresses, ids and numbers it picked out itself.
//
// Append-only: lines are only ever added, never rewritten. Bounded by rotation: once AUDIT_FILE holds `max` lines
// (AUDIT_MAX_ENTRIES, 10,000 by default) it is renamed to AUDIT_FILE.1, replacing the previous .1, and a new file
// starts. So the last 10,000 to 20,000 changes are kept, in a few MB.
// ponytail: an administrator can still fill the log to push old lines out, and nothing stops whoever has the disk
// from editing it. A tamper-evident trail means shipping these lines elsewhere (the service log carries them too).
import { appendFileSync, existsSync, readFileSync, renameSync } from 'node:fs';

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
const parse = (line) => { try { return JSON.parse(line); } catch { return null; } }; // a torn last line (crash mid-write) is skipped

export function auditLog(file, { max = 10_000 } = {}) {
  if (!file) console.warn('audit: AUDIT_FILE is not set; the admin audit log is only kept until restart');
  const mem = []; // without a file
  let count = file ? lines(file).length : 0; // lines in the current file

  return {
    /** Add one entry. Never throws: the change it describes has already happened, and the caller logs it as well. */
    record(entry) {
      try {
        if (!file) { mem.push(entry); if (mem.length >= 2 * max) mem.splice(0, max); return; }
        if (count >= max) { renameSync(file, `${file}.1`); count = 0; }
        appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
        count++;
      } catch (e) { console.error('audit: couldn’t write the audit log:', e.message); }
    },
    /** Newest first: `limit` entries after skipping `offset`, and how many there are in all. */
    list({ offset = 0, limit = 50 } = {}) {
      // ponytail: reads the whole file (and the rotated one when the page reaches into it) per request; a few MB,
      // admins only. Past that, read backwards from the end.
      const cur = file ? lines(file) : mem, old = file ? lines(`${file}.1`) : [];
      const all = offset + limit > cur.length ? [...old, ...cur] : cur;
      const page = all.slice(Math.max(0, all.length - offset - limit), Math.max(0, all.length - offset)).reverse();
      return { entries: (file ? page.map(parse).filter(Boolean) : page), total: cur.length + old.length };
    },
  };
}
