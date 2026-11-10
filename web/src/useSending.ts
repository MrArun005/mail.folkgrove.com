// Writing and sending from the mailbox screen: new messages, replies (and the quick reply under a conversation), the
// compose API, Send with Undo, scheduled sending, the offline outbox, and the delivery check after the undo window.
// Mail.tsx calls this every render with its current state, so each function sees the newest folders and identities.
import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { confirmIt } from './Dialog';
import type { ComposeApi } from './Compose';
import { loadScript, saveScript } from './Filters';
import { UNDO_SECONDS, type Draft, type EmailFull, type Jmap, type Mailbox, type Scheduled, type SharedAccount } from './jmap';
import { addSignature, chooseSignature, draftFor, draftFromEmail, fileSize, htmlToText, textToHtml, type ReplyMode, type Signature } from './mailutil';
import type { ScriptData } from './rules';
import { takeLaunch } from './launch';
import { offlineStore } from './offline';
import { describe } from './when';
import { t } from './i18n';

export const EMPTY_DRAFT: Draft = { to: [], cc: [], subject: '', html: '', text: '', attachments: [] };
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export interface SendingContext {
  client: Jmap; boxes: Mailbox[]; opened: SharedAccount | null;
  /** Your addresses (replies leave them out), and the signatures to add. */
  identities: string[]; signatures: Signature[]; sigData: Pick<ScriptData, 'sigNew' | 'sigReply'>;
  /** Open a draft in the editor (ComposeDock's `useComposeWindows`). */
  setCompose: (d: Draft) => void;
  say: (toast: { text: string; undo?: () => void }, ms?: number) => void; fail: (e: unknown) => void; refresh: () => void;
  loadContacts: () => void; setThreadVersion: Dispatch<SetStateAction<number>>;
}

export function useSending({ client, boxes, opened, identities, signatures, sigData, setCompose, say, fail, refresh, loadContacts, setThreadVersion }: SendingContext) {
  // Offline: a banner, and an outbox that empties itself when the connection comes back.
  const [online, setOnline] = useState(() => navigator.onLine);
  const [outbox, setOutbox] = useState(0);
  useEffect(() => {
    if (!client.offline) return;
    const key = `${client.username}:outbox`;
    const flush = async () => {
      const box = (await offlineStore.get<{ d: Draft; sendAt?: string }[]>(key)) ?? [];
      setOutbox(box.length);
      if (!box.length || !navigator.onLine) return;
      let sent = 0;
      const b = await client.mailboxes().catch(() => boxes);
      for (const item of box) {
        try { await client.send(item.d, b, item.sendAt ? new Date(item.sendAt) : undefined); sent++; }
        catch { break; } // still failing: keep the rest for next time
      }
      const rest = box.slice(sent);
      await offlineStore.set(key, rest); setOutbox(rest.length);
      if (sent) { say({ text: t('mail.outboxSent', { count: sent }) }); refresh(); }
    };
    const on = () => { setOnline(true); flush(); }, off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    flush();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [client]);

  // ── Writing ────────────────────────────────────────────

  const withSignature = (d: Draft, kind: 'new' | 'reply' = 'new'): Draft =>
    ({ ...d, html: addSignature(d.html, chooseSignature(signatures, kind === 'new' ? sigData.sigNew : sigData.sigReply)) });
  function reply(mode: ReplyMode, e: EmailFull, text?: string) {
    const d = draftFor(mode, e, client.username, identities);
    // A picked suggestion goes on the first line; the user edits it like anything they typed.
    // The signature is added before the words, so it lands under them rather than above (it goes after the first
    // blank line, and the words then take that line).
    const signed = withSignature(d, 'reply');
    if (text) signed.html = signed.html.replace('<div><br></div>', `${text.trim().split('\n').map((l) => `<div>${escape(l) || '<br>'}</div>`).join('')}<div><br></div>`);
    setCompose(signed);
  }

  /** A short reply typed under the conversation: built like any reply (quote, signature) and sent at once, with Undo. */
  function quickReply(e: EmailFull, text: string, all: boolean) {
    const d = draftFor(all ? 'replyAll' : 'reply', e, client.username, identities);
    const lines = text.trim().split('\n').map((l) => `<div>${escape(l) || '<br>'}</div>`).join('');
    // Signature first (it goes under the blank first line), then the words onto that line: text, signature, quote.
    const signed = withSignature(d, 'reply');
    const html = signed.html.replace('<div><br></div>', `${lines}<div><br></div>`);
    send({ ...signed, html, text: htmlToText(html) });
  }

  const composeApi: ComposeApi = {
    upload: (f) => client.upload(f),
    save: (d) => client.saveDraft(d, boxes),
    discard: (id) => client.deleteDraft(id),
    download: (a) => client.download(a),
    templates: () => client.templates(),
    saveTemplate: (d) => client.saveTemplate(d),
    deleteTemplate: (id) => client.deleteTemplate(id),
    share: (f, days) => client.shareFile(f, days),
    maxUpload: client.maxUpload,
    events: opened ? undefined : (from, to) => client.events(from, to),
    activity: (email) => client.threads({ from: email }, 30).then((l) => l.map((e) => e.receivedAt)),
  };
  // Opened from outside: the Compose shortcut, an email link or "Share to OpenMail" (launch.ts).
  useEffect(() => {
    takeLaunch().then(async (l) => {
      if (!l) return;
      // Shared files come from outside (any site can post to /share): attach them only when the person says so.
      // Names are the sender's text: control/direction characters stripped, shortened, shown after the warning.
      const label = (f: File) => `${f.name.replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 60) || t('mail.untitledFile')} (${fileSize(f.size)})`;
      if (l.files.length && !(await confirmIt({ title: t('mail.attachSharedTitle', { count: l.files.length }), danger: true,
        body: t('mail.attachSharedBody', { files: `${l.files.slice(0, 5).map(label).join(' · ')}${l.files.length > 5 ? ' …' : ''}` }), confirm: t('mail.attach') }))) l.files = [];
      const attachments = await Promise.all(l.files.map((f) => client.upload(f))).catch((e) => { fail(e); return []; });
      setCompose(withSignature({ ...EMPTY_DRAFT, to: l.to, cc: l.cc, bcc: l.bcc, subject: l.subject, html: l.body ? textToHtml(l.body) : '', text: l.body, attachments }));
    });
  }, [client]);
  function closeCompose(outcome: 'saved' | 'discarded' | 'closed') {
    if (outcome === 'saved') say({ text: t('mail.draftSaved') });
    if (outcome === 'discarded') say({ text: t('mail.draftDiscarded') });
    refresh();
  }

  /** Screener: people you write to are people you want to hear from. */
  async function approveRecipients(d: Draft) {
    try {
      const { data } = await loadScript(client);
      const to = [...d.to, ...d.cc, ...(d.bcc ?? [])].map((a) => a.email.toLowerCase());
      if (!data.screener?.on || to.every((a) => data.screener!.allow.includes(a))) return; // nothing new: skip the write
      await saveScript(client, boxes, (s) => (s.screener?.on ? { ...s, screener: { on: true, allow: [...new Set([...s.screener.allow, ...to])] } } : s));
    } catch { /* the message went out; approving can happen from the Screener */ }
  }

  async function send(d: Draft, sendAt?: Date) {
    if (!navigator.onLine && client.offline) {
      // Offline: keep it in the outbox; it goes when the connection is back (see the 'online' effect).
      const box = (await offlineStore.get<{ d: Draft; sendAt?: string }[]>(`${client.username}:outbox`)) ?? [];
      await offlineStore.set(`${client.username}:outbox`, [...box, { d, sendAt: sendAt?.toISOString() }]);
      setOutbox(box.length + 1);
      return say({ text: t('mail.offlineQueued') }, 6000);
    }
    const pending = client.send(d, boxes, sendAt);
    let undone = false;
    const undo = async () => {
      undone = true;
      say({ text: t(sendAt ? 'mail.cancelling' : 'mail.undoing') }, 0);
      try {
        const { submissionId, emailId } = await pending;
        await client.undoSend(submissionId, emailId, boxes);
        say({ text: t(sendAt ? 'mail.scheduleCancelled' : 'mail.sendUndone') });
        setCompose({ ...d, id: emailId }); // it's a draft again
      } catch { say({ text: t('mail.tooLate') }); }
      refresh();
    };
    say({ text: sendAt ? t('mail.scheduledFor', { time: describe(sendAt) }) : t('mail.sending'), undo }, sendAt ? 8000 : UNDO_SECONDS * 1000);
    try { await pending; loadContacts(); approveRecipients(d); } catch (e) {
      say({ text: t('mail.notSent', { error: (e as Error).message }) }, 8000);
      setCompose(d); // never lose what someone wrote
      return;
    }
    if (sendAt) return refresh();
    // After the undo window, ask the server how delivery went: a refused recipient is reported, not hidden.
    setTimeout(async () => {
      if (undone) return;
      const { submissionId } = await pending;
      const problems = await client.deliveryProblems(submissionId).catch(() => []);
      say(problems.length
        ? { text: t('mail.notDelivered', { addresses: problems.map((p) => p.email).join(', '), reason: problems[0].reason }) }
        : { text: t('mail.sent') }, problems.length ? 10000 : 4000);
      refresh(); setThreadVersion((v) => v + 1);
    }, UNDO_SECONDS * 1000 + 1500);
  }

  async function editScheduled(s: Scheduled) {
    if (!(await confirmIt({ title: t('mail.editScheduledTitle'), body: t('mail.editScheduledBody', { subject: s.email.subject || t('mail.noSubject'), time: describe(new Date(s.sendAt)) }), confirm: t('mail.editMessage') }))) return;
    try {
      await client.undoSend(s.submissionId, s.email.id, boxes);
      const draft = (await client.thread(s.email.threadId)).find((m) => m.id === s.email.id);
      if (draft) setCompose(draftFromEmail(draft));
      refresh();
    } catch (e) { fail(e); }
  }

  return { online, outbox, withSignature, reply, quickReply, composeApi, closeCompose, send, editScheduled };
}
