import { useEffect, useRef, useState } from 'react';
import { chooseIt, confirmIt, promptIt } from './Dialog';
import type { Address, Attachment, Draft, SharedFile, Template } from './jmap';
import { Button } from './Button';
import { Icon, type IconName } from './icons';
import { cleanHtml, fileLinkHtml, fileLinks, fileSize, formatAddresses, htmlToText, isReplyLead, parseAddresses, signatureHtml, type Signature } from './mailutil';
import { RecipientInput } from './RecipientInput';
import { canRewrite, rewrite, type RewriteStyle } from './ai';
import { Menu, TimeChoices } from './Menu';
import { ensureUnlocked, useRecipientKeys } from './Encryption';
import { t } from './i18n';
import { confidentialUrl, seal } from './seal';
import { ConfidentialBar, confidentialHtml, type ConfidentialDays } from './Confidential';
import { useSmartCompose } from './SmartCompose';
import { FormatBar, ImageSize, ScheduleMenu } from './ComposeExtras';
import type { CalEvent } from './calendar';

export interface ComposeApi {
  upload: (f: File) => Promise<Attachment>;
  save: (d: Draft) => Promise<string>;
  discard: (id: string) => Promise<void>;
  /** Fetch an attachment's bytes (to show embedded images inside the editor). */
  download: (a: Attachment) => Promise<Blob>;
  templates: () => Promise<Template[]>;
  saveTemplate: (d: Draft) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
  /** Large files go to the sender's storage as a download link (absent: the server can't, so they're attached). */
  share?: (f: File, expiresDays: 1 | 7 | 30 | 0) => Promise<SharedFile>;
  /** Biggest attachment the server takes (session maxSizeUpload). */
  maxUpload?: number;
  /** Your calendar, for "Help me schedule" (absent: no calendar). */
  events?: (from: Date, to: Date) => Promise<CalEvent[]>;
}

/** A contact group offered in recipient autocomplete; picking it adds every member. */
export interface RecipientGroup { name: string; members: Address[] }
const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 860px)').matches;

// Most mail servers (Gmail, Outlook) refuse messages over 25 MB, and attachments grow by a third on the way.
const LINK_OVER = 25 * 1024 * 1024;

const AUTOSAVE_MS = 2500;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// ponytail: formatting uses document.execCommand. It's deprecated on paper but every browser still ships it,
// and it's a few lines instead of an editor framework. Swap for a real editor model if we need tables or images.
const exec = (cmd: string, arg?: string) => document.execCommand(cmd, false, arg);

export function Compose({ initial, contacts, groups, api, signatures, identities, onSend, onClose, minimized, onMinimize, onPopOut, onSaved }: {
  initial: Draft; contacts: Address[]; groups?: RecipientGroup[]; api: ComposeApi; signatures: Signature[];
  /** Addresses this account can send from; the first is the main one. A From menu appears when there are several. */
  identities: { name: string; email: string }[];
  onSend: (d: Draft, sendAt?: Date) => void; onClose: (outcome: 'saved' | 'discarded' | 'closed') => void;
  /** Several drafts at once: shown as a bar along the bottom (absent: Esc closes, as in a popped-out window). */
  minimized?: boolean; onMinimize?: (min: boolean) => void;
  /** Open this draft in its own window (after saving it). */
  onPopOut?: (draftId: string) => void;
  /** Every autosave's new draft id (each save replaces the previous copy). */
  onSaved?: (id: string) => void;
}) {
  const [to, setTo] = useState(formatAddresses(initial.to));
  const [cc, setCc] = useState(formatAddresses(initial.cc));
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [bcc, setBcc] = useState(formatAddresses(initial.bcc ?? []));
  const [showBcc, setShowBcc] = useState(!!initial.bcc?.length);
  const [from, setFrom] = useState(initial.from ?? identities[0]?.email ?? '');
  const [subject, setSubject] = useState(initial.subject);
  const [files, setFiles] = useState<Attachment[]>(initial.attachments);
  const [receipt, setReceipt] = useState(!!initial.receipt);
  const [followUp, setFollowUp] = useState<number | undefined>(initial.followUpDays);
  const [encrypt, setEncrypt] = useState(!!initial.encrypt);
  // ponytail: "Send confidentially" lives in this window only; a draft reopened later is a normal message again.
  const [confidential, setConfidential] = useState<ConfidentialDays | null>(null);
  const [passcode, setPasscode] = useState('');
  // ponytail: your key is kept under the account's main address (identities[0]), which is its sign-in name.
  const me = identities[0]?.email ?? '';
  const keys = useRecipientKeys([to, showCc ? cc : '', showBcc ? bcc : ''], me);
  const [uploading, setUploading] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [edits, setEdits] = useState(0); // bumps on every change; drives autosave
  const editor = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftId = useRef(initial.id);
  const saving = useRef<Promise<void>>(Promise.resolve());
  const changed = () => { setEdits((n) => n + 1); setError(''); };
  const smart = useSmartCompose(editor);
  const [moreFmt, setMoreFmt] = useState(false);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  // Menus take focus; formatting from them goes back to where the cursor was.
  const lastRange = useRef<Range | null>(null);
  const restore = () => {
    const ed = editor.current!, sel = getSelection();
    ed.focus();
    if (lastRange.current && ed.contains(lastRange.current.startContainer)) { sel?.removeAllRanges(); sel?.addRange(lastRange.current); }
  };
  /** Colour and size as inline styles (cleanHtml keeps those); bold and the rest stay plain tags. */
  const styled = (cmd: string, arg: string) => { restore(); exec('styleWithCSS', 'true'); exec(cmd, arg); exec('styleWithCSS', 'false'); changed(); };
  const insertHtml = (html: string) => {
    restore(); exec('insertHTML', html);
    editor.current!.querySelectorAll<HTMLElement>('table:not([style])').forEach((tb) => { tb.style.borderCollapse = 'collapse'; }); // insertHTML drops it
    changed();
  };
  const insertText = (text: string) => { restore(); exec('insertText', text); changed(); };
  /** A pasted picture goes into the text (an inline cid: image), shown at once and uploaded behind it. */
  const blobUrls = useRef<string[]>([]);
  useEffect(() => () => blobUrls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  async function embed(f: File) {
    const cid = `${crypto.randomUUID()}@openmail`, url = URL.createObjectURL(f);
    blobUrls.current.push(url);
    exec('insertHTML', `<img src="${url}" data-cid="${cid}" alt="" style="max-width: 100%">`);
    setUploading((n) => n + 1);
    try { const a = await api.upload(f); setFiles((fs) => [...fs, { ...a, cid, disposition: 'inline' }]); changed(); }
    catch (e) { editor.current?.querySelector(`img[data-cid="${cid}"]`)?.remove(); setError(t('compose.fileError', { name: f.name, error: (e as Error).message })); }
    finally { setUploading((n) => n - 1); }
  }

  useEffect(() => {
    const ed = editor.current!;
    // The editor lives in our own origin, so it only ever receives sanitized HTML (an <img onerror> here would run as us).
    // Embedded images (cid:) can't be loaded by the browser directly. Move the reference to data-cid before the
    // HTML reaches the page (so nothing tries to fetch cid:), then show each from a temporary blob: URL fetched with
    // our credentials. snapshot() turns them back into cid: references.
    const doc = new DOMParser().parseFromString(cleanHtml(initial.html), 'text/html');
    doc.querySelectorAll('img[src^="cid:" i]').forEach((img) => {
      img.setAttribute('data-cid', img.getAttribute('src')!.slice(4).replace(/^<|>$/g, ''));
      img.removeAttribute('src');
    });
    ed.innerHTML = doc.body.innerHTML || '<div><br></div>';
    const urls: string[] = [];
    for (const img of ed.querySelectorAll<HTMLImageElement>('img[data-cid]')) {
      const a = initial.attachments.find((x) => x.cid === img.dataset.cid);
      if (a) api.download(a).then((b) => { const u = URL.createObjectURL(b); urls.push(u); img.src = u; }, () => {});
    }
    // Replies start in the body, above the quote; new messages and forwards start at To.
    if (initial.to.length) {
      ed.focus();
      const r = document.createRange(); r.setStart(ed, 0); r.collapse(true);
      getSelection()?.removeAllRanges(); getSelection()?.addRange(r);
    } else toRef.current?.focus();
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  /** Rewrite the selection (or the text above the signature and quote) on this device, then put it back in place. */
  async function polish(style: RewriteStyle) {
    const ed = editor.current!, sel = getSelection();
    let range = sel?.rangeCount && ed.contains(sel.anchorNode) && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
    if (!range) {
      // Whole message: everything before the signature or the quoted reply.
      range = document.createRange(); range.setStart(ed, 0);
      const stop = ed.querySelector('[data-sig], blockquote');
      if (stop) range.setEndBefore(isReplyLead(stop.previousElementSibling?.textContent) ? stop.previousElementSibling! : stop); else range.setEnd(ed, ed.childNodes.length);
    }
    const text = range.toString().trim();
    if (!text) return setError(t('compose.writeFirst'));
    setStatus(t('compose.rewriting'));
    try {
      const out = await rewrite(text, style);
      ed.focus(); sel?.removeAllRanges(); sel?.addRange(range);
      exec('insertText', out); // one undo step: ⌘Z brings your words back
      setStatus(t('compose.rewritten')); changed();
    } catch (e) { setStatus(''); setError((e as Error).message); }
  }

  /** Swap the signature block in place (or add / remove it), leaving everything else as written. */
  function applySignature(sg: Signature | null) {
    const ed = editor.current!, old = ed.querySelector('[data-sig]');
    if (!sg) old?.remove();
    else {
      const tpl = document.createElement('template'); tpl.innerHTML = signatureHtml(sg.text);
      const block = tpl.content.firstElementChild!;
      // No signature yet: right after the first line, above any quoted text (same place new drafts get it).
      if (old) old.replaceWith(block); else if (ed.firstElementChild) ed.firstElementChild.after(block); else ed.append(block);
    }
    changed();
  }

  const snapshot = (): Draft => {
    // Back from blob: previews to cid: references; drop embedded images the user deleted from the text.
    const copy = editor.current!.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('[data-ghost]').forEach((g) => g.remove()); // a Smart Compose suggestion isn't text yet
    copy.querySelectorAll('img[data-cid]').forEach((img) => { img.setAttribute('src', `cid:${img.getAttribute('data-cid')}`); img.removeAttribute('data-cid'); });
    const html = copy.innerHTML;
    const attachments = files.filter((a) => !a.cid || html.includes(`cid:${a.cid}`));
    return {
      ...initial, id: draftId.current, subject: subject.trim(), html, text: htmlToText(html), attachments, receipt,
      to: parseAddresses(to).list, cc: parseAddresses(showCc ? cc : '').list, bcc: parseAddresses(showBcc ? bcc : '').list,
      from: from || undefined, followUpDays: followUp, encrypt: encrypt || undefined,
    };
  };

  function save() {
    // Saves run one after another, each replacing the previous copy in Drafts.
    saving.current = saving.current.then(async () => {
      setStatus(t('common.saving'));
      try { draftId.current = await api.save(snapshot()); setStatus(t('compose.draftSaved')); onSaved?.(draftId.current); }
      catch { setStatus(t('compose.couldntSaveDraft')); }
    });
    return saving.current;
  }

  useEffect(() => {
    if (!edits) return;
    const timer = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [edits]);

  async function attach(list: FileList | File[]) {
    let total = files.reduce((n, a) => n + a.size, 0);
    for (const f of [...list]) {
      if (api.share && f.size + total > Math.min(LINK_OVER, api.maxUpload ?? Infinity)) { await shareLink(f); continue; }
      total += f.size;
      setUploading((n) => n + 1);
      try { const a = await api.upload(f); setFiles((fs) => [...fs, a]); changed(); }
      catch (e) { setError(t('compose.fileError', { name: f.name, error: (e as Error).message })); }
      finally { setUploading((n) => n - 1); }
    }
  }

  /** Too big to attach: upload it to the sender's storage and put a download link in the message instead. */
  async function shareLink(f: File) {
    const days = await chooseIt({ title: t('compose.tooBig', { name: f.name }), label: t('compose.linkWorksFor'),
      body: t('compose.tooBigBody', { size: fileSize(f.size) }),
      value: '30', options: [['7', t('compose.days', { count: 7 })], ['30', t('compose.days', { count: 30 })], ['0', t('compose.untilRemoved')]], confirm: t('compose.uploadAndLink') });
    if (days === null) return;
    setUploading((n) => n + 1);
    try {
      const tpl = document.createElement('template'); tpl.innerHTML = fileLinkHtml(await api.share!(f, Number(days) as 7 | 30 | 0));
      // Above the signature and any quoted reply, like a line you'd type there.
      const ed = editor.current!, stop = ed.querySelector('[data-sig], blockquote');
      const at = isReplyLead(stop?.previousElementSibling?.textContent) ? stop!.previousElementSibling : stop;
      if (at) at.before(tpl.content); else ed.append(tpl.content);
      changed();
    } catch (e) { setError(t('compose.fileError', { name: f.name, error: (e as Error).message })); }
    finally { setUploading((n) => n - 1); }
  }

  async function close() {
    if (edits) { await save(); onClose('saved'); } else onClose('closed');
  }

  /** Esc: down to a bar along the bottom (several drafts side by side); on phones and in its own window, close. */
  const minimize = () => (onMinimize && !phone() ? onMinimize(true) : close());

  async function popOut() {
    await save();
    if (draftId.current) onPopOut?.(draftId.current);
  }

  async function discard() {
    const hasContent = htmlToText(editor.current!.innerHTML).trim() || subject.trim() || files.length;
    if (hasContent && !(await confirmIt({ title: t('compose.discardTitle'), body: t('compose.discardBody'), confirm: t('compose.discard'), danger: true }))) return;
    await saving.current;
    if (draftId.current) await api.discard(draftId.current).catch(() => {});
    onClose('discarded');
  }

  async function send(sendAt?: Date) {
    const tt = parseAddresses(to), c = parseAddresses(showCc ? cc : ''), b = parseAddresses(showBcc ? bcc : '');
    const bad = [...tt.invalid, ...c.invalid, ...b.invalid];
    if (bad.length) return setError(t('compose.checkAddresses', { count: bad.length, list: bad.join(', ') }));
    if (!tt.list.length && !c.list.length && !b.list.length) return setError(t('compose.addRecipient'));
    if (uploading) return setError(t('compose.waitUploads'));
    if (encrypt) {
      if (!keys.ready) return setError(keys.checking ? t('compose.lookingUpKeys') : t('compose.noKey', { list: keys.missing.join(', ') }));
      if (!(await ensureUnlocked(me))) return;
    }
    const text = htmlToText(editor.current!.innerHTML);
    // A large file sent as a download link counts as attached.
    if (!files.length && !fileLinks(editor.current!.innerHTML, location.origin).length && /\battach(ed|ment|ing)\b/i.test(text.split('\n> ')[0]) && !(await confirmIt({ title: t('compose.forgotTitle'), body: t('compose.forgotBody'), confirm: t('compose.sendAnyway') }))) return;
    if (!subject.trim() && !(await confirmIt({ title: t('compose.noSubjectTitle'), body: t('compose.noSubjectBody'), confirm: t('compose.sendAnyway') }))) return;
    await saving.current;
    let d = snapshot();
    if (confidential && api.share) {
      // Encrypted here, stored as ciphertext; recipients get only the link (the key rides after "#").
      // ponytail: Undo (or a failed send) brings back this link version, not the text; the text is still behind the
      // link. The expiry clock starts now, also for scheduled sends.
      if (d.attachments.length) return setError(t('confidential.noFiles'));
      setStatus(t('confidential.sealing'));
      try {
        const { blob, key } = await seal({ subject: d.subject, sent: (sendAt ?? new Date()).toISOString(), text: d.text }, passcode);
        const f = await api.share(new File([blob], `${t('confidential.fileName')}.bin`, { type: 'application/octet-stream' }), confidential);
        const html = confidentialHtml(confidentialUrl(new URL(f.url).origin, f.id, key, !!passcode.trim()), f.expires, !!passcode.trim());
        d = { ...d, html, text: htmlToText(html) };
      } catch (e) { setStatus(''); return setError(t('confidential.couldntSeal', { error: (e as Error).message })); }
    }
    onSend(d, sendAt);
  }

  async function link() {
    // The dialog takes focus, so remember where the cursor (or selection) was and put it back before inserting.
    const sel = getSelection(), range = sel?.rangeCount && editor.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const url = await promptIt({ title: t('compose.addLinkTitle'), label: t('compose.linkAddress'), placeholder: 'https://…', confirm: t('compose.addLink') });
    editor.current?.focus();
    if (range) { sel!.removeAllRanges(); sel!.addRange(range); }
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) return setError(t('compose.badLink'));
    if (getSelection()?.isCollapsed) exec('insertHTML', `<a href="${encodeURI(url.trim())}">${url.trim().replace(/[<>&"]/g, '')}</a>`);
    else exec('createLink', url.trim());
    changed();
  }

  const tool = (icon: IconName, label: string, run: () => void) => (
    <Button variant="quiet" icon={icon} label={label}
      onMouseDown={(e) => e.preventDefault() /* keep the text selection */} onClick={() => { run(); changed(); editor.current?.focus(); }} />
  );
  const mod = isMac ? '⌘' : 'Ctrl+';

  return (
    <section className={`compose${dragging ? ' dragging' : ''}${minimized ? ' min' : ''}${onMinimize ? '' : ' popped'}`} role="dialog" aria-label={subject || t('compose.newMessage')}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); link(); }
        else if (e.key === 'Escape' && !minimized) { e.preventDefault(); minimize(); }
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}>
      <header onClick={minimized ? () => onMinimize?.(false) : undefined}>
        <h2>{subject.trim() || t('compose.newMessage')}</h2>
        <span className="compose-win" onClick={(e) => e.stopPropagation()}>
          {onMinimize && <Button variant="quiet" icon={minimized ? 'expand' : 'minimize'} label={minimized ? t('compose.expand') : t('compose.minimize')}
            shortcut={minimized ? undefined : 'Esc'} onClick={() => onMinimize(!minimized)} className="not-mobile" />}
          {onPopOut && <Button variant="quiet" icon="popOut" label={t('compose.popOut')} onClick={popOut} className="not-mobile" />}
          <Button variant="quiet" icon="close" label={t('compose.saveAndClose')} shortcut={onMinimize ? undefined : 'Esc'} onClick={close} />
        </span>
      </header>

      {identities.length > 1 && (
        <label className="field"><span>{t('compose.from')}</span>
          <select className="from-select" value={from} onChange={(e) => { setFrom(e.target.value); changed(); }}>
            {identities.map((i) => <option key={i.email} value={i.email}>{i.name && !i.name.includes('@') ? `${i.name} <${i.email}>` : i.email /* Stalwart names alias identities after the account */}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>{t('compose.to')}</span>
        <RecipientInput label={t('compose.to')} inputRef={toRef} value={to} onChange={(v) => { setTo(v); changed(); }} contacts={contacts} groups={groups} />
        {!showCc && <Button variant="link" onClick={() => setShowCc(true)}>{t('compose.cc')}</Button>}
        {!showBcc && <Button variant="link" onClick={() => setShowBcc(true)}>{t('compose.bcc')}</Button>}
      </label>
      {showCc && (
        <label className="field"><span>{t('compose.cc')}</span>
          <RecipientInput label={t('compose.cc')} value={cc} onChange={(v) => { setCc(v); changed(); }} contacts={contacts} groups={groups} />
        </label>
      )}
      {showBcc && (
        <label className="field"><span>{t('compose.bcc')}</span>
          <RecipientInput label={t('compose.bcc')} value={bcc} onChange={(v) => { setBcc(v); changed(); }} contacts={contacts} groups={groups} />
        </label>
      )}
      <label className="field"><span>{t('compose.subject')}</span>
        <input value={subject} onChange={(e) => { setSubject(e.target.value); changed(); }} />
      </label>

      <div ref={editor} className="editor" contentEditable role="textbox" aria-multiline="true" aria-label={t('compose.message')}
        onInput={() => { changed(); smart.onInput(); }}
        onKeyDown={(e) => smart.onKeyDown(e)}
        onMouseDown={smart.clear}
        onBlur={() => {
          smart.clear();
          const sel = getSelection();
          if (sel?.rangeCount && editor.current?.contains(sel.anchorNode)) lastRange.current = sel.getRangeAt(0).cloneRange();
        }}
        onClick={(e) => setImg(e.target instanceof HTMLImageElement ? e.target : null)}
        onPaste={(e) => {
          e.preventDefault();
          const pics = [...e.clipboardData.files];
          if (pics.length && pics.every((f) => /^image\/(png|jpe?g|gif|webp)$/.test(f.type))) return void pics.forEach(embed);
          if (e.clipboardData.files.length) return void attach(e.clipboardData.files);
          const html = e.clipboardData.getData('text/html');
          if (html) exec('insertHTML', cleanHtml(html)); else exec('insertText', e.clipboardData.getData('text/plain'));
        }} />

      {confidential && <ConfidentialBar days={confidential} passcode={passcode} onPasscode={setPasscode} onOff={() => setConfidential(null)} />}

      {img && editor.current?.contains(img) && <ImageSize img={img} onChange={changed} />}
      {moreFmt && <FormatBar apply={styled} insert={insertHtml} text={insertText} />}
      {(files.some((f) => !f.cid) || uploading > 0) && (
        <ul className="chips" aria-label={t('compose.attachments')}>
          {files.filter((f) => !f.cid).map((f) => ( /* embedded images live in the text, not here */
            <li key={f.blobId} className="chip">
              <Icon name="file" size={16} /><span className="fname">{f.name}</span><span className="fsize">{fileSize(f.size)}</span>
              <Button variant="quiet" size="sm" icon="close" label={t('compose.removeFile', { name: f.name ?? '' })} onClick={() => { setFiles((fs) => fs.filter((x) => x !== f)); changed(); }} />
            </li>
          ))}
          {uploading > 0 && <li className="chip pending">{t('compose.uploading', { count: uploading })}</li>}
        </ul>
      )}

      <footer>
        <span className="split">
          <Button variant="primary" onClick={() => send()} title={t('compose.sendTitle', { mod })}>{encrypt ? t('compose.sendEncrypted') : confidential ? t('confidential.send') : t('compose.send')}</Button>
          <Menu label={t('compose.scheduleSend')} up button={<Button variant="primary" icon="clock" label={t('compose.scheduleSend')} />}>
            {(close) => <><p className="menu-title">{t('compose.scheduleSend')}</p><TimeChoices verb={t('compose.schedule')} close={close} onPick={(d) => send(d)} /></>}
          </Menu>
        </span>
        <div className="fmts" role="toolbar" aria-label={t('compose.formatting')}>
          {tool('bold', t('compose.bold', { mod }), () => exec('bold'))}
          {tool('italic', t('compose.italic', { mod }), () => exec('italic'))}
          {tool('link', t('compose.link', { mod }), link)}
          {tool('bullets', t('compose.bullets'), () => exec('insertUnorderedList'))}
          {tool('numbers', t('compose.numbers'), () => exec('insertOrderedList'))}
          {tool('quote', t('compose.quote'), () => exec('formatBlock', 'blockquote'))}
          {tool('clearFormat', t('compose.clearFormat'), () => exec('removeFormat'))}
          <Button variant="quiet" icon="textStyle" label={t('fmt.more')} pressed={moreFmt} onMouseDown={(e) => e.preventDefault()} onClick={() => setMoreFmt(!moreFmt)} />
          <Button variant="quiet" icon="clip" label={t('compose.attachFiles')} onClick={() => fileInput.current?.click()} />
          <Button variant="quiet" icon="receipt" label={receipt ? t('compose.receiptOn') : t('compose.receiptOff')} pressed={receipt}
            onClick={() => { setReceipt(!receipt); changed(); }} />
          {keys.mine && <Button variant="quiet" icon="lock" pressed={encrypt} disabled={!encrypt && !keys.ready}
            label={encrypt ? t('compose.encryptOn') : keys.ready ? t('compose.encrypt') : keys.missing.length ? t('compose.cantEncrypt', { list: keys.missing.join(', ') }) : t('compose.encryptLooking')}
            onClick={() => { setEncrypt(!encrypt); setConfidential(null); changed(); }} />}
          {api.share && (
            <Menu label={t('confidential.compose')} up align="right" button={<Button variant="quiet" icon="shield" pressed={!!confidential}
              label={confidential ? t('confidential.composeOn', { count: confidential }) : t('confidential.compose')} />}>
              {(close) => <>
                <p className="menu-title">{t('confidential.linkWorksFor')}</p>
                {([1, 7, 30] as const).map((d) => (
                  <button key={d} className="menu-item" role="menuitem" aria-checked={confidential === d} onClick={() => { close(); setConfidential(d); setEncrypt(false); }}>
                    <Icon name={confidential === d ? 'check' : 'clock'} size={16} /><span className="grow">{t('compose.days', { count: d })}</span>
                  </button>
                ))}
                {confidential && <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); setConfidential(null); }}><Icon name="close" size={16} />{t('confidential.turnOff')}</button>}
                <p className="menu-note">{t('confidential.menuNote')}</p>
              </>}
            </Menu>
          )}
          <Menu label={t('compose.templates')} up align="right" button={<Button variant="quiet" icon="templates" label={t('compose.templates')} />}>
            {(close) => <TemplatesMenu api={api} close={close}
              onInsert={(tpl) => {
                editor.current?.focus();
                exec('insertHTML', cleanHtml(tpl.html));
                if (!subject.trim()) setSubject(tpl.subject);
                setFiles((fs) => [...fs, ...tpl.attachments.filter((a) => a.disposition !== 'inline')]);
                changed();
              }}
              onSave={async () => {
                const d = snapshot();
                if (!htmlToText(d.html).trim()) return setError(t('compose.writeFirstTemplate'));
                await api.saveTemplate({ ...d, subject: d.subject || t('compose.untitledTemplate') });
                setStatus(t('compose.savedTemplate', { name: d.subject || t('compose.untitledTemplate') }));
              }} />}
          </Menu>
          {canRewrite() && (
            <Menu label={t('compose.writingHelp')} up align="right" button={<Button variant="quiet" icon="compose" label={t('compose.writingHelpOnDevice')} />}>
              {(close) => <>
                <p className="menu-title">{getSelection()?.toString().trim() ? t('compose.rewriteSelection') : t('compose.rewriteMessage')}</p>
                {([['formal', t('compose.moreFormal')], ['casual', t('compose.moreCasual')], ['shorter', t('compose.shorter')]] as const).map(([k, text]) => (
                  <button key={k} className="menu-item" role="menuitem" onClick={() => { close(); polish(k); }}><Icon name="compose" size={16} />{text}</button>
                ))}
                <p className="menu-note">{t('compose.onDevice')}</p>
              </>}
            </Menu>
          )}
          {api.events && (
            <Menu label={t('schedule.title')} up align="right" button={<Button variant="quiet" icon="calendar" label={t('schedule.title')} onMouseDown={(e) => e.preventDefault()} />}>
              {(close) => <ScheduleMenu events={api.events!} close={close} onInsert={insertHtml} onError={setError} />}
            </Menu>
          )}
          <Menu label={t('compose.remindMe')} up align="right" button={<Button variant="quiet" icon="bell" pressed={!!followUp}
            label={followUp ? t('compose.reminderSet', { count: followUp }) : t('compose.remindIfNobody')} />}>
            {(close) => <>
              <p className="menu-title">{t('compose.bringBack')}</p>
              {([[1, t('compose.days', { count: 1 })], [3, t('compose.days', { count: 3 })], [7, t('compose.week')]] as const).map(([d, text]) => (
                <button key={d} className="menu-item" role="menuitem" aria-checked={followUp === d} onClick={() => { close(); setFollowUp(d); changed(); }}>
                  <Icon name={followUp === d ? 'check' : 'bell'} size={16} /><span className="grow">{text}</span>
                </button>
              ))}
              {followUp && <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); setFollowUp(undefined); changed(); }}><Icon name="close" size={16} />{t('compose.noReminder')}</button>}
            </>}
          </Menu>
          {signatures.length > 0 && (
            <Menu label={t('compose.signature')} up align="right" button={<Button variant="quiet" icon="signature" label={t('compose.signature')} />}>
              {(close) => <>
                <p className="menu-title">{t('compose.signature')}</p>
                {[...signatures, null].map((sg) => (
                  <button key={sg?.name ?? ''} className="menu-item" role="menuitem" onClick={() => { close(); applySignature(sg); }}>
                    <Icon name="signature" size={16} /><span className="grow">{sg?.name ?? t('compose.noSignature')}</span>
                  </button>
                ))}
              </>}
            </Menu>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ''; }} />
        </div>
        <span className="status" role="status">{error ? <span className="error">{error}</span> : status}</span>
        <Button variant="quiet" icon="trash" label={t('compose.discardDraft')} onClick={discard} />
      </footer>
      {dragging && <div className="dropzone">{t('compose.dropFiles')}</div>}
    </section>
  );
}

/** Insert a saved template, save the current message as one, or delete one. */
function TemplatesMenu({ api, close, onInsert, onSave }: {
  api: ComposeApi; close: () => void; onInsert: (tpl: Template) => void; onSave: () => void;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  useEffect(() => { api.templates().then(setList, () => setList([])); }, []);
  return (
    <>
      <p className="menu-title">{t('compose.templates')}</p>
      {list === null && <p className="menu-note">{t('common.loading')}</p>}
      {list?.length === 0 && <p className="menu-note">{t('compose.noTemplates')}</p>}
      {list?.map((tpl) => (
        <div key={tpl.id} className="menu-row">
          <button className="menu-item" role="menuitem" onClick={() => { close(); onInsert(tpl); }}>
            <Icon name="templates" size={16} /><span className="grow">{tpl.subject || t('compose.untitledTemplate')}</span>
          </button>
          <Button variant="quiet" size="sm" icon="trash" label={t('compose.deleteTemplateLabel', { name: tpl.subject })}
            onClick={async () => { if (await confirmIt({ title: t('compose.deleteTemplateTitle', { name: tpl.subject }), confirm: t('compose.deleteTemplate'), danger: true })) { await api.deleteTemplate(tpl.id); setList((l) => l?.filter((x) => x.id !== tpl.id) ?? l); } }} />
        </div>
      ))}
      <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); onSave(); }}><Icon name="compose" size={16} />{t('compose.saveAsTemplate')}</button>
    </>
  );
}
