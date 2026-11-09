// What you can do with one message or one sender, beyond moving it: unsubscribe, block, print, show the original,
// add to tasks or contacts, answer an invitation or a read-receipt request, react, and save a search.
// A plain function, not a hook: Mail.tsx hands it what it needs each render and gets the handlers back.
import { confirmIt, promptIt } from './Dialog';
import { localZone } from './calendar';
import { addRule, saveScript } from './Filters';
import type { PartStat } from './ics';
import type { Address, Attachment, EmailFull, Jmap, Mailbox, Subscription } from './jmap';
import { displayName, formatAddresses, parseAddresses, textToHtml, unsubscribePlan } from './mailutil';
import { reactionDraft } from './reactions';
import type { MoreAction } from './Reader';
import { buildSrcdoc } from './safeHtml';
import { locale, t } from './i18n';

// Read by list servers, not people: never translated (RFC 2369 / RFC 8058).
const UNSUB = 'unsubscribe', ONE_CLICK = 'List-Unsubscribe=One-Click';
const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export interface MessageContext {
  client: Jmap; boxes: Mailbox[];
  /** The search on screen (saving it) and your own addresses (reactions). */
  query: string; identities: string[];
  say: (toast: { text: string }, ms?: number) => void; fail: (e: unknown) => void; refresh: () => void;
  /** The list's own move actions (Mail.tsx), for "block" (which also reports the message as spam). */
  act: (a: 'junk', threadIds: string[]) => Promise<void> | void;
  setSaved: (searches: { name: string; query: string }[]) => void;
  reloadThread: () => void; loadContacts: () => void;
  search: (query: string) => void; filterLike: (from: string) => void;
}

export function messageActions({ client, boxes, query, identities, say, fail, refresh, act, setSaved, reloadThread, loadContacts, search, filterLike }: MessageContext) {
  /** Shared by the reader's Unsubscribe link and the Subscriptions page. Returns true when it went through. */
  async function unsubscribe(m: Pick<EmailFull, 'unsubscribe'> & { from: Address[] | null }): Promise<boolean> {
    const who = displayName(m.from?.[0]);
    const plan = unsubscribePlan(m.unsubscribe);
    if (!plan) { say({ text: t('mail.noSafeUnsubscribe', { name: who }) }, 6000); return false; }
        if (!(await confirmIt({ title: t('mail.unsubscribeTitle', { name: who }), body: plan.kind === 'mail' ? t('mail.unsubscribeByMail', { address: plan.to }) : t(plan.kind === 'post' ? 'mail.unsubscribeByPost' : 'mail.unsubscribeByLink', { host: plan.host }), confirm: t('mail.unsubscribe') }))) return false;
    try {
      if (plan.kind === 'post') {
        // RFC 8058 one-click: a plain form POST. no-cors because we never need to read the reply.
        await fetch(plan.url, { method: 'POST', mode: 'no-cors', credentials: 'omit', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: ONE_CLICK });
        say({ text: t('mail.unsubscribed', { name: who }) });
      } else if (plan.kind === 'mail') {
        await client.send({ to: [{ name: null, email: plan.to }], cc: [], subject: UNSUB, html: `<p>${UNSUB}</p>`, text: UNSUB, attachments: [] }, boxes);
        say({ text: t('mail.unsubscribeSent', { address: plan.to }) });
      } else {
        window.open(plan.url, '_blank', 'noopener,noreferrer');
        say({ text: t('mail.unsubscribeOpened', { host: plan.host }) });
      }
      return true;
    } catch (e) { fail(e); return false; }
  }

  async function deleteAllFrom(s: Subscription) {
    const who = displayName(s.from);
    if (!(await confirmIt({ title: t('mail.deleteAllTitle', { name: who }), body: t('mail.deleteAllBody', { address: s.from.email }), confirm: t('mail.moveToTrash'), danger: true }))) return;
    try { const n = await client.trashFrom(s.from.email, boxes); say({ text: t('mail.deletedAllFrom', { count: n, name: who }) }); refresh(); }
    catch (e) { fail(e); }
  }

  async function saveSearch() {
    const name = await promptIt({ title: t('mail.saveSearch'), body: t('mail.saveSearchBody'), label: t('mail.name'), value: query, confirm: t('mail.saveSearchConfirm') });
    if (!name) return;
    try {
      let next: { name: string; query: string }[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, savedSearches: (next = [...(d.savedSearches ?? []).filter((x) => x.name !== name), { name, query }]) }));
      setSaved(next); say({ text: t('mail.savedSearch', { name }) });
    } catch (e) { fail(e); }
  }

  async function removeSearch(name: string) {
    try {
      let next: { name: string; query: string }[] = [];
      await saveScript(client, boxes, (d) => ({ ...d, savedSearches: (next = (d.savedSearches ?? []).filter((x) => x.name !== name)) }));
      setSaved(next);
    } catch (e) { fail(e); }
  }

  async function more(what: MoreAction, m: EmailFull) {
    const sender = m.from?.[0]?.email ?? '';
    try {
      if (what === 'original') {
        const url = URL.createObjectURL(new Blob([await client.original(m)], { type: 'text/plain;charset=utf-8' }));
        window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } else if (what === 'print') {
        // Print from a hidden sandboxed frame: same isolation as reading (CSP, trackers removed). allow-same-origin
        // lets us call print(); without allow-scripts nothing in the message can run. allow-modals shows the dialog.
        const head = `<h1 style="font:600 20px system-ui">${escape(m.subject ?? '')}</h1><p style="font:13px system-ui;color:#555">${escape(t('mail.printFrom', { from: formatAddresses(m.from) }))}<br>${escape(t('mail.printTo', { to: formatAddresses(m.to) }))}<br>${new Date(m.receivedAt).toLocaleString(locale())}</p><hr>`;
        const frame = Object.assign(document.createElement('iframe'), { srcdoc: buildSrcdoc(head + (m.html ?? textToHtml(m.text ?? '')), false).srcdoc });
        frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
        frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
        frame.onload = () => { frame.contentWindow?.print(); setTimeout(() => frame.remove(), 1000); };
        document.body.appendChild(frame);
      } else if (what === 'fromSender') {
        search(`from:${sender}`);
      } else if (what === 'task') {
        await client.addTask(m.subject?.replace(/^((re|fwd?)\s*:\s*)+/i, '') || t('mail.followUp'), { threadId: m.threadId });
        say({ text: t('mail.addedToTasks') });
      } else if (what === 'unmute') {
        await client.unmute(m.threadId); reloadThread(); say({ text: t('mail.unmuted') });
      } else if (what === 'filter') {
        filterLike(sender);
      } else if (what === 'addContact') {
        const name = m.from?.[0]?.name?.trim() ?? '';
        const [given, ...rest] = name.split(/\s+/);
        await client.saveContact({ given: given ?? '', surname: rest.join(' '), emails: [sender], phones: [], org: '', note: '' });
        say({ text: t('mail.addedContact', { name: name || sender }) }); loadContacts();
      } else if (what === 'block') {
        if (!parseAddresses(sender).list.length) return say({ text: t('mail.cantBlock') });
        if (!(await confirmIt({ title: t('mail.blockTitle', { address: sender }), body: t('mail.blockBody'), confirm: t('mail.block'), danger: true }))) return;
        await addRule(client, boxes, { id: crypto.randomUUID(), from: sender, fromExact: true, action: 'block' });
        await act('junk', [m.threadId]);
        say({ text: t('mail.blocked', { address: sender }) });
      }
    } catch (e) { fail(e); }
  }
  async function rsvp(m: EmailFull, ics: Attachment, status: PartStat) {
    const was = (['accepted', 'tentative'] as const).some((p) => m.keywords[`$rsvp-${p}`]);
    try {
      const inv = await client.rsvp(m.id, ics, status, boxes);
      // Yes / Maybe also put it in the calendar, once (changing Maybe → Yes doesn't duplicate it).
      let added = false;
      if (status !== 'DECLINED' && !was && !(await client.hasEvent(inv.uid))) {
        const [ev] = await client.parseInvite(ics.blobId);
        if (ev) { await client.saveEvent({ ...ev, id: undefined, uid: inv.uid, timeZone: ev.timeZone || localZone() }); added = true; }
      }
      say({ text: t(added ? 'mail.repliedAdded' : 'mail.replied', { answer: t(({ ACCEPTED: 'mail.rsvpYes', TENTATIVE: 'mail.rsvpMaybe', DECLINED: 'mail.rsvpNo' } as const)[status]), address: inv.organizerEmail }) });
      reloadThread();
    } catch (e) { fail(e); }
  }

  async function receipt(m: EmailFull, send: boolean) {
    try {
      if (send) { await client.sendReadReceipt(m, boxes); say({ text: t('mail.receiptSent', { address: m.receiptTo?.[0]?.email ?? '' }) }); }
      else { await client.declineReadReceipt(m.id); say({ text: t('mail.noReceipt') }); }
      reloadThread();
    } catch (e) { fail(e); }
  }

  /** RFC 9078 reaction: a tiny reply holding the emoji; it shows as a chip under the message. */
  async function react(m: EmailFull, emoji: string) {
    try {
      await client.send(reactionDraft(m, emoji, client.username, identities), boxes);
      say({ text: t('mail.reacted', { emoji }) }); reloadThread();
    } catch (e) { fail(e); }
  }

  return { unsubscribe, deleteAllFrom, saveSearch, removeSearch, more, rsvp, receipt, react };
}
