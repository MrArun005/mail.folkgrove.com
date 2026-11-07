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
    await c.saveRules(toSieve({ rules: [], vacation: { enabled: false } }, folders), (await c.getRules()).id);
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

  it('lists subscriptions grouped by sender with their unsubscribe links', async () => {
    const c = await login();
    const subs = await c.subscriptions();
    const digest = subs.find((x) => x.from.email === 'digest@example.org')!;
    expect(digest.unsubscribe).toEqual({ urls: ['https://example.org/unsub?u=alice', 'mailto:unsub@example.org'], oneClick: true });
    expect(subs.some((x) => x.from.email === 'carol@example.org')).toBe(false); // people aren't subscriptions
  });

  it('suggests contacts, people I write to first, never me', async () => {
    const c = await login();
    const people = (await c.contacts()).map((a) => a.email);
    expect(people).not.toContain('alice@openmail.test');
    expect(people[0]).toBe('priya@example.org'); // alice wrote to Priya in the seed data
  });
});
