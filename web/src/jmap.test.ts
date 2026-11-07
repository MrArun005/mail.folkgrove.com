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

  it('updates display name, signature and vacation reply', async () => {
    const c = await login();
    await c.setIdentity({ name: 'Alice Test', textSignature: 'Alice\n-- sent with OpenMail' });
    expect((await c.getIdentityFresh()).name).toBe('Alice Test');
    await c.setVacation({ isEnabled: true, subject: 'Away', textBody: 'Back Monday.' });
    expect((await c.vacation()).isEnabled).toBe(true);
    await c.setVacation({ isEnabled: false, subject: null, textBody: null });
    await c.setIdentity({ name: '', textSignature: '' });
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

  it('suggests contacts, people I write to first, never me', async () => {
    const c = await login();
    const people = (await c.contacts()).map((a) => a.email);
    expect(people).not.toContain('alice@openmail.test');
    expect(people[0]).toBe('priya@example.org'); // alice wrote to Priya in the seed data
  });
});
