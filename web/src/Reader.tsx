import { useEffect, useMemo, useRef, useState } from 'react';
import { notify } from './Dialog';
import { createPortal } from 'react-dom';
import type { Attachment, EmailFull, Jmap, Mailbox } from './jmap';
import { Button } from './Button';
import { Icon } from './icons';
import { displayName, fileSize, formatAddresses, type ReplyMode } from './mailutil';
import { canSummarize, canTranslate, languageName, summarize, translate, visibleText } from './ai';
import { buildSrcdoc } from './safeHtml';
import { span, type CalEvent } from './calendar';
import type { PartStat } from './ics';
import { Menu, TimeChoices } from './Menu';

export type Action = 'archive' | 'trash' | 'junk' | 'unread' | 'star' | 'mute';
export type MoreAction = 'original' | 'print' | 'block' | 'filter' | 'addContact' | 'unmute';

export function Reader({ client, me, messages, error, inTrash, inJunk, folders, onAction, onReply, onBack, onSnooze, onMoveTo, onUnsubscribe, onMore, onRsvp, onReceipt }: {
  client: Jmap; me: string; messages: EmailFull[] | null; error: string; inTrash: boolean; inJunk: boolean;
  /** Folders the user created (moving/labelling targets). */
  folders: Mailbox[];
  onAction: (a: Action) => void; onReply: (mode: ReplyMode, e: EmailFull) => void; onBack: () => void;
  onSnooze: (until: Date) => void;
  /** mailboxId, or null to create a folder first; label=true keeps it where it is too. */
  onMoveTo: (mailboxId: string | null, label: boolean) => void;
  onUnsubscribe: (m: EmailFull) => void;
  onMore: (what: MoreAction, m: EmailFull) => void;
  onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void>;
  onReceipt: (m: EmailFull, send: boolean) => void;
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
        <Button variant="quiet" icon="back" label="Back to list" className="only-mobile" onClick={onBack} />
        {!inTrash && <Button variant="quiet" icon="archive" label="Archive" shortcut="e" onClick={() => onAction('archive')} />}
        <Button variant="quiet" icon="trash" label={inTrash ? 'Delete forever' : 'Delete'} shortcut="#" onClick={() => onAction('trash')} />
        <Button variant="quiet" icon="junk" label={inJunk ? 'Not spam' : 'Report spam'} shortcut="!" onClick={() => onAction('junk')} />
        <Button variant="quiet" icon="unread" label="Mark as unread" shortcut="u" onClick={() => onAction('unread')} />
        <Button variant="quiet" icon="star" label={starred ? 'Unstar' : 'Star'} shortcut="s" pressed={starred} onClick={() => onAction('star')} />
        <span className="tool-sep" />
        <Menu label="Snooze" button={<Button variant="quiet" icon="clock" label="Snooze" />}>
          {(close) => <><p className="menu-title">Snooze until…</p><TimeChoices verb="Snooze" close={close} onPick={onSnooze} /></>}
        </Menu>
        {(['move', 'label'] as const).map((mode) => (
          <Menu key={mode} label={mode === 'move' ? 'Move to' : 'Label as'}
            button={<Button variant="quiet" icon={mode === 'move' ? 'folder' : 'tag'} label={mode === 'move' ? 'Move to folder' : 'Label as'} />}>
            {(close) => <>
              <p className="menu-title">{mode === 'move' ? 'Move to' : 'Label as'}</p>
              {folders.map((f) => <button key={f.id} className="menu-item" role="menuitem" onClick={() => { close(); onMoveTo(f.id, mode === 'label'); }}><Icon name="folder" size={16} />{f.name}</button>)}
              <button className="menu-item" role="menuitem" onClick={() => { close(); onMoveTo(null, mode === 'label'); }}><Icon name="compose" size={16} />New folder…</button>
            </>}
          </Menu>
        ))}
        <Menu label="More" align="right" button={<Button variant="quiet" icon="more" label="More" />}>
          {(close) => {
            const sender = last.from?.[0]?.email;
            const item = (what: MoreAction, icon: Parameters<typeof Icon>[0]['name'], text: string) =>
              <button className="menu-item" role="menuitem" onClick={() => { close(); onMore(what, last); }}><Icon name={icon} size={16} />{text}</button>;
            return <>
              {muted ? item('unmute', 'unread', 'Unmute')
                : <button className="menu-item" role="menuitem" onClick={() => { close(); onAction('mute'); }}><Icon name="mute" size={16} />Mute (new replies skip your Inbox)</button>}
              {item('print', 'print', 'Print')}
              {item('original', 'file', 'Show original')}
              {sender && sender.toLowerCase() !== me.toLowerCase() && <>
                {item('addContact', 'compose', 'Add sender to contacts')}
                {item('filter', 'tag', 'Filter messages like this')}
                {item('block', 'junk', `Block ${sender}`)}
              </>}
            </>;
          }}
        </Menu>
      </div>

      {muted && <p className="banner" role="status"><Icon name="mute" size={16} /><span className="grow">Muted: new replies in this conversation skip your Inbox.</span><Button variant="link" onClick={() => onMore('unmute', last)}>Unmute</Button></p>}
      <h1 className="subject">{last.subject?.replace(/^((re|fwd?|aw|sv)\s*:\s*)+/i, '') || '(no subject)'}</h1>

      {messages.map((m) => open.has(m.id)
        ? <Message key={m.id} client={client} m={m} me={me} onUnsubscribe={onUnsubscribe} onRsvp={onRsvp} onReceipt={onReceipt} onFold={messages.length > 1 ? () => setOpen((s) => { const n = new Set(s); n.delete(m.id); return n; }) : undefined} />
        : (
          <button key={m.id} className="folded" onClick={() => setOpen((s) => new Set(s).add(m.id))}>
            <span className="who">{displayName(m.from?.[0], me)}</span>
            <span className="snippet">{m.preview}</span>
            <time>{shortDate(m.receivedAt)}</time>
          </button>
        ))}

      <div className="reply-bar">
        <Button icon="reply" title="Reply (r)" onClick={() => onReply('reply', last)}>Reply</Button>
        {(last.to?.length ?? 0) + (last.cc?.length ?? 0) > 1 &&
          <Button icon="replyAll" title="Reply all (a)" onClick={() => onReply('replyAll', last)}>Reply all</Button>}
        <Button icon="forward" title="Forward (f)" onClick={() => onReply('forward', last)}>Forward</Button>
      </div>
    </article>
  );
}

function Message({ client, m, me, onFold, onUnsubscribe, onRsvp, onReceipt }: {
  client: Jmap; m: EmailFull; me: string; onFold?: () => void; onUnsubscribe: (m: EmailFull) => void;
  onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void>;
  onReceipt: (m: EmailFull, send: boolean) => void;
}) {
  const [showImages, setShowImages] = useState(false);
  const [inline, setInline] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<Attachment | null>(null);
  const [assist, setAssist] = useState<{ kind: 'translation' | 'summary'; text: string; note: string } | null>(null);
  const [assisting, setAssisting] = useState('');
  // Prefer the sender's plain-text part; from HTML, only what a reader can actually see (see visibleText).
  const plain = (m.text || (m.html ? visibleText(m.html) : '')).trim();
  async function help(kind: 'translation' | 'summary') {
    setAssisting(kind === 'translation' ? 'Translating on this device…' : 'Summarising on this device…');
    try {
      if (kind === 'summary') setAssist({ kind, text: await summarize(plain), note: 'Summary of the sender’s message, made on this device. It can be wrong: check the message before acting on it.' });
      else {
        const t = await translate(plain);
        setAssist(t ? { kind, text: t.text, note: `Translated from ${languageName(t.from)} on this device` } : { kind: 'summary', text: '', note: 'This message is already in your language.' });
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
  const html = useMemo(() => (m.html ? buildSrcdoc(m.html, showImages, inline) : null), [m, showImages, inline]);
  const files = m.attachments.filter((a) => !embedded.includes(a));
  const sender = m.from?.[0];
  return (
    <section className="message">
      <header onClick={onFold} className={onFold ? 'foldable' : ''}>
        <span className="avatar" aria-hidden="true" style={{ '--h': hue(sender?.email ?? '') } as React.CSSProperties}>
          {displayName(sender).slice(0, 1).toUpperCase()}
        </span>
        <div className="addr">
          <span className="who">{displayName(sender, me)}{sender?.name && <span className="email"> {sender.email}</span>}</span>
          <span className="to">to {formatAddresses(m.to) || 'undisclosed recipients'}{m.cc?.length ? `, cc ${formatAddresses(m.cc)}` : ''}</span>
        </div>
        <span className="meta-right">
          {m.unsubscribe && <Button variant="link" onClick={(e) => { e.stopPropagation(); onUnsubscribe(m); }}>Unsubscribe</Button>}
          <time dateTime={m.receivedAt} title={new Date(m.receivedAt).toLocaleString()}>{longDate(m.receivedAt)}</time>
        </span>
      </header>
      {plain.length > 40 && (canTranslate() || canSummarize()) && (
        <p className="assist-links">
          {canTranslate() && assist?.kind !== 'translation' && <Button variant="link" disabled={!!assisting} onClick={() => help('translation')}>Translate</Button>}
          {canSummarize() && plain.length > 600 && <Button variant="link" disabled={!!assisting} onClick={() => help('summary')}>Summarize</Button>}
          {assisting && <span className="fine">{assisting}</span>}
        </p>
      )}
      {assist?.kind === 'summary' && (
        <div className="assist" role="note" aria-label="Summary of this message">
          <span className="grow"><span className="fine">{assist.note}</span>{assist.text && <span className="assist-text">{assist.text}</span>}</span>
          <Button variant="quiet" size="sm" icon="close" label="Close" onClick={() => setAssist(null)} />
        </div>
      )}
      <Invitation client={client} m={m} onRsvp={onRsvp} />
      {m.receiptTo?.length && !m.keywords.$mdnsent && m.from?.[0]?.email.toLowerCase() !== me.toLowerCase() ? (
        <p className="banner banner--info">
          <Icon name="receipt" size={16} />
          <span className="grow">{displayName(m.from?.[0])} asked to be told when you read this{m.receiptTo[0].email.toLowerCase() !== m.from?.[0]?.email.toLowerCase() ? ` (the receipt would go to ${m.receiptTo[0].email})` : ''}.</span>
          <Button variant="link" onClick={() => onReceipt(m, true)}>Send receipt</Button>
          <Button variant="link" onClick={() => onReceipt(m, false)}>Ignore</Button>
        </p>
      ) : null}
      {html && html.trackers.length > 0 && (
        <p className="banner banner--safe"><Icon name="shield" size={16} />
          Blocked {html.trackers.length === 1 ? 'a tracking pixel' : `${html.trackers.length} tracking pixels`} from {html.trackers.join(', ')}. The sender can’t see that you opened this.
        </p>
      )}
      {html && html.blockedImages > 0 && (
        <p className="banner banner--info">
          <span>{html.blockedImages === 1 ? '1 image is' : `${html.blockedImages} images are`} hidden to protect your privacy. Loading images can tell the sender you opened this.</span>
          <Button variant="link" onClick={() => setShowImages(true)}>Load images</Button>
        </p>
      )}
      {assist?.kind === 'translation' ? (
        <>
          <p className="fine assist-note">{assist.note} · <Button variant="link" onClick={() => setAssist(null)}>Show original</Button></p>
          <div className="letter">{assist.text}</div>
        </>
      ) : html
        ? <iframe title={`Message from ${displayName(sender)}`} sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={html.srcdoc} />
        : <div className="letter">{m.text}</div>}
      {files.length > 0 && (
        <ul className="chips" aria-label="Attachments">
          {files.map((a) => (
            <li key={a.blobId + a.name}>
              <button className="chip" onClick={() => (previewKind(a) ? setPreview(a) : save(client, a).catch(() => notify(`Couldn’t download ${a.name ?? 'the file'}`, 'Check your connection and try again.')))}
                title={previewKind(a) ? `Preview ${a.name ?? 'file'}` : `Download ${a.name ?? 'file'}`}>
                <Icon name="file" size={16} /><span className="fname">{a.name ?? 'Untitled file'}</span>
                <span className="fsize">{fileSize(a.size)}</span><Icon name={previewKind(a) ? 'search' : 'download'} size={16} />
              </button>
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
    }, () => setErr('Couldn’t load this file.'));
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', esc, true);
    return () => { if (url) URL.revokeObjectURL(url); window.removeEventListener('keydown', esc, true); };
  }, [a]);
  // Portal: the reader pane is its own containing block, so a fixed overlay inside it wouldn't cover the page.
  return createPortal(
    <div className="overlay" onMouseDown={onClose}>
      <div className="att-preview" role="dialog" aria-label={`Preview of ${a.name ?? 'attachment'}`} onMouseDown={(e) => e.stopPropagation()}>
        <header>
          <span className="fname">{a.name ?? 'Untitled file'}</span><span className="fsize">{fileSize(a.size)}</span>
          <Button size="sm" icon="download" onClick={() => save(client, a)}>Download</Button>
          <Button variant="quiet" size="sm" icon="close" label="Close preview" onClick={onClose} />
        </header>
        <div className="att-preview-body">
          {err ? <p className="error">{err}</p> : !src ? <p className="fine">Loading…</p>
            : kind === 'image' ? <img src={src.url} alt={a.name ?? 'Attachment'} />
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
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: 'short', day: 'numeric' } : { dateStyle: 'medium' });
}
const longDate = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** Invitations (text/calendar attachments): what, when, where, and Yes / Maybe / No (sent to the organizer). */
function Invitation({ client, m, onRsvp }: { client: Jmap; m: EmailFull; onRsvp: (m: EmailFull, ics: Attachment, status: PartStat) => Promise<void> }) {
  const ics = m.attachments.find((a) => /text\/calendar/i.test(a.type) || /\.ics$/i.test(a.name ?? ''));
  const [ev, setEv] = useState<CalEvent | null>(null);
  const [busy, setBusy] = useState<PartStat | null>(null);
  useEffect(() => { if (ics) client.parseInvite(ics.blobId).then((l) => setEv(l[0] ?? null), () => {}); }, [ics?.blobId]);
  if (!ev || !ics) return null;
  const answer = (['ACCEPTED', 'TENTATIVE', 'DECLINED'] as const).find((p) => m.keywords[`$rsvp-${p.toLowerCase()}`]);
  const { start, end } = span(ev);
  const when = ev.allDay ? start.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    : `${start.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} – ${end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  const opt = (status: PartStat, label: string) => (
    <Button size="sm" variant={answer === status ? 'primary' : 'secondary'} pressed={answer === status} disabled={!!busy}
      onClick={async () => { setBusy(status); try { await onRsvp(m, ics, status); } finally { setBusy(null); } }}>
      {busy === status ? 'Sending…' : label}
    </Button>
  );
  return (
    <div className="banner banner--info invite">
      <Icon name="calendar" size={16} />
      <span className="what"><b>{ev.title || 'Invitation'}</b>, {when}{ev.location ? `, ${ev.location}` : ''}</span>
      <span className="rsvp" role="group" aria-label="Your answer">
        <span className="q">{answer ? 'Your answer' : 'Going?'}</span>
        {opt('ACCEPTED', 'Yes')}{opt('TENTATIVE', 'Maybe')}{opt('DECLINED', 'No')}
      </span>
    </div>
  );
}
