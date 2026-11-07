// Sharing on the local dev server, with throwaway accounts made through the admin API (never alice or bob):
// a shared folder is read by the other person with its permissions enforced, then revoked; team comments in a
// group mailbox are seen by the other member; a delegate sends on the owner's behalf. Skips without the server.
import { readFileSync, existsSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { ACCESS, Jmap } from './jmap';

const BASE = 'http://localhost:8080';
const ADMIN_FILE = process.env.ADMIN_FILE ?? new URL('../../deploy/.dev-admin.json', import.meta.url).pathname;
const up = existsSync(ADMIN_FILE) && await fetch(`${BASE}/.well-known/jmap`, { redirect: 'manual' }).then(() => true, () => false);
const admin = up ? JSON.parse(readFileSync(ADMIN_FILE, 'utf8')) : null;
const adminJmap = async (methodCalls: unknown[]) => (await (await fetch(`${BASE}/jmap/`, { method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: 'Basic ' + btoa(`${admin.user}:${admin.pass}`) },
  body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls }) })).json()).methodResponses[0][1];
const PASS = 'throwaway passphrase 42';
const tag = `t-sharing-${Math.random().toString(36).slice(2, 7)}`;
const made: string[] = [];
let domainId = '';
async function account(kind: 'User' | 'Group', suffix: string, extra: object = {}): Promise<string> {
  domainId ||= (await adminJmap([['x:Domain/get', { ids: null, properties: ['name'] }, 'd']])).list.find((d: { name: string }) => d.name === 'openmail.test').id;
  const r = await adminJmap([['x:Account/set', { create: { n: { '@type': kind, name: `${tag}-${suffix}`, domainId,
    ...(kind === 'User' && { credentials: { 0: { '@type': 'Password', secret: PASS } } }), ...extra } } }, 'c']]);
  made.push(r.created.n.id);
  return r.created.n.id;
}
const login = (suffix: string) => Jmap.login(`${tag}-${suffix}@openmail.test`, PASS, BASE);
// Twice: Stalwart won't delete a group while it still has members, so the group goes on the second pass.
afterAll(async () => { for (const _ of [1, 2]) if (made.length) await adminJmap([['x:Account/set', { destroy: made }, 'x']]); });
const raw = (subject: string) => new TextEncoder().encode(`From: client@example.org\r\nTo: x@openmail.test\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}@example.org>\r\n\r\nHello\r\n`);
const find = async (c: Jmap, id: string) => (await c.sharedAccounts()).find((a) => a.id === id);

describe.skipIf(!up)('sharing on the real server', () => {
  it('shares a folder, enforces the access level, and revoking removes it', async () => {
    await account('User', 'owner'); await account('User', 'other');
    const owner = await login('owner'), other = await login('other');
    const folder = await owner.createMailbox('Projects');
    await owner.importMessage(raw('Kickoff notes'), [folder], {});

    await owner.share([folder], other.accountId, ACCESS.read);
    const acc = (await find(other, owner.accountId))!;
    expect(acc).toMatchObject({ name: `${tag}-owner@openmail.test`, whole: false, canSend: false, team: false });
    expect(acc.boxes.map((b) => b.name)).toEqual(['Projects']);
    expect(acc.boxes[0].myRights).toMatchObject({ mayReadItems: true, mayRemoveItems: false });

    const shared = other.as(acc);
    const [t] = await shared.threads({ inMailbox: folder });
    expect(t.subject).toBe('Kickoff notes');
    expect((await shared.thread(t.threadId))[0].text).toContain('Hello');
    await expect(shared.setStarred(t.threadId, true)).rejects.toThrow(/not allowed/i); // read only
    await expect(shared.send({ to: [{ name: null, email: 'x@example.org' }], cc: [], subject: 's', html: '', text: '', attachments: [] }, acc.boxes)).rejects.toThrow(/but not send/);

    await owner.share([folder], other.accountId, ACCESS.write);
    await shared.setStarred(t.threadId, true);
    expect((await owner.thread(t.threadId))[0].keywords.$flagged).toBe(true);
    const sw = (await owner.shares()).find((b) => b.id === folder)!.shareWith;
    expect(Object.keys(sw)).toEqual([other.accountId]);

    await owner.share([folder], other.accountId, null);
    expect(await find(other, owner.accountId)).toBeUndefined();
    await expect(shared.threads({ inMailbox: folder })).rejects.toThrow();
  });

  it('team mailbox: members see it, comment on a conversation, and send as the team', async () => {
    const team = await account('Group', 'support', { description: 'Support team' });
    await account('User', 'ann', { memberGroupIds: { [team]: true } });
    await account('User', 'ben', { memberGroupIds: { [team]: true } });
    const ann = await login('ann'), ben = await login('ben');
    const accA = (await find(ann, team))!, accB = (await find(ben, team))!;
    expect(accA).toMatchObject({ team: true, whole: true, canSend: true, name: `${tag}-support@openmail.test` });
    const a = ann.as(accA), b = ben.as(accB);
    const inbox = accA.boxes.find((x) => x.role === 'inbox')!.id;
    await a.importMessage(raw('Refund request'), [inbox], {});
    const [t] = await a.threads({ inMailbox: inbox });

    await a.addComment(t.threadId, 'I’ll take this one');
    const seen = await b.comments(t.threadId);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ text: 'I’ll take this one', author: { email: `${tag}-ann@openmail.test` } });
    expect(Date.parse(seen[0].at)).toBeGreaterThan(Date.now() - 600e3);
    expect(await b.comments('other-thread')).toEqual([]);
    expect((await b.mailboxes()).some((x) => x.name === 'Comments')).toBe(false); // app storage stays out of the rail
    expect(await b.threads({ inMailbox: inbox })).toHaveLength(1); // comments are not conversations in the Inbox

    const id = (await b.identities())[0];
    expect(id.email).toBe(`${tag}-support@openmail.test`);
  });

  it('delegation: full access, send on behalf of the owner, then removed', async () => {
    await account('User', 'boss'); await account('User', 'aide');
    const boss = await login('boss'), aide = await login('aide');
    await boss.delegate(aide.accountId, true);
    const acc = (await find(aide, boss.accountId))!;
    expect(acc).toMatchObject({ whole: true, canSend: true, team: false });
    expect(acc.boxes.map((b) => b.role)).toEqual(expect.arrayContaining(['inbox', 'sent', 'drafts']));

    const d = aide.as(acc);
    const subject = `on behalf ${tag}`;
    const { emailId } = await d.send({ to: [{ name: null, email: `${tag}-boss@openmail.test` }], cc: [], subject, html: '<p>Hi</p>', text: 'Hi', attachments: [] }, acc.boxes);
    // The submission is made from the aide's own account: Stalwart has no send-as for another account.
    const [sent] = await aide.call([['Email/get', { accountId: aide.accountId, ids: [emailId], properties: ['from', 'sender'] }, 'g']]);
    expect(sent.list[0].from[0].email).toBe(`${tag}-boss@openmail.test`);
    expect(sent.list[0].sender[0].email).toBe(`${tag}-aide@openmail.test`);
    let got;
    for (let i = 0; i < 30 && !got; i++) {
      await new Promise((r) => setTimeout(r, 1000)); // the 10-second undo hold, then local delivery
      [got] = await boss.threads({ subject });
    }
    expect(got?.from?.[0].email).toBe(`${tag}-boss@openmail.test`);

    await boss.delegate(aide.accountId, false);
    expect((await find(aide, boss.accountId))?.canSend).toBe(false);
    await boss.delegate(aide.accountId, null);
    expect(await find(aide, boss.accountId)).toBeUndefined();
  }, 60_000);
});
