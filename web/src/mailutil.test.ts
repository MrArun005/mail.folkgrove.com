// @vitest-environment happy-dom
import { expect, it } from 'vitest';
import type { EmailFull } from './jmap';
import { cleanHtml, draftFor, htmlToText, parseAddresses, textToHtml } from './mailutil';

it('parses address lists and flags junk', () => {
  expect(parseAddresses('Ann Lee <ann@x.org>, bob@y.org; "Cee" <c@z.io>, nope, ')).toEqual({
    list: [{ name: 'Ann Lee', email: 'ann@x.org' }, { name: null, email: 'bob@y.org' }, { name: 'Cee', email: 'c@z.io' }],
    invalid: ['nope'],
  });
});

it('cleanHtml keeps formatting, drops anything active or tracking', () => {
  const dirty = `<p style="color:red" onclick="x()">Hi <b>there</b> <a href="javascript:alert(1)">bad</a> <a href="https://ok.org" target="_top">ok</a></p>
    <script>alert(1)</script><img src="https://t.example/pixel.gif" onerror="x()"><iframe src="https://evil"></iframe>
    <table><tr><td>cell</td></tr></table><style>body{display:none}</style>`;
  const out = cleanHtml(dirty);
  expect(out).toContain('<p>Hi <b>there</b> <a>bad</a> <a href="https://ok.org" rel="noopener noreferrer">ok</a></p>');
  expect(out).toContain('cell'); // unknown tags unwrapped, text kept
  for (const bad of ['script', 'onclick', 'onerror', 'javascript:', 'img', 'iframe', 'style', 'target']) expect(out).not.toContain(bad);
});

it('htmlToText makes a readable plain-text alternative', () => {
  expect(htmlToText('<p>Hello <b>Ann</b></p><ul><li>one</li><li>two</li></ul><blockquote><p>old line</p></blockquote>'))
    .toBe('Hello Ann\n\n- one\n\n- two\n\n> old line');
  expect(htmlToText(textToHtml('a < b\nnext'))).toBe('a < b\nnext');
});

const mail = (over: Partial<EmailFull>): EmailFull => ({
  id: '1', threadId: 't', subject: 'Lunch', preview: '', receivedAt: '2026-11-07T12:00:00Z', keywords: {}, hasAttachment: false,
  from: [{ name: 'Carol', email: 'carol@x.org' }], to: [{ name: null, email: 'me@o.test' }, { name: null, email: 'dan@x.org' }],
  cc: [{ name: null, email: 'eve@x.org' }], replyTo: null, messageId: ['m1@x'], inReplyTo: null, references: ['m0@x'],
  blobId: 'b0', mailboxIds: {}, attachments: [], unsubscribe: null, receiptTo: null, html: null, text: 'hi <there>', ...over,
});

it('reply goes to the sender, threads correctly and quotes (escaped)', () => {
  const d = draftFor('reply', mail({}), 'me@o.test');
  expect(d.to).toEqual([{ name: 'Carol', email: 'carol@x.org' }]);
  expect(d.cc).toEqual([]);
  expect(d.subject).toBe('Re: Lunch');
  expect(d.inReplyTo).toEqual(['m1@x']);
  expect(d.references).toEqual(['m0@x', 'm1@x']);
  expect(d.html).toContain('<blockquote><div>hi &#60;there&#62;</div></blockquote>');
});

it('reply all adds everyone except me, without duplicates', () => {
  const d = draftFor('replyAll', mail({ cc: [{ name: null, email: 'eve@x.org' }, { name: null, email: 'CAROL@x.org' }] }), 'ME@o.test');
  expect(d.to.map((a) => a.email)).toEqual(['carol@x.org']);
  expect(d.cc.map((a) => a.email)).toEqual(['dan@x.org', 'eve@x.org']);
});

it('replying to my own sent message goes to its recipients; Re: is not doubled', () => {
  const d = draftFor('reply', mail({ from: [{ name: null, email: 'me@o.test' }], subject: 'RE: Lunch' }), 'me@o.test');
  expect(d.to.map((a) => a.email)).toEqual(['dan@x.org']);
  expect(d.subject).toBe('RE: Lunch');
});

it('replying to a note to self goes back to me', () => {
  const d = draftFor('reply', mail({ from: [{ name: null, email: 'me@o.test' }], to: [{ name: null, email: 'me@o.test' }], cc: [] }), 'me@o.test');
  expect(d.to).toEqual([{ name: null, email: 'me@o.test' }]);
});

it('forward has no recipients, carries the original and its files', () => {
  const file = { blobId: 'b', name: 'a.pdf', type: 'application/pdf', size: 3, disposition: 'attachment' };
  const d = draftFor('forward', mail({ attachments: [file, { ...file, blobId: 'i', disposition: 'inline', cid: 'x' }] }), 'me@o.test');
  expect(d.to).toEqual([]);
  expect(d.subject).toBe('Fwd: Lunch');
  expect(d.html).toContain('From: Carol &#60;carol@x.org&#62;');
  expect(d.attachments.map((a) => a.blobId)).toEqual(['b']);
});

it('unsubscribe never targets private hosts and never takes the subject from the header', async () => {
  const { unsubscribePlan } = await import('./mailutil');
  expect(unsubscribePlan({ urls: ['https://list.example.com/u?x=1', 'mailto:u@list.example.com'], oneClick: true }))
    .toEqual({ kind: 'post', url: 'https://list.example.com/u?x=1', host: 'list.example.com' });
  // Private / local targets are refused for the silent POST; falls back to the mailto.
  for (const bad of ['https://192.168.1.1/reset', 'https://localhost/x', 'https://router.local/x', 'https://[::1]/x', 'http://list.example.com/u'])
    expect(unsubscribePlan({ urls: [bad, 'mailto:u@list.example.com?subject=Wire%20money'], oneClick: true })).toEqual({ kind: 'mail', to: 'u@list.example.com' });
  expect(unsubscribePlan({ urls: ['https://list.example.com/u'], oneClick: false })).toEqual({ kind: 'open', url: 'https://list.example.com/u', host: 'list.example.com' });
  expect(unsubscribePlan({ urls: ['javascript:alert(1)', 'mailto:not-an-address'], oneClick: true })).toBeNull();
});

it('editor HTML keeps embedded (cid:) images but never remote ones', () => {
  const out = cleanHtml('<p>Map:</p><img src="cid:map@x" alt="Route" onerror="x()"><img src="https://tracker.example/p.gif"><img src="blob:http://localhost/abc" data-cid="map@x">');
  expect(out).toContain('<img src="cid:map@x" alt="Route">');
  expect(out).toContain('<img src="blob:http://localhost/abc" data-cid="map@x">');
  expect(out).not.toContain('tracker.example');
  expect(out).not.toContain('onerror');
});

it('replies and forwards carry the inline images their quoted text shows', () => {
  const map = { blobId: 'm', name: 'map.svg', type: 'image/svg+xml', size: 9, disposition: 'inline', cid: 'map@x' };
  const unused = { ...map, blobId: 'u', cid: 'unused@x' };
  const e = mail({ html: '<p>Route:</p><img src="cid:map@x">', attachments: [map, unused] });
  expect(draftFor('reply', e, 'me@o.test').attachments.map((a) => a.blobId)).toEqual(['m']);
  expect(draftFor('forward', e, 'me@o.test').attachments.map((a) => a.blobId)).toEqual(['m']);
  expect(draftFor('forward', e, 'me@o.test').html).toContain('src="cid:map@x"');
});

it('builds a standard read receipt (MDN) and encodes non-ASCII subjects', async () => {
  const { buildMdn, encodeHeader } = await import('./mailutil');
  const m = buildMdn({ from: 'alice@o.test', to: 'priya@x.org', subject: 'Offsite plan', originalMessageId: 'm1@x', readAt: new Date('2026-11-07T12:00:00Z'), domain: 'o.test', id: 'r1' });
  expect(m).toMatch(/Content-Type: multipart\/report; report-type=disposition-notification; boundary="mdn-[0-9a-f-]{36}"/);
  expect(m).toContain('Subject: Read: Offsite plan');
  expect(m).toContain('Original-Message-ID: <m1@x>');
  expect(m).toContain('Disposition: manual-action/MDN-sent-manually; displayed');
  expect(m).toContain('Auto-Submitted: auto-replied'); // so it never triggers out-of-office loops
  expect(m.trimEnd()).toMatch(/--mdn-[0-9a-f-]{36}--$/);
  expect(encodeHeader('Read: Café plan')).toBe('=?UTF-8?B?UmVhZDogQ2Fmw6kgcGxhbg==?=');
  expect(encodeHeader('plain')).toBe('plain');
});

it('a hostile subject or Message-ID cannot inject headers or MIME parts into a receipt', async () => {
  const { buildMdn } = await import('./mailutil');
  const m = buildMdn({ from: 'alice@o.test', to: 'priya@x.org', readAt: new Date(), domain: 'o.test', id: 'r2',
    subject: 'Hi\r\nBcc: victim@evil.example\r\n\r\n--mdn\r\nContent-Type: text/html\r\n\r\n<script>x</script>',
    originalMessageId: 'a@b>\r\nX-Evil: 1' });
  const headers = m.split('\r\n\r\n')[0];
  expect(headers).not.toMatch(/^Bcc:/im);
  expect(m).not.toMatch(/^X-Evil/im);
  expect(m).not.toContain('Original-Message-ID'); // malformed IDs are dropped, not trusted
  expect(m.split('\r\n').filter((l) => /^--mdn-/.test(l))).toHaveLength(3); // only our own boundaries
  expect(() => buildMdn({ from: 'alice@o.test', to: 'x@y.z\r\nBcc: a@b.c', subject: 's', readAt: new Date(), domain: 'o.test', id: 'r3' })).toThrow();
});
