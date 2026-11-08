// Inbox tabs and the "Purchases & trips" keyword, sorted by the real server's Sieve on delivery (local dev server).
// Skips without it or deploy/.dev-admin.json (or ADMIN_FILE). Uses a throwaway t-smarts-* account, deleted after.
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { Jmap } from './jmap';
import { saveScript } from './Filters';
import { PURCHASE } from './rules';

const BASE = 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE ?? new URL('../../deploy/.dev-admin.json', import.meta.url).pathname;
const up = existsSync(ADMIN_FILE) && await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }).then(() => true, () => false);
const admin = up ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) : null;
const adminJmap = async (methodCalls: unknown[]) => (await (await fetch(`${BASE}/jmap/`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${admin.user}:${admin.pass}`) },
  body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
const made: string[] = [];
afterAll(async () => { if (made.length) await adminJmap([['x:Account/set', { destroy: made }, 'x']]); });

async function deliver(to: string, from: string, subject: string, headers: string, html?: string) {
  const net = await import('node:net');
  const body = html ? `Content-Type: text/html; charset=utf-8\r\n\r\n${html}` : 'Content-Type: text/plain; charset=utf-8\r\n\r\nHello there.';
  await new Promise<void>((ok, fail) => {
    const lines = ['EHLO test.example.org', `MAIL FROM:<${from}>`, `RCPT TO:<${to}>`, 'DATA',
      `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${Math.random()}@example.org>\r\nMIME-Version: 1.0\r\n${headers}${body}\r\n.`, 'QUIT'];
    const sock = net.connect(2525, 'localhost');
    let i = 0;
    sock.on('data', (d: Buffer) => { if (/^[45]/m.test(d.toString())) fail(new Error(d.toString())); if (i < lines.length) sock.write(lines[i++] + '\r\n'); });
    sock.on('close', () => ok()); sock.on('error', fail);
  });
}

describe.skipIf(!up)('inbox tabs on the real server', () => {
  it('sorts Social, Forums, Promotions, Updates and marks purchases on delivery', async () => {
    const domainId = (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d: { name: string }) => d.name === 'openmail.test').id;
    const name = `t-smarts-${Math.random().toString(36).slice(2, 8)}`, pass = 'throwaway passphrase 42';
    const r = await adminJmap([['x:Account/set', { create: { n: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: pass } } } } }, 'c']]);
    made.push(r.created.n.id);
    const me = `${name}@openmail.test`, c = await Jmap.login(me, pass, BASE);
    await saveScript(c, await c.mailboxes(), (d) => ({ ...d, categories: true, tabs: ['promotions', 'social', 'updates', 'forums'] }));

    const order = '<html><head><script type="application/ld+json">{"@context":"https://schema.org","@type":"Order","orderNumber":"112-1"}</script></head><body>Thanks</body></html>';
    await deliver(me, 'notification@facebookmail.com', 'social', 'List-Unsubscribe: <https://facebook.com/u>\r\n');
    await deliver(me, 'list@lists.example.org', 'forums', 'List-Id: <dev.lists.example.org>\r\nList-Post: <mailto:dev@lists.example.org>\r\n');
    await deliver(me, 'deals@shop.example', 'promotions', 'Precedence: bulk\r\nList-Unsubscribe: <https://shop.example/u>\r\n');
    await deliver(me, 'noreply@bank.example', 'updates', '');
    await deliver(me, 'orders@shop.example', 'purchase', 'List-Unsubscribe: <https://shop.example/u>\r\n', order);
    await deliver(me, 'ann@example.org', 'person', '');

    let got: Record<string, Record<string, boolean>> = {};
    for (let i = 0; i < 60 && Object.keys(got).length < 6; i++) {
      await new Promise((ok) => setTimeout(ok, 250));
      got = Object.fromEntries((await c.threads({})).map((e) => [e.subject ?? '', e.keywords]));
    }
    expect(got.social.$social).toBe(true);
    expect(got.forums.$forums).toBe(true);
    expect(got.promotions.$promotions).toBe(true);
    expect(got.updates.$updates).toBe(true);
    expect(got.purchase[PURCHASE]).toBe(true);
    expect(got.purchase.$updates).toBe(true); // a receipt is not an advert, unsubscribe link or not
    expect(Object.keys(got.person).filter((k) => /^\$(social|forums|promotions|updates|purchase)$/.test(k))).toEqual([]); // people: Primary
    // The "Purchases & trips" chip finds it.
    const { parseSearch } = await import('./search');
    expect((await c.threads(parseSearch('is:purchase'))).map((e) => e.subject)).toEqual(['purchase']);
  }, 30_000);
});
