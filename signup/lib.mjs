// Pure logic for the signup service: validation, rate limiting, invite codes.
// No I/O except the optional invite file, so it is easy to unit test.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export const RESERVED = new Set([
  'abuse', 'admin', 'administrator', 'api', 'autoconfig', 'autodiscover', 'billing', 'contact',
  'daemon', 'dkim', 'dmarc', 'ftp', 'help', 'helpdesk', 'hostmaster', 'imap', 'info', 'jmap', 'legal',
  'mail', 'mailer-daemon', 'mailerdaemon', 'marketing', 'mx', 'news', 'nobody', 'noc', 'noreply',
  'no-reply', 'null', 'openmail', 'owner', 'pop', 'pop3', 'postmaster', 'privacy', 'root', 'sales',
  'security', 'smtp', 'spam', 'ssl-admin', 'staff', 'status', 'support', 'sysadmin', 'system', 'team',
  'test', 'usenet', 'uucp', 'webmaster', 'www',
]);
// "no.reply" and "post-master" should be just as reserved as "noreply" and "postmaster".
const squash = (s) => s.replace(/[.-]/g, '');
const RESERVED_SQUASHED = new Set([...RESERVED].map(squash));

/** Returns { code, message, field } for an invalid username, or null if fine. Expects an already lowercased string. */
export function checkUsername(u, extraReserved = []) {
  const bad = (code, message) => ({ code, message, field: 'username' });
  if (typeof u !== 'string' || u === '') return bad('username_required', 'Please choose a username.');
  if (u.length < 3) return bad('username_too_short', 'Your username needs at least 3 characters.');
  if (u.length > 32) return bad('username_too_long', 'Your username can have at most 32 characters.');
  if (!/^[a-z0-9.-]+$/.test(u))
    return bad('username_invalid_chars', 'Use only lowercase letters (a-z), digits (0-9), dots and hyphens.');
  if (u.startsWith('.') || u.endsWith('.') || u.includes('..'))
    return bad('username_bad_dots', "A username can't start or end with a dot, or have two dots in a row.");
  if (u.startsWith('-') || u.endsWith('-'))
    return bad('username_bad_hyphen', "A username can't start or end with a hyphen.");
  if (RESERVED_SQUASHED.has(squash(u)) || extraReserved.some((r) => squash(r) === squash(u))) return bad('username_reserved', 'That username is reserved. Please pick another one.');
  return null;
}

/** Returns { code, message, field } for an unacceptable password, or null. */
export function checkPassword(p, username) {
  const bad = (code, message) => ({ code, message, field: 'password' });
  if (typeof p !== 'string' || p === '') return bad('password_required', 'Please choose a password.');
  if (p.length < 12) return bad('password_too_short', 'Your password needs at least 12 characters. A few random words work well.');
  if (p.length > 128) return bad('password_too_long', 'Your password can have at most 128 characters.');
  if (typeof username === 'string' && username.length >= 3 && p.toLowerCase().includes(username.toLowerCase()))
    return bad('password_contains_username', "Your password can't contain your username. Please choose a different one.");
  return null;
}

// ponytail: fixed-window counters in one process's memory. Ceiling: a single instance; counts reset on
// restart and aren't shared between replicas; memory grows with distinct IPs per window (swept when >10k keys).
// Upgrade path: move the counters to Redis (INCR + EXPIRE) or rate-limit at the reverse proxy / Cloudflare.
export class RateLimiter {
  constructor(limit, windowMs, now = Date.now) {
    Object.assign(this, { limit, windowMs, now, hits: new Map() });
  }
  /** The current window for a key (pass it to refund so a refund can't land in a later window). */
  window(key) { return this.hits.get(key); }
  /** Give back one hit (an attempt that turned out fine), only to the window it was taken from. */
  refund(key, window) {
    const e = this.hits.get(key);
    if (e && e === window && e.resetAt > this.now() && e.count > 0) e.count--;
  }
  /** Like take() but doesn't count: 0 if the key may still try, else seconds until it may. */
  peek(key) {
    const e = this.hits.get(key), t = this.now();
    return e && e.resetAt > t && e.count >= this.limit ? Math.ceil((e.resetAt - t) / 1000) : 0;
  }
  /** Counts one hit. Returns 0 if allowed, else seconds until the key may try again. */
  take(key) {
    const t = this.now();
    if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    let e = this.hits.get(key);
    if (!e || e.resetAt <= t) this.hits.set(key, (e = { count: 0, resetAt: t + this.windowMs }));
    if (e.count >= this.limit) return Math.ceil((e.resetAt - t) / 1000);
    e.count++;
    return 0;
  }
}

/** Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one customer usually gets a whole /64). */
export function ipKey(ip = '') {
  ip = ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
  if (!ip.includes(':')) return ip;
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Parses "code" or "code:uses" entries separated by commas or newlines. A bare code is good for 1 use. */
export function parseInvites(text = '') {
  const m = new Map();
  for (const item of text.split(/[,\n]/)) {
    const [code, uses] = item.trim().split(':');
    if (code) m.set(code, uses === undefined ? 1 : Math.max(0, parseInt(uses, 10) || 0));
  }
  return m;
}

/**
 * Invite codes with remaining-use counts. Uses are reserved before the account is created and refunded
 * if creation fails, so two concurrent requests can't both spend the last use.
 * With a file, the remaining counts are written back after every change, so restarts don't refill codes.
 */
export class Invites {
  constructor({ text = '', file = null } = {}) {
    this.file = file;
    this.codes = file ? parseInvites(readFileSync(file, 'utf8')) : parseInvites(text);
  }
  reserve(code) {
    const left = typeof code === 'string' ? this.codes.get(code.trim()) : undefined;
    if (!left) return false;
    this.codes.set(code.trim(), left - 1);
    this.save();
    return true;
  }
  refund(code) {
    this.codes.set(code.trim(), (this.codes.get(code.trim()) ?? 0) + 1);
    this.save();
  }
  save() {
    if (!this.file) return;
    const tmp = this.file + '.tmp';
    writeFileSync(tmp, [...this.codes].map(([c, n]) => `${c}:${n}`).join('\n') + '\n');
    renameSync(tmp, this.file);
  }
}
