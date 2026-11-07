// Integration check against the local dev server (node deploy/dev-setup.mjs). Skips if it isn't running.
import { describe, expect, it } from 'vitest';
import { Jmap } from './jmap';
import { parseSearch } from './search';

const BASE = 'http://localhost:8080';
const up = await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }).then(() => true, () => false);
const login = () => Jmap.login('alice@openmail.test', 'alice-dev-pass', BASE);
const ALICE = { name: null, email: 'alice@openmail.test' };

describe.skipIf(!up)('JMAP client vs local Stalwart', () => {
  it('rejects a wrong password', async () => {
    await expect(Jmap.login('alice@openmail.test', 'nope', BASE)).rejects.toThrow('Wrong email or password');
  });

  it('lists mailboxes and conversations, reads a thread, toggles read and star', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    expect(boxes[0].role).toBe('inbox');
    const welcome = (await c.threads({ inMailbox: boxes[0].id })).find((e) => e.subject === 'Welcome to OpenMail')!;
    expect(welcome).toBeTruthy();
    const [msg] = await c.thread(welcome.threadId);
    expect(msg.text).toContain('delivery and the web client both work');

    await c.setSeen(welcome.threadId, false);
    expect((await c.thread(welcome.threadId))[0].keywords.$seen).toBeUndefined();
    await c.setSeen(welcome.threadId, true);

    await c.setStarred(welcome.threadId, true);
    expect((await c.threads({ hasKeyword: '$flagged' })).some((e) => e.threadId === welcome.threadId)).toBe(true);
    await c.setStarred(welcome.threadId, false);
    expect((await c.threads({ hasKeyword: '$flagged' })).some((e) => e.threadId === welcome.threadId)).toBe(false);
  });

  it('search finds mail across folders', async () => {
    const c = await login();
    expect((await c.threads({ text: 'Friday' })).some((e) => e.subject?.includes('Lunch on Friday'))).toBe(true);
  });

  it('moves a conversation to Archive and back', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const archive = await c.mailboxFor('archive', 'Archive', boxes);
    const t = (await c.threads({ inMailbox: inbox })).find((e) => e.subject === 'Lunch on Friday?')!;
    await c.move(t.threadId, inbox, archive);
    expect((await c.threads({ inMailbox: archive })).some((e) => e.threadId === t.threadId)).toBe(true);
    expect((await c.threads({ inMailbox: inbox })).some((e) => e.threadId === t.threadId)).toBe(false);
    await c.move(t.threadId, archive, inbox);
    expect((await c.threads({ inMailbox: inbox })).some((e) => e.threadId === t.threadId)).toBe(true);
  });

  it('autosaved drafts replace each other and keep rich text + attachments', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const drafts = boxes.find((b) => b.role === 'drafts')!.id;
    const file = await c.upload(Object.assign(new Blob(['agenda'], { type: 'text/plain' }), { name: 'agenda.txt' }));
    const subject = `draft test ${Date.now()}`;
    const d = { to: [ALICE], cc: [], subject, html: '<p>Hi <b>there</b></p>', text: 'Hi there', attachments: [file] };
    const first = await c.saveDraft(d, boxes);
    const second = await c.saveDraft({ ...d, id: first, html: '<p>Hi <b>again</b></p>', text: 'Hi again' }, boxes);
    const mine = (await c.threads({ inMailbox: drafts })).filter((e) => e.subject === subject);
    expect(mine.map((e) => e.id)).toEqual([second]); // the first copy is gone

    const [saved] = await c.thread(mine[0].threadId);
    expect(saved.html).toContain('<b>again</b>');
    expect(saved.text).toContain('Hi again');
    expect(saved.attachments.map((a) => a.name)).toEqual(['agenda.txt']);
    expect(await (await c.download(saved.attachments[0])).text()).toBe('agenda');
    await c.deleteDraft(second);
  });

  it('undo send cancels delivery and returns the message to Drafts', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const subject = `undo test ${Date.now()}`;
    const { submissionId, emailId } = await c.send({ to: [ALICE], cc: [], subject, html: '<p>x</p>', text: 'x', attachments: [] }, boxes);
    await c.undoSend(submissionId, emailId, boxes);
    const drafts = boxes.find((b) => b.role === 'drafts')!.id;
    expect((await c.threads({ inMailbox: drafts })).some((e) => e.subject === subject)).toBe(true);
    await c.deleteDraft(emailId);
  });

  it('search operators run on the server', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const hits = await c.threads(parseSearch('from:priya has:attachment -subject:venue', boxes));
    expect(hits.map((e) => e.subject)).toContain('Offsite agenda and directions');
    expect(hits.some((e) => e.subject?.includes('Venue'))).toBe(false);
  });

  it('reads one-click unsubscribe headers when present', async () => {
    const c = await login();
    const t = (await c.threads({ text: 'Weekly digest' }))[0];
    const [m] = await c.thread(t.threadId);
    expect(m.unsubscribe).toEqual({ urls: ['https://example.org/unsub?u=alice', 'mailto:unsub@example.org'], oneClick: true });
  });

  it('schedules a message, lists it, and cancels it back to Drafts', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const subject = `scheduled ${Date.now()}`;
    const at = new Date(Date.now() + 3 * 86400e3);
    const { submissionId, emailId } = await c.send({ to: [ALICE], cc: [], subject, html: '<p>later</p>', text: 'later', attachments: [] }, boxes, at);
    const list = await c.scheduled();
    const mine = list.find((s) => s.submissionId === submissionId)!;
    expect(mine.email.subject).toBe(subject);
    expect(Math.abs(+new Date(mine.sendAt) - +at)).toBeLessThan(2000);
    await c.undoSend(submissionId, emailId, boxes);
    expect((await c.scheduled()).some((s) => s.submissionId === submissionId)).toBe(false);
    await c.deleteDraft(emailId);
  });

  it('snoozes a conversation and wakes it when due', async () => {
    const c = await login();
    let boxes = await c.mailboxes();
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const t = (await c.threads({ inMailbox: inbox })).find((e) => e.subject === 'Your November statement is ready')!;
    await c.snooze(t.threadId, inbox, new Date(Date.now() + 1000), boxes);
    boxes = await c.mailboxes();
    const snoozed = boxes.find((b) => b.role === 'snoozed')!.id;
    expect((await c.threads({ inMailbox: snoozed })).some((e) => e.threadId === t.threadId)).toBe(true);
    expect(await c.wakeSnoozed(boxes)).toBe(0); // not yet
    await new Promise((r) => setTimeout(r, 1500));
    await c.wakeSnoozed(boxes); // an open app tab may already have woken it (push → refresh); either way it must be back
    const back = (await c.threads({ inMailbox: inbox })).find((e) => e.threadId === t.threadId)!;
    expect(back.keywords.$seen).toBeUndefined(); // comes back unread, like Gmail
    expect(Object.keys(back.keywords).some((k) => k.startsWith('$snoozed-'))).toBe(false);
    await c.setSeen(t.threadId, true);
  });

  it('creates a folder and labels a conversation into it', async () => {
    const c = await login();
    const name = `Label ${Date.now()}`;
    const id = await c.createMailbox(name);
    const t = (await c.threads({ text: 'Lunch on Friday' }))[0];
    await c.addToMailbox(t.threadId, id);
    expect((await c.threads({ inMailbox: id })).length).toBe(1);
    await c.call([['Mailbox/set', { accountId: c.accountId, destroy: [id], onDestroyRemoveEmails: true /* the message stays in Inbox */ }, 'd']]);
  });

  it('updates display name and signature', async () => {
    const c = await login();
    await c.setIdentity({ name: 'Alice Test', textSignature: 'Alice\n-- sent with OpenMail' });
    expect((await c.getIdentityFresh()).name).toBe('Alice Test');
    await c.setIdentity({ name: '', textSignature: '' });
  });

  it('out-of-office and filters stay active together (one Sieve script)', async () => {
    const c = await login();
    const { toSieve, parseScript } = await import('./rules');
    const folders = { trash: 'Deleted Items', junk: 'Junk Mail' };
    const before = await c.getRules();
    await c.saveRules(toSieve({ rules: [{ id: '1', from: 'x@y.org', action: 'star' }],
      vacation: { enabled: true, from: '2026-01-01', to: '2099-01-01', subject: 'Away', body: 'Back soon' } }, folders), before.id);
    const [r] = await c.call([['SieveScript/get', { accountId: c.accountId, properties: ['name', 'isActive'] }, 'g']]);
    const active = (r.list as { name: string; isActive: boolean }[]).filter((x) => x.isActive).map((x) => x.name);
    expect(active).toEqual(['openmail']);
    const data = parseScript((await c.getRules()).script);
    expect(data.vacation.enabled).toBe(true);
    expect(data.rules).toHaveLength(1);
    // Put the account's own settings back (signatures, saved searches, categories live in this script too).
    await c.saveRules(before.script || toSieve({ rules: [], vacation: { enabled: false } }, folders), (await c.getRules()).id);
  });

  it('pushes a change notification when something changes', async () => {
    const c = await login();
    let changes = 0;
    const stop = c.watch(() => changes++);
    await new Promise((r) => setTimeout(r, 800)); // let the stream connect
    const t = (await c.threads({ text: 'Welcome to OpenMail' }))[0];
    await c.setStarred(t.threadId, true);
    for (let i = 0; i < 30 && !changes; i++) await new Promise((r) => setTimeout(r, 200));
    stop();
    await c.setStarred(t.threadId, false);
    expect(changes).toBeGreaterThan(0);
  });

  it('filters run on the server when mail arrives (Sieve)', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const { toSieve } = await import('./rules');
    const before = await c.getRules();
    const tag = `rules-${Date.now()}`;
    await c.saveRules(toSieve({ rules: [{ id: '1', subject: tag, action: 'move', folder: 'Rules Test' }], vacation: { enabled: false } }, { trash: 'Deleted Items', junk: 'Junk Mail' }), before.id);
    expect((await c.getRules()).script).toContain(tag);

    // Deliver a real message over SMTP and check where it lands.
    const net = await import('node:net');
    await new Promise<void>((ok, fail) => {
      const lines = ['EHLO test.example.org', 'MAIL FROM:<sender@example.org>', 'RCPT TO:<alice@openmail.test>', 'DATA',
        `From: sender@example.org\r\nTo: alice@openmail.test\r\nSubject: ${tag}\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${tag}@example.org>\r\n\r\nhello\r\n.`, 'QUIT'];
      const sock = net.connect(2525, 'localhost');
      let i = 0;
      sock.on('data', (d: Buffer) => { if (/^[45]/m.test(d.toString())) fail(new Error(d.toString())); if (i < lines.length) sock.write(lines[i++] + '\r\n'); });
      sock.on('close', () => ok()); sock.on('error', fail);
    });
    let landed: string | undefined;
    for (let i = 0; i < 40 && !landed; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const hit = (await c.threads({ text: tag }))[0];
      if (hit) { const [m] = await c.thread(hit.threadId); landed = (await c.mailboxes()).find((b) => m.mailboxIds[b.id])?.name; }
    }
    expect(landed, 'the message should have been filed by the rule').toBe('Rules Test');
    const folder = (await c.mailboxes()).find((b) => b.name === 'Rules Test')!;
    await c.deleteMailbox(folder.id);
    await c.saveRules(before.script || toSieve({ rules: [], vacation: { enabled: false } }, { trash: 'Deleted Items', junk: 'Junk Mail' }), before.id ?? (await c.getRules()).id);
    void boxes;
  }, 20_000);

  it('saves, lists and deletes templates; the Templates folder stays hidden', async () => {
    const c = await login();
    const subject = `Template ${Date.now()}`;
    await c.saveTemplate({ to: [ALICE], cc: [], subject, html: '<p>Thanks for reaching out — <b>here is our price list</b>.</p>', text: 'Thanks', attachments: [] });
    const t = (await c.templates()).find((x) => x.subject === subject)!;
    expect(t.html).toContain('<b>here is our price list</b>');
    expect((await c.mailboxes()).some((b) => b.name === 'Templates')).toBe(false);
    expect((await c.mailboxes(true)).some((b) => b.name === 'Templates')).toBe(true);
    await c.deleteTemplate(t.id);
    expect((await c.templates()).some((x) => x.id === t.id)).toBe(false);
  });

  it('forwarding keeps embedded images working for the recipient', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const orig = (await c.threads({ text: 'Offsite agenda and directions' })).find((e) => e.subject === 'Offsite agenda and directions')!;
    const [m] = await c.thread(orig.threadId);
    // What draftFor('forward') produces (unit-tested separately): the original HTML with its cid: image + all parts.
    const id = await c.saveDraft({ to: [ALICE], cc: [], subject: 'Fwd: ' + m.subject, html: m.html!, text: 'fwd', attachments: m.attachments }, boxes);
    const drafts = boxes.find((b) => b.role === 'drafts')!.id;
    const saved = (await c.threads({ inMailbox: drafts })).find((e) => e.id === id)!;
    const [copy] = await c.thread(saved.threadId);
    const inline = copy.attachments.find((a) => a.cid === 'map@seed')!;
    expect(inline, 'the image travels as an inline part with its Content-ID').toBeTruthy();
    expect(copy.html).toContain('cid:map@seed');
    expect(copy.attachments.filter((a) => !a.cid).map((a) => a.name).sort()).toEqual(['agenda.txt', 'budget.csv']);
    await c.deleteDraft(id);
  });

  it('Inbox categories: newsletters are tagged on delivery and by the backfill', async () => {
    const c = await login();
    const { toSieve } = await import('./rules');
    const boxes = await c.mailboxes();
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const before = await c.getRules();
    await c.saveRules(toSieve({ rules: [], vacation: { enabled: false } }, { trash: 'Deleted Items', junk: 'Junk Mail' }), before.id);

    // Backfill tags the seeded digest (it has List-Unsubscribe) and leaves people's mail alone.
    await c.tagUpdates(inbox);
    const updates = (await c.threads({ operator: 'AND', conditions: [{ inMailbox: inbox }, { hasKeyword: '$updates' }] })).map((e) => e.subject);
    const primary = (await c.threads({ operator: 'AND', conditions: [{ inMailbox: inbox }, { notKeyword: '$updates' }] })).map((e) => e.subject);
    expect(updates).toContain('Weekly digest: 5 tools we loved');
    expect(primary).toContain('Lunch on Friday?');
    expect(primary).not.toContain('Weekly digest: 5 tools we loved');

    // New mail is tagged by the server as it arrives.
    const tag = `list-${Date.now()}`;
    const net = await import('node:net');
    await new Promise<void>((ok, fail) => {
      const lines = ['EHLO test.example.org', 'MAIL FROM:<news@example.org>', 'RCPT TO:<alice@openmail.test>', 'DATA',
        `From: news@example.org\r\nTo: alice@openmail.test\r\nSubject: ${tag}\r\nList-Unsubscribe: <https://example.org/u>\r\nDate: ${new Date().toUTCString()}\r\nMessage-ID: <${tag}@example.org>\r\n\r\nhello\r\n.`, 'QUIT'];
      const sock = net.connect(2525, 'localhost');
      let i = 0;
      sock.on('data', (d: Buffer) => { if (/^[45]/m.test(d.toString())) fail(new Error(d.toString())); if (i < lines.length) sock.write(lines[i++] + '\r\n'); });
      sock.on('close', () => ok()); sock.on('error', fail);
    });
    let kw: Record<string, boolean> | undefined;
    for (let i = 0; i < 40 && !kw; i++) { await new Promise((r) => setTimeout(r, 250)); kw = (await c.threads({ text: tag }))[0]?.keywords; }
    expect(kw?.['$updates'], 'delivered newsletter carries the Updates keyword').toBe(true);
    await c.saveRules(before.script || toSieve({ rules: [], vacation: { enabled: false } }, { trash: 'Deleted Items', junk: 'Junk Mail' }), (await c.getRules()).id);
  }, 20_000);

  it('Bcc reaches the recipient without a Bcc header; the Sent copy keeps it', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const subject = `bcc ${Date.now()}`;
    await c.send({ to: [], cc: [], bcc: [{ name: null, email: 'alice@openmail.test' }], subject, html: '<div>x</div>', text: 'x', attachments: [] }, boxes);
    let copies: any[] = [];
    for (let i = 0; i < 60 && copies.length < 2; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const [, r] = await c.call([['Email/query', { accountId: c.accountId, filter: { subject } }, 'q'],
        ['Email/get', { accountId: c.accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['mailboxIds', 'header:Bcc'] }, 'g']]);
      copies = r.list;
    }
    const received = copies.find((e) => e.mailboxIds[inbox]), sent = copies.find((e) => !e.mailboxIds[inbox]);
    expect(received, 'delivered').toBeTruthy();
    expect(received['header:Bcc']).toBeNull();
    expect(sent['header:Bcc']).toContain('alice@openmail.test');
    await c.call([['Email/set', { accountId: c.accountId, destroy: copies.map((e) => e.id) }, 'd']]);
  }, 45_000);

  it('lists subscriptions grouped by sender with their unsubscribe links', async () => {
    const c = await login();
    const subs = await c.subscriptions();
    const digest = subs.find((x) => x.from.email === 'digest@example.org')!;
    expect(digest.unsubscribe).toEqual({ urls: ['https://example.org/unsub?u=alice', 'mailto:unsub@example.org'], oneClick: true });
    expect(subs.some((x) => x.from.email === 'carol@example.org')).toBe(false); // people aren't subscriptions
  });

  it('address book: create, update, list and delete a contact', async () => {
    const c = await login();
    const id = await c.saveContact({ given: 'Priya', surname: 'Raman', emails: ['priya@example.org'], phones: ['+44 20 7946 0000'], org: 'Example Ltd', note: 'Offsite organiser' });
    await c.saveContact({ id, given: 'Priya', surname: 'Raman', emails: ['priya@example.org', 'p.raman@work.example'], phones: [], org: 'Example Ltd', note: '' });
    const p = (await c.addressBook()).find((x) => x.id === id)!;
    expect(p).toMatchObject({ given: 'Priya', surname: 'Raman', emails: ['priya@example.org', 'p.raman@work.example'], phones: [], org: 'Example Ltd' });
    await c.deleteContact(id);
    expect((await c.addressBook()).some((x) => x.id === id)).toBe(false);
  });

  it('delete-all-from-sender matches the exact address only and never touches Sent', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    const purge = async (text: string) => {
      const [q] = await c.call([['Email/query', { accountId: c.accountId, filter: { text } }, 'q']]);
      if (q.ids.length) await c.call([['Email/set', { accountId: c.accountId, destroy: q.ids }, 'd']]);
    };
    await purge('trashfrom-test'); // leftovers from an interrupted earlier run
    const stamp = `trashfrom-test-${Date.now()}`;
    try {
      const imp = async (from: string, kind: string) => {
        const raw = `From: ${from}\r\nTo: alice@openmail.test\r\nSubject: ${stamp} ${kind}\r\nMessage-ID: <${stamp}-${kind}@t>\r\n\r\nx\r\n`;
        const blob = await c.upload(Object.assign(new Blob([raw], { type: 'message/rfc822' }), { name: 'm.eml' }));
        const [r] = await c.call([['Email/import', { accountId: c.accountId, emails: { e: { blobId: blob.blobId, mailboxIds: { [inbox]: true } } } }, 'i']]);
        return r.created.e.id as string;
      };
      const target = await imp('Shop <shop@x.example>', 'exact');
      const lookalike = await imp('Evil <shop@x.example.evil.net>', 'lookalike');
      const named = await imp('"shop@x.example" <someone@else.example>', 'named');
      // Search indexing is asynchronous: wait until the new mail is findable by sender.
      for (let i = 0; i < 40; i++) {
        const [q] = await c.call([['Email/query', { accountId: c.accountId, filter: { text: stamp } }, 'q']]);
        if (q.ids.length === 3) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      expect(await c.trashFrom('shop@x.example', boxes)).toBe(1);
      const trash = boxes.find((b) => b.role === 'trash')!.id;
      const [g] = await c.call([['Email/get', { accountId: c.accountId, ids: [target, lookalike, named], properties: ['mailboxIds'] }, 'g']]);
      const where = Object.fromEntries((g.list as { id: string; mailboxIds: Record<string, boolean> }[]).map((e) => [e.id, Object.keys(e.mailboxIds)]));
      expect(where[target]).toEqual([trash]);
      expect(where[lookalike]).toEqual([inbox]);
      expect(where[named]).toEqual([inbox]);
      await expect(c.trashFrom('not an address', boxes)).rejects.toThrow('valid sender');
    } finally { await purge(stamp); }
  });

  it('calendar: create, list in range, update and delete an event; parse an invitation', async () => {
    const c = await login();
    const id = await c.saveEvent({ title: 'Offsite planning', start: '2026-11-12T10:00:00', timeZone: 'Europe/London', duration: 'PT1H',
      allDay: false, location: 'Lake house', description: 'Bring the agenda' });
    let week = await c.events(new Date('2026-11-09T00:00:00Z'), new Date('2026-11-16T00:00:00Z'));
    expect(week.find((e) => e.id === id)).toMatchObject({ title: 'Offsite planning', location: 'Lake house', utcStart: '2026-11-12T10:00:00Z', utcEnd: '2026-11-12T11:00:00Z' });
    await c.saveEvent({ id, title: 'Offsite planning (moved)', start: '2026-11-13T14:30:00', timeZone: 'Europe/London', duration: 'PT1H30M',
      allDay: false, location: '', description: '' });
    week = await c.events(new Date('2026-11-09T00:00:00Z'), new Date('2026-11-16T00:00:00Z'));
    expect(week.find((e) => e.id === id)).toMatchObject({ title: 'Offsite planning (moved)', utcStart: '2026-11-13T14:30:00Z', location: '' });
    await c.deleteEvent(id);
    expect((await c.events(new Date('2026-11-09T00:00:00Z'), new Date('2026-11-16T00:00:00Z'))).some((e) => e.id === id)).toBe(false);

    // Meetings are recognised by their iCalendar UID, so an invitation is never added twice.
    const uid = `uid-test-${Date.now()}@example.org`;
    expect(await c.hasEvent(uid)).toBe(false);
    const withUid = await c.saveEvent({ uid, title: 'Has UID', start: '2026-11-14T09:00:00', timeZone: 'Etc/UTC', duration: 'PT30M', allDay: false, location: '', description: '' });
    expect(await c.hasEvent(uid)).toBe(true);
    await c.deleteEvent(withUid);

    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN', 'METHOD:REQUEST', 'BEGIN:VEVENT', 'UID:invite-test@example.org',
      'DTSTAMP:20261107T120000Z', 'DTSTART:20261120T150000Z', 'DTEND:20261120T160000Z', 'SUMMARY:Design review', 'LOCATION:Room 4', 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
    const blob = await c.upload(Object.assign(new Blob([ics], { type: 'text/calendar' }), { name: 'invite.ics' }));
    const [inv] = await c.parseInvite(blob.blobId);
    expect(inv).toMatchObject({ title: 'Design review', location: 'Room 4', duration: 'PT1H' });
  });

  it('reports recipients the server refused', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    // An address on our own domain that doesn't exist is refused right away by local delivery.
    const { submissionId, emailId } = await c.send({ to: [{ name: null, email: 'nobody-here@openmail.test' }], cc: [], subject: `bounce ${Date.now()}`, html: '<p>x</p>', text: 'x', attachments: [] }, boxes, new Date(Date.now() + 1000));
    let problems: { email: string; reason: string }[] = [];
    for (let i = 0; i < 30 && !problems.length; i++) { await new Promise((r) => setTimeout(r, 300)); problems = await c.deliveryProblems(submissionId); }
    expect(problems[0]?.email).toBe('nobody-here@openmail.test');
    expect(problems[0]?.reason.length).toBeGreaterThan(3);
    await c.deleteDraft(emailId).catch(() => {});
  }, 20_000);

  it('answers an invitation: sends an iTIP REPLY to the organizer and remembers the answer', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const t = (await c.threads({ text: 'Quarterly design review' })).find((e) => e.subject === 'Invitation: Quarterly design review')!;
    const [m] = await c.thread(t.threadId);
    const ics = m.attachments.find((a) => a.type.startsWith('text/calendar'))!;
    const inv = await c.rsvp(m.id, ics, 'ACCEPTED', boxes);
    expect(inv.organizerEmail).toBe('priya@example.org');
    expect((await c.thread(t.threadId))[0].keywords).toMatchObject({ '$rsvp-accepted': true });
    // The reply is in Sent with the calendar part attached.
    const sent = boxes.find((b) => b.role === 'sent')!.id;
    const reply = (await c.threads({ inMailbox: sent })).find((e) => e.subject === 'Accepted: Quarterly design review')!;
    const [r] = await c.thread(reply.threadId);
    const part = r.attachments.find((a) => a.type.startsWith('text/calendar'))!;
    const body = await (await c.download(part)).text();
    expect(body).toContain('METHOD:REPLY');
    expect(body).toContain('ATTENDEE;PARTSTAT=ACCEPTED');
    expect(body).toContain('UID:seed-review@openmail.test');
    // Changing the answer replaces the old one.
    await c.rsvp(m.id, ics, 'DECLINED', boxes);
    const kw = (await c.thread(t.threadId))[0].keywords;
    expect(kw['$rsvp-declined']).toBe(true);
    expect(kw['$rsvp-accepted']).toBeUndefined();
  }, 20_000);

  it('read receipts: request one, then send it only when asked; never twice', async () => {
    const c = await login();
    const boxes = await c.mailboxes();
    const subject = `receipt ${Date.now()}`;
    const { submissionId } = await c.send({ to: [ALICE], cc: [], subject, html: '<p>did you read this?</p>', text: 'did you read this?', attachments: [], receipt: true }, boxes);
    void submissionId;
    const inbox = boxes.find((b) => b.role === 'inbox')!.id;
    let got;
    for (let i = 0; i < 60 && !got; i++) { await new Promise((r) => setTimeout(r, 500)); got = (await c.threads({ inMailbox: inbox })).find((e) => e.subject === subject); }
    expect(got, 'message arrives (after the 10-second undo hold)').toBeTruthy();
    const m = (await c.thread(got!.threadId)).find((x) => x.mailboxIds[inbox])!;
    expect(m.receiptTo?.[0]?.email).toBe('alice@openmail.test');
    await c.sendReadReceipt(m, boxes);
    expect((await c.thread(got!.threadId)).find((x) => x.id === m.id)!.keywords['$mdnsent']).toBe(true);
    let mdn;
    for (let i = 0; i < 30 && !mdn; i++) { await new Promise((r) => setTimeout(r, 300)); mdn = (await c.threads({ inMailbox: inbox })).find((e) => e.subject === `Read: ${subject}`); }
    expect(mdn, 'the receipt is delivered').toBeTruthy();
  }, 45_000);

  it('account security: app passwords, password change and two-factor (on a throwaway account)', async () => {
    const admin = JSON.parse((await import('node:fs')).readFileSync(new URL('../../deploy/.dev-admin.json', import.meta.url), 'utf8'));
    const adminAuth = 'Basic ' + Buffer.from(`${admin.user}:${admin.pass}`).toString('base64');
    const adm = async (calls: unknown[]) => (await (await fetch(`${BASE}/jmap/`, { method: 'POST', headers: { Authorization: adminAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }) })).json()).methodResponses;
    const name = `sec${Date.now()}`;
    const [[, dom]] = await adm([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']]);
    const domainId = dom.list.find((d: { name: string }) => d.name === 'openmail.test').id;
    const [[, made]] = await adm([['x:Account/set', { create: { u: { '@type': 'User', name, domainId, credentials: { 0: { '@type': 'Password', secret: 'first-password-123' } } } } }, 'a']]);
    const accountId = made.created.u.id;
    try {
      let c = await Jmap.login(`${name}@openmail.test`, 'first-password-123', BASE);
      expect(await c.security()).toEqual({ twoFactor: false, appPasswords: [] });
      const secret = await c.createAppPassword('Thunderbird on laptop');
      expect(secret).toMatch(/^app_/);
      const apps = (await c.security()).appPasswords;
      expect(apps.map((a) => a.description)).toEqual(['Thunderbird on laptop']);
      // The app password signs in on its own (what Thunderbird would do over IMAP/SMTP).
      expect((await fetch(`${BASE}/jmap/session`, { headers: { Authorization: 'Basic ' + Buffer.from(`${name}@openmail.test:${secret}`).toString('base64') } })).status).toBe(200);
      await c.deleteAppPassword(apps[0].id);
      expect((await c.security()).appPasswords).toEqual([]);

      await expect(c.changePassword('wrong-password', 'second-password-456')).rejects.toThrow();
      await c.changePassword('first-password-123', 'second-password-456');
      c = await Jmap.login(`${name}@openmail.test`, 'second-password-456', BASE);

      const { newSecret, otpauthUrl, totp } = await import('./totp');
      const s = newSecret();
      await c.setTwoFactor('second-password-456', otpauthUrl(s, `${name}@openmail.test`), await totp(s));
      // Two-factor is on: a plain password sign-in (like this test's client) is now refused with "MFA required".
      expect((await fetch(`${BASE}/jmap/session`, { headers: { Authorization: 'Basic ' + Buffer.from(`${name}@openmail.test:second-password-456`).toString('base64') } })).status).toBe(402);
    } finally {
      await adm([['x:Account/set', { destroy: [accountId] }, 'x']]);
    }
  });

  it('suggests contacts, people I write to first, never me', async () => {
    const c = await login();
    const people = (await c.contacts()).map((a) => a.email);
    expect(people).not.toContain('alice@openmail.test');
    expect(people).not.toContain('digest@example.org'); // newsletter senders aren't suggested
    expect(people[0]).toBe('priya@example.org'); // alice wrote to Priya in the seed data
  });
});
