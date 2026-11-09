// Feed: newsletters and other list mail, read as one page instead of opened one at a time (rail → More → Feed).
// The newest conversations the Inbox files under a category tab (Promotions, Social, Updates, Forums), each shown
// whole: who, when, the subject as a headline, and the message itself in the same locked-down frame the reader
// uses (no scripts, no network, trackers removed). Bodies load as they scroll near; nothing is marked read or
// moved unless you say so.
import { useEffect, useRef, useState } from 'react';
import { Button } from './Button';
import { hue } from './Contacts';
import type { EmailFull, EmailSummary, Jmap } from './jmap';
import { displayName, textToHtml } from './mailutil';
import { recordTrackers } from './privacy';
import { MessageFrame, shortDate } from './Reader';
import { tabKeyword, TABS } from './rules';
import { buildSrcdoc } from './safeHtml';
import { t } from './i18n';

const PAGE = 20;

export function FeedView({ client, say, onOpen }: { client: Jmap; say: (text: string) => void; onOpen: (threadId: string) => void }) {
  const [items, setItems] = useState<EmailSummary[] | null>(null);
  const [more, setMore] = useState(false);
  const limit = useRef(PAGE);
  const boxesRef = useRef<{ inbox: string; archive?: string } | null>(null);

  async function load() {
    try {
      const boxes = await client.mailboxes();
      const inbox = boxes.find((b) => b.role === 'inbox')!.id;
      boxesRef.current = { inbox, archive: boxes.find((b) => b.role === 'archive')?.id };
      const l = await client.threads({ operator: 'AND', conditions: [{ inMailbox: inbox }, { operator: 'OR', conditions: TABS.map((k) => ({ hasKeyword: tabKeyword(k) })) }] }, limit.current + 1);
      setMore(l.length > limit.current); setItems(l.slice(0, limit.current));
    } catch (e) { say((e as Error).message); setItems((x) => x ?? []); }
  }
  useEffect(() => { load(); }, [client]);

  const unread = items?.filter((e) => !e.keywords.$seen) ?? [];
  async function readAll() {
    setItems((l) => l?.map((e) => ({ ...e, keywords: { ...e.keywords, $seen: true } })) ?? l);
    try { await Promise.all(unread.map((e) => client.setSeen(e.threadId, true))); say(t('feed.allRead', { count: unread.length })); } catch (e) { say((e as Error).message); load(); }
  }
  async function done(e: EmailSummary) {
    const b = boxesRef.current;
    if (!b) return;
    setItems((l) => l?.filter((x) => x.threadId !== e.threadId) ?? l);
    try {
      await client.setSeen(e.threadId, true);
      await client.move(e.threadId, b.inbox, b.archive ?? await client.mailboxFor('archive', 'Archive', await client.mailboxes()));
      say(t('feed.archived'));
    } catch (err) { say((err as Error).message); load(); }
  }

  return (
    <section className="feed" aria-label={t('folder.feed')}>
      <header className="feed-head">
        <div><h2>{t('folder.feed')}</h2><p className="fine">{t('feed.intro')}</p></div>
        {unread.length > 0 && <Button icon="check" onClick={readAll}>{t('feed.markAllRead')}</Button>}
      </header>
      {items === null && <div className="rows-loading" aria-busy="true">{[0, 1, 2].map((i) => <span key={i} />)}</div>}
      {items?.length === 0 && <p className="empty">{t('feed.empty')}</p>}
      <div className="feed-items">
        {items?.map((e) => <FeedItem key={e.threadId} client={client} e={e} onOpen={() => onOpen(e.threadId)} onDone={() => done(e)} />)}
      </div>
      {more && <div className="list-more"><Button variant="link" onClick={() => { limit.current += PAGE; load(); }}>{t('mail.showMore')}</Button></div>}
    </section>
  );
}

function FeedItem({ client, e, onOpen, onDone }: { client: Jmap; e: EmailSummary; onOpen: () => void; onDone: () => void }) {
  const ref = useRef<HTMLElement>(null);
  const [near, setNear] = useState(false);
  const [m, setM] = useState<EmailFull | null>(null);
  const [failed, setFailed] = useState('');
  // The body is fetched when the card comes within a screen of the view, once.
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver((hits) => { if (hits.some((h) => h.isIntersecting)) { setNear(true); io.disconnect(); } }, { rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  useEffect(() => {
    if (!near) return;
    let live = true;
    // The newest message of the conversation: a newsletter issue is one message.
    client.thread(e.threadId).then((l) => live && setM(l.find((x) => x.id === e.id) ?? l[l.length - 1] ?? null), (err) => live && setFailed(err.message));
    return () => { live = false; };
  }, [near, e.id]);
  const from = e.from?.[0];
  const html = m ? buildSrcdoc(m.html ?? textToHtml(m.text ?? ''), false) : null;
  useEffect(() => { if (m && html?.trackers.length) recordTrackers(client.username, m.id, m.from?.[0], html.trackers); }, [m?.id]);
  return (
    <article ref={ref} className={`feed-item${e.keywords.$seen ? '' : ' unread'}`}>
      <header>
        <span className="avatar" aria-hidden="true" style={{ '--h': hue(from?.email ?? '') } as React.CSSProperties}>{(displayName(from) || '?').slice(0, 1).toUpperCase()}</span>
        <span className="who"><b dir="auto">{displayName(from)}</b><time dateTime={e.receivedAt}>{shortDate(e.receivedAt)}</time></span>
        <span className="acts">
          <Button variant="quiet" size="sm" icon="popOut" label={t('feed.open')} onClick={onOpen} />
          <Button variant="quiet" size="sm" icon="archive" label={t('mail.archive')} onClick={onDone} />
        </span>
      </header>
      <h3 dir="auto"><button className="feed-title" onClick={onOpen}>{e.subject || t('mail.noSubject')}</button></h3>
      {failed ? <p className="error">{failed}</p>
        : html ? <div className="feed-body"><MessageFrame title={e.subject ?? ''} srcdoc={html.srcdoc} /></div>
        : <p className="feed-preview">{e.preview}</p>}
    </article>
  );
}
