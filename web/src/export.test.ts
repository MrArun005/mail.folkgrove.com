// Export → import on the local dev server, with two throwaway accounts made through the admin API (never alice):
// every message comes back byte for byte in the same folders with the same stars and unread; contacts and calendar
// come out as vCard / iCalendar. Skips without the server or deploy/.dev-admin.json (or ADMIN_FILE).
import { readFileSync, existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { Jmap } from './jmap';
import { labelsFor, mboxEntry, mergeCalendars } from './exporter';
import { dropLabels, headerText, placement, splitMbox } from './importer';

const BASE = 'http://localhost:8080';
// Node's fetch (no CORS) plus happy-dom's XML parser, which doesn't know CDATA (browsers do): escape it first.
const Parser = new Window().DOMParser;
(globalThis as { DOMParser?: unknown }).DOMParser = class { parseFromString(s: string, t: string) {
  return new Parser().parseFromString(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;')), t as never);
} };
const ADMIN_FILE = process.env.ADMIN_FILE ?? new URL('../../deploy/.dev-admin.json', import.meta.url).pathname;
const up = existsSync(ADMIN_FILE) && await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }).then(() => true, () => false);

const admin = up ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) : null;
const adminJmap = async (methodCalls: unknown[]) => (await (await fetch(`${BASE}/jmap/`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${admin.user}:${admin.pass}`) },
  body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
const made: string[] = [];
async function throwaway(): Promise<Jmap> {
  const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d: { name: string }) => d.name === 'openmail.test').id;
  const name = `t-export-${Date.now().toString(36)}-${made.length}`;
  const r = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: 'throwaway passphrase 42' } } } } }, 'c']]);
  made.push(r.created.n.id);
  return Jmap.login(`${name}@openmail.test`, 'throwaway passphrase 42', BASE);
}
afterAll(async () => { if (made.length) await adminJmap([['x:Account/set', { destroy: made }, 'x']]); });

const enc = (s: string) => new TextEncoder().encode(s);
async function* once(b: Uint8Array) { yield b; }

describe.skipIf(!up)('export on the real server', () => {
  it('mail round-trips byte for byte with folders, stars and unread; contacts and calendar export', async () => {
    const src = await throwaway();
    let boxes = await src.mailboxes(true);
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const work = await src.folderPath('Work/Clients', new Map(), boxes);
    const raws = [
      enc('From: a@example.org\r\nTo: x@openmail.test\r\nSubject: one\r\nDate: Mon, 02 Nov 2026 10:00:00 +0000\r\nMessage-ID: <1@example.org>\r\n\r\nFrom the top\r\n>From quoted\r\n'),
      enc('From: b@example.org\r\nTo: x@openmail.test\r\nSubject: two\r\nDate: Tue, 03 Nov 2026 10:00:00 +0000\r\nMessage-ID: <2@example.org>\r\n\r\nsecond\r\n'),
    ];
    await src.importMessage(raws[0], [inbox], { $seen: true, $flagged: true });
    await src.importMessage(raws[1], [work], {});
    await src.saveContact({ given: 'Carol', surname: 'Diaz', emails: ['carol@example.org'], phones: [], org: '', note: '' });
    await src.saveEvent({ title: 'Review', start: '2026-11-10T09:30:00', timeZone: 'Europe/Berlin', duration: 'PT1H', allDay: false, location: '', description: '' } as never);

    boxes = await src.mailboxes(true);
    const page = await src.emailPage(0);
    expect(page.total).toBe(2);
    const parts = await Promise.all(page.list.map(async (e) => mboxEntry(await src.rawMessage(e.blobId), labelsFor(e.mailboxIds, e.keywords, boxes), new Date(e.receivedAt))));
    const file = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((o, p) => (file.set(p, o), o + p.length), 0);

    // Import into a fresh account the way Import.tsx does.
    const dst = await throwaway();
    const dboxes = await dst.mailboxes(true), known = new Map<string, string>();
    for await (const raw of splitMbox(once(file))) {
      const p = placement(headerText(raw));
      const ids = [...p.roles.map((r) => dboxes.find((b) => b.role === r)!.id)];
      for (const f of p.folders) ids.push(await dst.folderPath(f, known, dboxes));
      await dst.importMessage(dropLabels(raw), ids, p.keywords);
    }
    const back = await dst.emailPage(0);
    const after = await dst.mailboxes(true);
    const got = await Promise.all(back.list.map(async (e) => ({ raw: new TextDecoder().decode(await dst.rawMessage(e.blobId)), e })));
    for (const want of raws.map((r) => new TextDecoder().decode(r))) {
      const m = got.find((g) => g.raw === want);
      expect(m, 'same bytes after export → import').toBeTruthy();
      const where = Object.keys(m!.e.mailboxIds).map((id) => after.find((b) => b.id === id)!);
      if (want.includes('Subject: one')) { expect(where.map((b) => b.role)).toEqual(['inbox']); expect(m!.e.keywords).toMatchObject({ $seen: true, $flagged: true }); }
      else { expect(where.map((b) => b.path)).toEqual(['Work/Clients']); expect(m!.e.keywords.$seen).toBeUndefined(); }
    }

    const cards = await src.davObjects('card');
    expect(cards.join('')).toMatch(/BEGIN:VCARD[\s\S]*carol@example\.org/);
    const ics = mergeCalendars(await src.davObjects('cal'));
    expect(ics).toMatch(/BEGIN:VEVENT[\s\S]*SUMMARY:Review/);
  });
});
