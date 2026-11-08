import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { confirmIt, notify } from './Dialog';
import { createPortal } from 'react-dom';
import type { Attachment, EmailFull, Jmap, Mailbox } from './jmap';
import { Button } from './Button';
import { Icon } from './icons';
import { displayName, fileLinks, fileSize, formatAddresses, type ReplyMode } from './mailutil';
import { ConfidentialSent } from './Confidential';
import { canSuggestReplies, canSummarize, canTranslate, languageName, suggestReplies, summarize, translate, visibleText } from './ai';
import { buildSrcdoc } from './safeHtml';
import { span, type CalEvent } from './calendar';
import type { PartStat } from './ics';
import { Menu, TimeChoices } from './Menu';
import { isCryptoPart, SecureBanner, useSecureMail } from './Encryption';
import { locale, t } from './i18n';

export type Action = 'archive' | 'trash' | 'junk' | 'unread' | 'star' | 'mute';
export type MoreAction = 'original' | 'print' | 'block' | 'filter' | 'addContact' | 'unmute' | 'task';

export function Reader({ client, me, messages, error, inTrash, inJunk, folders, onAction, onReply, onBack, onSnooze, onMoveTo, onUnsubscribe, onMore, onRsvp, onReceipt, footer }: {
  client: Jmap; me: string; messages: EmailFull[] | null; error: string; inTrash: boolean; inJunk: boolean;
  /** Folders the user created (moving/labelling targets). */
  folders: Mailbox[];
  onAction: (a: Action) => void; onReply: (mode: ReplyMode, e: EmailFull, text?: string) => void; onBack: () => void;
  onSnooze: (until: Date) => void;
  /** mailboxId, or null to create a folder first; label=true keeps it where it is too. */
  onMoveTo: (mailboxId: string | null, label: boolean) => void;
  onUnsubscribe: (m: EmailFull) => void;
  onMore: (what: MoreAction, m: EmailFull) => void;
  onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void>;
  onReceipt: (m: EmailFull, send: boolean) => void;
  /** Shown under the conversation (team comments in a shared mailbox). */
  footer?: ReactNode;
}) {
  // Newest message open, older ones folded, like a paper trail. A message that arrives while reading opens too.
  const [open, setOpen] = useState<Set<string>>(new Set());
  const newest = messages?.[messages.length - 1]?.id;
  const shownThread = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!newest) return;
    const tid = messages![0].threadId;
    setOpen((s) => (tid === shownThread.current ? new Set(s).add(newest) : new Set([newest])));
    shownThread.current = tid;
  }, [newest]);

  if (error) return <p className="empty">{error}</p>;
  if (!messages) return <div className="reader-loading" aria-busy="true" />;
  const last = messages[messages.length - 1];
  const starred = messages.some((m) => m.keywords.$flagged);
  const muted = messages.some((m) => m.keywords.$muted);


  return (
    <article className="thread">
      <div className="toolbar">
        <Button variant="quiet" icon="back" label={t('reader.backToList')} className="only-mobile" onClick={onBack} />
        {!inTrash && <Button variant="quiet" icon="archive" label={t('reader.archive')} shortcut="e" onClick={() => onAction('archive')} />}
        <Button variant="quiet" icon="trash" label={inTrash ? t('reader.deleteForever') : t('common.delete')} shortcut="#" onClick={() => onAction('trash')} />
        <Button variant="quiet" icon="junk" label={inJunk ? t('reader.notSpam') : t('reader.reportSpam')} shortcut="!" onClick={() => onAction('junk')} />
        <Button variant="quiet" icon="unread" label={t('reader.markUnread')} shortcut="u" onClick={() => onAction('unread')} />
        <Button variant="quiet" icon="star" label={starred ? t('reader.unstar') : t('reader.star')} shortcut="s" pressed={starred} onClick={() => onAction('star')} />
        <span className="tool-sep" />
        <Menu label={t('reader.snooze')} button={<Button variant="quiet" icon="clock" label={t('reader.snooze')} />}>
          {(close) => <><p className="menu-title">{t('reader.snoozeUntil')}</p><TimeChoices verb={t('reader.snooze')} close={close} onPick={onSnooze} /></>}
        </Menu>
        {(['move', 'label'] as const).map((mode) => (
          <Menu key={mode} label={mode === 'move' ? t('reader.moveTo') : t('reader.labelAs')}
            button={<Button variant="quiet" icon={mode === 'move' ? 'folder' : 'tag'} label={mode === 'move' ? t('reader.moveToFolder') : t('reader.labelAs')} />}>
            {(close) => <>
              <p className="menu-title">{mode === 'move' ? t('reader.moveTo') : t('reader.labelAs')}</p>
              {folders.map((f) => <button key={f.id} className="menu-item" role="menuitem" onClick={() => { close(); onMoveTo(f.id, mode === 'label'); }}><Icon name="folder" size={16} />{f.name}</button>)}
              <button className="menu-item" role="menuitem" onClick={() => { close(); onMoveTo(null, mode === 'label'); }}><Icon name="compose" size={16} />{t('reader.newFolder')}</button>
            </>}
          </Menu>
        ))}
        <Menu label={t('reader.more')} align="right" button={<Button variant="quiet" icon="more" label={t('reader.more')} />}>
          {(close) => {
            const sender = last.from?.[0]?.email;
            const item = (what: MoreAction, icon: Parameters<typeof Icon>[0]['name'], text: string) =>
              <button className="menu-item" role="menuitem" onClick={() => { close(); onMore(what, last); }}><Icon name={icon} size={16} />{text}</button>;
            return <>
              {muted ? item('unmute', 'unread', t('reader.unmute'))
                : <button className="menu-item" role="menuitem" onClick={() => { close(); onAction('mute'); }}><Icon name="mute" size={16} />{t('reader.mute')}</button>}
              {item('task', 'check', t('reader.addToTasks'))}
              {item('print', 'print', t('reader.print'))}
              {item('original', 'file', t('reader.showOriginal'))}
              {sender && sender.toLowerCase() !== me.toLowerCase() && <>
                {item('addContact', 'compose', t('reader.addContact'))}
                {item('filter', 'tag', t('reader.filterLike'))}
                {item('block', 'junk', t('reader.block', { sender }))}
              </>}
            </>;
          }}
        </Menu>
      </div>

      {muted && <p className="banner" role="status"><Icon name="mute" size={16} /><span className="grow">{t('reader.muted')}</span><Button variant="link" onClick={() => onMore('unmute', last)}>{t('reader.unmute')}</Button></p>}
      <h1 className="subject">{last.subject?.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, '') || t('reader.noSubject')}</h1>

      {messages.map((m) => open.has(m.id)
        ? <Message key={m.id} client={client} m={m} me={me} inJunk={inJunk} onUnsubscribe={onUnsubscribe} onRsvp={onRsvp} onReceipt={onReceipt} onFold={messages.length > 1 ? () => setOpen((s) => { const n = new Set(s); n.delete(m.id); return n; }) : undefined} />
        : (
          <button key={m.id} className="folded" onClick={() => setOpen((s) => new Set(s).add(m.id))}>
            <span className="who">{displayName(m.from?.[0], me)}</span>
            <span className="snippet">{m.preview}</span>
            <time>{shortDate(m.receivedAt)}</time>
          </button>
        ))}

      <SmartReplies m={last} me={me} onPick={(text) => onReply('reply', last, text)} />
      <div className="reply-bar">
        <Button icon="reply" title={t('reader.replyTitle')} onClick={() => onReply('reply', last)}>{t('reader.reply')}</Button>
        {(last.to?.length ?? 0) + (last.cc?.length ?? 0) > 1 &&
          <Button icon="replyAll" title={t('reader.replyAllTitle')} onClick={() => onReply('replyAll', last)}>{t('reader.replyAll')}</Button>}
        <Button icon="forward" title={t('reader.forwardTitle')} onClick={() => onReply('forward', last)}>{t('reader.forward')}</Button>
      </div>
      {footer}
    </article>
  );
}

function Message({ client, m, me, inJunk, onFold, onUnsubscribe, onRsvp, onReceipt }: {
  client: Jmap; m: EmailFull; me: string; inJunk: boolean; onFold?: () => void; onUnsubscribe: (m: EmailFull) => void;
  onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void>;
  onReceipt: (m: EmailFull, send: boolean) => void;
}) {
  const [showImages, setShowImages] = useState(false);
  const [inline, setInline] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [assist, setAssist] = useState<{ kind: 'translation' | 'summary'; text: string; note: string } | null>(null);
  const [assisting, setAssisting] = useState('');
  // Encrypted mail is opened here, on this device; what's shown is the decrypted message.
  // Encrypted or signed: show exactly the part that was decrypted / checked, never the server's own parse of it.
  const secure = useSecureMail(client, m, me, inJunk);
  const shown = secure.state?.mail ?? m;
  // Prefer the sender's plain-text part; from HTML, only what a reader can actually see (see visibleText).
  const plain = (shown.text || (shown.html ? visibleText(shown.html) : '')).trim();
  async function help(kind: 'translation' | 'summary') {
    setAssisting(kind === 'translation' ? t('reader.translating') : t('reader.summarising'));
    try {
      if (kind === 'summary') setAssist({ kind, text: await summarize(plain), note: t('reader.summaryNote') });
      else {
        const tr = await translate(plain);
        setAssist(tr ? { kind, text: tr.text, note: t('reader.translatedFrom', { language: languageName(tr.from) }) } : { kind: 'summary', text: '', note: t('reader.alreadyYourLanguage') });
      }
    } catch (e) { setAssist({ kind: 'summary', text: '', note: (e as Error).message }); }
    finally { setAssisting(''); }
  }
  // Images embedded in the message (cid:) are fetched with our credentials and handed to the frame as data: URLs.
  const embedded = useMemo(() => m.attachments.filter((a) => a.cid && m.html?.includes(`cid:${a.cid}`)), [m]);
  useEffect(() => {
    let live = true;
    Promise.all(embedded.map(async (a) => [a.cid!, await toDataUrl(await client.download(a))] as const))
      .then((pairs) => live && setInline(Object.fromEntries(pairs)), () => {});
    return () => { live = false; };
  }, [embedded]);
  const html = useMemo(() => (shown.html ? buildSrcdoc(shown.html, showImages, { ...inline, ...secure.state?.inline }) : null), [shown.html, showImages, inline, secure.state]);
  const files = secure.state?.mail ? [] /* SecureBanner lists the checked files */ : m.attachments.filter((a) => !embedded.includes(a) && !(secure.kind && isCryptoPart(a)));
  // Large files sent as download links (signup/files.mjs) look like attachments too.
  const links = useMemo(() => fileLinks(`${shown.html ?? ''} ${shown.text ?? ''}`, location.origin), [shown.html, shown.text]);
  const sender = m.from?.[0];
  return (
    <section className="message">
      <header onClick={onFold} className={onFold ? 'foldable' : ''}>
        <span className="avatar" aria-hidden="true" style={{ '--h': hue(sender?.email ?? '') } as React.CSSProperties}>
          {displayName(sender).slice(0, 1).toUpperCase()}
        </span>
        <div className="addr">
          <span className="who">{displayName(sender, me)}{sender?.name && <span className="email"> {sender.email}</span>}</span>
          <span className="to">{t(m.cc?.length ? 'reader.toCc' : 'reader.to', { to: formatAddresses(m.to) || t('reader.undisclosed'), cc: formatAddresses(m.cc) })}</span>
        </div>
        <span className="meta-right">
          {m.unsubscribe && <Button variant="link" onClick={(e) => { e.stopPropagation(); onUnsubscribe(m); }}>{t('reader.unsubscribe')}</Button>}
          <time dateTime={m.receivedAt} title={new Date(m.receivedAt).toLocaleString(locale())}>{longDate(m.receivedAt)}</time>
        </span>
      </header>
      {plain.length > 40 && (canTranslate() || canSummarize()) && (
        <p className="assist-links">
          {canTranslate() && assist?.kind !== 'translation' && <Button variant="link" disabled={!!assisting} onClick={() => help('translation')}>{t('reader.translate')}</Button>}
          {canSummarize() && plain.length > 600 && <Button variant="link" disabled={!!assisting} onClick={() => help('summary')}>{t('reader.summarize')}</Button>}
          {assisting && <span className="fine">{assisting}</span>}
        </p>
      )}
      {assist?.kind === 'summary' && (
        <div className="assist" role="note" aria-label={t('reader.summaryLabel')}>
          <span className="grow"><span className="fine">{assist.note}</span>{assist.text && <span className="assist-text">{assist.text}</span>}</span>
          <Button variant="quiet" size="sm" icon="close" label={t('common.close')} onClick={() => setAssist(null)} />
        </div>
      )}
      <Invitation client={client} m={m} onRsvp={onRsvp} />
      <SecureBanner me={me} m={m} {...secure} />
      {sender?.email.toLowerCase() === me.toLowerCase() && <ConfidentialSent client={client} body={`${shown.html ?? ''} ${shown.text ?? ''}`} />}
      {m.receiptTo?.length && !m.keywords.$mdnsent && m.from?.[0]?.email.toLowerCase() !== me.toLowerCase() ? (
        <p className="banner banner--info">
          <Icon name="receipt" size={16} />
          <span className="grow">{t(m.receiptTo[0].email.toLowerCase() !== m.from?.[0]?.email.toLowerCase() ? 'reader.receiptAskOther' : 'reader.receiptAsk', { name: displayName(m.from?.[0]), email: m.receiptTo[0].email })}</span>
          <Button variant="link" onClick={() => onReceipt(m, true)}>{t('reader.sendReceipt')}</Button>
          <Button variant="link" onClick={() => onReceipt(m, false)}>{t('reader.ignore')}</Button>
        </p>
      ) : null}
      {html && html.trackers.length > 0 && (
        <p className="banner banner--safe"><Icon name="shield" size={16} />
          {t('reader.trackers', { count: html.trackers.length, hosts: html.trackers.join(', ') })}
        </p>
      )}
      {html && html.blockedImages > 0 && (
        <p className="banner banner--info">
          <span>{t('reader.imagesHidden', { count: html.blockedImages })}</span>
          <Button variant="link" onClick={() => setShowImages(true)}>{t('reader.loadImages')}</Button>
        </p>
      )}
      {assist?.kind === 'translation' ? (
        <>
          <p className="fine assist-note">{assist.note} · <Button variant="link" onClick={() => setAssist(null)}>{t('reader.showUntranslated')}</Button></p>
          <div className="letter">{assist.text}</div>
        </>
      ) : html
        ? <MessageFrame title={t('reader.messageFrom', { name: displayName(sender) })} srcdoc={html.srcdoc} />
        : <div className="letter">{shown.text}</div>}
      {files.length + links.length > 0 && (
        <ul className="chips" aria-label={t('reader.attachments')}>
          {files.map((a) => (
            <li key={a.blobId + a.name}>
              <button className="chip" onClick={() => (previewKind(a) ? setPreview(a) : save(client, a).catch(() => notify(a.name ? t('reader.couldntDownload', { name: a.name }) : t('reader.couldntDownloadFile'), t('reader.checkConnection'))))}
                title={previewKind(a) ? (a.name ? t('reader.preview', { name: a.name }) : t('reader.previewFile')) : (a.name ? t('reader.downloadName', { name: a.name }) : t('reader.downloadFile'))}>
                <Icon name="file" size={16} /><span className="fname">{a.name ?? t('reader.untitledFile')}</span>
                <span className="fsize">{fileSize(a.size)}</span><Icon name={previewKind(a) ? 'search' : 'download'} size={16} />
              </button>
            </li>
          ))}
          {links.map((l) => (
            <li key={l.url}>
              <a className="chip" href={l.url} target="_blank" rel="noopener noreferrer" title={t('reader.downloadName', { name: l.name })}>
                <Icon name="file" size={16} /><span className="fname">{l.name}</span>
                <span className="fsize">{fileSize(l.size)}</span><span className="flink">{t('reader.download')}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {preview && <Preview client={client} a={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

// Raster images, PDFs (the browser's viewer) and plain text open in place. Never SVG: its blob: URL would be
// same-origin, and "open image in new tab" would run its scripts as this app. SVGs download like any file.
const previewKind = (a: Attachment) => /^image\/(png|jpe?g|gif|webp|avif|bmp)$/i.test(a.type) ? 'image'
  : /^application\/pdf$/i.test(a.type) ? 'pdf' : /^text\/(plain|csv)$/i.test(a.type) && a.size < 1_000_000 ? 'text' : null;

function Preview({ client, a, onClose }: { client: Jmap; a: Attachment; onClose: () => void }) {
  const [src, setSrc] = useState<{ url: string; text?: string } | null>(null);
  const [err, setErr] = useState('');
  const kind = previewKind(a);
  useEffect(() => {
    let url = '';
    client.download(a).then(async (b) => {
      // Re-type the blob ourselves: the browser must treat it as the kind we checked, whatever the sender claimed.
      const typed = new Blob([b], { type: kind === 'pdf' ? 'application/pdf' : kind === 'text' ? 'text/plain;charset=utf-8' : a.type });
      url = URL.createObjectURL(typed);
      setSrc({ url, text: kind === 'text' ? await typed.text() : undefined });
    }, () => setErr(t('reader.couldntLoadFile')));
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => { if (url) URL.revokeObjectURL(url); window.removeEventListener('keydown', esc, true); };
  }, [a]);
  // Portal: the reader pane is its own containing block, so a fixed overlay inside it wouldn't cover the page.
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div className="att-preview" role="dialog" aria-label={a.name ? t('reader.previewOf', { name: a.name }) : t('reader.previewOfAttachment')} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <span className="fname">{a.name ?? t('reader.untitledFile')}</span><span className="fsize">{fileSize(a.size)}</span>
          <Button size="sm" icon="download" onClick={() => save(client, a)}>{t('reader.download')}</Button>
          <Button variant="quiet" size="sm" icon="close" label={t('reader.closePreview')} onClick={onClose} />
        </header>
        <div className="att-preview-body">
          {err ? <p className="error">{err}</p> : !src ? <p className="fine">{t('common.loading')}</p>
            : kind === 'image' ? <img src={src.url} alt={a.name ?? t('reader.attachment')} />
            : kind === 'pdf' ? <iframe title={a.name ?? 'PDF'} src={src.url} />
            : <pre>{src.text}</pre>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

async function save(client: Jmap, a: Attachment) {
  const url = URL.createObjectURL(await client.download(a));
  const link = Object.assign(document.createElement('a'), { href: url, download: a.name ?? 'attachment' });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const toDataUrl = (b: Blob) => new Promise<string>((ok, fail) => {
  const r = new FileReader(); r.onload = () => ok(r.result as string); r.onerror = fail; r.readAsDataURL(b);
});

// Stable per-sender colour so the same person always looks the same.
function hue(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

export function shortDate(iso: string) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString(locale(), d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}
const longDate = (iso: string) => new Date(iso).toLocaleString(locale(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Invitations (text/calendar attachments): what, when, where, and Yes / Maybe / No (sent to the organizer). */
function Invitation({ client, m, onRsvp }: { client: Jmap; m: EmailFull; onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void> }) {
  const ics = m.attachments.find((a) => /text\/calendar/i.test(a.type) || /\.ics$/i.test(a.name ?? ''));
  const [ev, setEv] = useState<CalEvent | null>(null);
  const [busy, setBusy] = useState<PartStat | null>(null);
  useEffect(() => { if (ics) client.parseInvite(ics.blobId).then((l) => setEv(l[0] ?? null), () => {}); }, [ics?.blobId]);
  if (!ev || !ics) return null;
  const answer = (['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const).find((p) => m.keywords[`$rsvp-${p.toLowerCase()}`]);
  const { start, end } = span(ev);
  const when = ev.allDay ? start.toLocaleDateString(locale(), { weekday: 'long', month: 'long', day: 'numeric' })
    : `${start.toLocaleString(locale(), { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })}`;
  const opt = (status: PartStat, label: string) => (
    <Button size="sm" variant={answer === status ? 'primary' : 'secondary'} pressed={answer === status} disabled={!!busy}
      onClick={async () => { setBusy(status); try { await onRsvp(m, ics, status); } finally { setBusy(null); } }}>
      {busy === status ? t('reader.rsvpSending') : label}
    </Button>
  );
  return (
    <div className="banner banner--info invite">
      <Icon name="calendar" size={16} />
      <span className="what"><b>{ev.title || t('reader.invitation')}</b>, {when}{ev.location ? `, ${ev.location}` : ''}</span>
      <span className="rsvp" role="group" aria-label={t('reader.yourAnswer')}>
        <span className="q">{answer ? t('reader.yourAnswer') : t('reader.going')}</span>
        {opt('ACCEPTED', t('reader.yes'))}{opt('TENTATIVE', t('reader.maybe'))}{opt('DECLINED', t('reader.no'))}
      </span>
    </div>
  );
}

/** Two or three short replies, written on this device. Only when the model is already there (no surprise download). */
function SmartReplies({ m, me, onPick }: { m: EmailFull; me: string; onPick: (text: string) => void }) {
  const [ideas, setIdeas] = useState<string[]>([]);
  useEffect(() => {
    setIdeas([]);
    const from = m.from?.[0]?.email ?? '';
    if (!canSuggestReplies() || !from || from.toLowerCase() === me.toLowerCase() || m.unsubscribe) return; // people, not newsletters
    let live = true;
    (async () => {
      const g = globalThis as { LanguageModel?: { availability(): Promise<string> } };
      if ((await g.LanguageModel!.availability()) !== 'available') return;
      const text = (m.text || (m.html ? visibleText(m.html) : '')).trim();
      if (text.length < 10) return;
      const out = await suggestReplies(text, displayName(m.from?.[0])).catch(() => []);
      if (live) setIdeas(out);
    })();
    return () => { live = false; };
  }, [m.id]);
  if (!ideas.length) return null;
  return (
    <div className="smart-replies" role="group" aria-label={t('reader.suggestedReplies')}>
      {ideas.map((idea) => <button key={idea} className="filter-chip" onClick={() => onPick(idea)}>{idea}</button>)}
    </div>
  );
}

/** The message, sized to its content (no scroll inside a scroll). allow-same-origin without allow-scripts: the message
 *  still can't run anything (sandbox + CSP), but we can measure it and check its links. */
function MessageFrame({ title, srcdoc }: { title: string; srcdoc: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const f = ref.current!;
    let ro: ResizeObserver | undefined;
    const onClick = async (e: MouseEvent) => {
      const a = (e.target as Element).closest?.('a[href]') as HTMLAnchorElement | null;
      const claimed = a && claimedHost(a.textContent ?? '');
      if (!a || !claimed || sameSite(claimed, a.hostname)) return;
      e.preventDefault();
      if (!/^https?:$/.test(a.protocol)) return; // only web addresses are ever opened from here
      if (await confirmIt({ title: t('reader.linkTitle'), danger: true, confirm: t('reader.openAnyway'),
        body: t('reader.linkBody', { claimed, host: a.hostname }) })) window.open(a.href, '_blank', 'noopener');
    };
    const setup = () => {
      const d = f.contentDocument; if (!d) return;
      const fit = () => { f.style.height = `${d.documentElement.scrollHeight}px`; };
      ro?.disconnect(); ro = new ResizeObserver(fit); ro.observe(d.documentElement); fit();
      d.addEventListener('click', onClick);
    };
    f.addEventListener('load', setup);
    return () => { f.removeEventListener('load', setup); ro?.disconnect(); };
  }, [srcdoc]);
  return <iframe ref={ref} title={title} sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcDoc={srcdoc} />;
}
/** The site a link's text names ("https://bank.com/login", "www.bank.com"), if it names one. */
export function claimedHost(text: string) {
  const m = /^\s*(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?:[\/:?#]\S*)?\s*$/i.exec(text);
  return m?.[1].toLowerCase();
}
const site = (h: string) => h.toLowerCase().replace(/^www\./, '');
export const sameSite = (a: string, b: string) => { const x = site(a), y = site(b); return x === y || y.endsWith('.' + x) || x.endsWith('.' + y); };
