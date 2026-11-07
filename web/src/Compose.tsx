import { useEffect, useRef, useState } from 'react';
import { chooseIt, confirmIt, promptIt } from './Dialog';
import type { Address, Attachment, Draft, SharedFile, Template } from './jmap';
import { Button } from './Button';
import { Icon, type IconName } from './icons';
import { cleanHtml, fileLinkHtml, fileSize, formatAddresses, htmlToText, parseAddresses, signatureHtml, type Signature } from './mailutil';
import { RecipientInput } from './RecipientInput';
import { canRewrite, rewrite, type RewriteStyle } from './ai';
import { Menu, TimeChoices } from './Menu';
import { ensureUnlocked, useRecipientKeys } from './Encryption';

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
  share?: (f: File, expiresDays: 7 | 30 | 0) => Promise<SharedFile>;
  /** Biggest attachment the server takes (session maxSizeUpload). */
  maxUpload?: number;
}

// Most mail servers (Gmail, Outlook) refuse messages over 25 MB, and attachments grow by a third on the way.
const LINK_OVER = 25 * 1024 * 1024;

const AUTOSAVE_MS = 2500;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// ponytail: formatting uses document.execCommand. It's deprecated on paper but every browser still ships it,
// and it's a few lines instead of an editor framework. Swap for a real editor model if we need tables or images.
const exec = (cmd: string, arg?: string) => document.execCommand(cmd, false, arg);

export function Compose({ initial, contacts, api, signatures, identities, onSend, onClose }: {
  initial: Draft; contacts: Address[]; api: ComposeApi; signatures: Signature[];
  /** Addresses this account can send from; the first is the main one. A From menu appears when there are several. */
  identities: { name: string; email: string }[];
  onSend: (d: Draft, sendAt?: Date) => void; onClose: (outcome: 'saved' | 'discarded' | 'closed') => void;
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
      if (stop) range.setEndBefore(stop.previousElementSibling?.textContent?.startsWith('On ') ? stop.previousElementSibling : stop); else range.setEnd(ed, ed.childNodes.length);
    }
    const text = range.toString().trim();
    if (!text) return setError('Write something first, then ask for help with it.');
    setStatus('Rewriting on this device…');
    try {
      const out = await rewrite(text, style);
      ed.focus(); sel?.removeAllRanges(); sel?.addRange(range);
      exec('insertText', out); // one undo step: ⌘Z brings your words back
      setStatus('Rewritten. ⌘Z to undo.'); changed();
    } catch (e) { setStatus(''); setError((e as Error).message); }
  }

  /** Swap the signature block in place (or add / remove it), leaving everything else as written. */
  function applySignature(sg: Signature | null) {
    const ed = editor.current!, old = ed.querySelector('[data-sig]');
    if (!sg) old?.remove();
    else {
      const t = document.createElement('template'); t.innerHTML = signatureHtml(sg.text);
      const block = t.content.firstElementChild!;
      // No signature yet: right after the first line, above any quoted text (same place new drafts get it).
      if (old) old.replaceWith(block); else if (ed.firstElementChild) ed.firstElementChild.after(block); else ed.append(block);
    }
    changed();
  }

  const snapshot = (): Draft => {
    // Back from blob: previews to cid: references; drop embedded images the user deleted from the text.
    const copy = editor.current!.cloneNode(true) as HTMLElement;
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
      setStatus('Saving…');
      try { draftId.current = await api.save(snapshot()); setStatus('Draft saved'); }
      catch { setStatus('Couldn’t save draft. Retrying when you type.'); }
    });
    return saving.current;
  }

  useEffect(() => {
    if (!edits) return;
    const t = setTimeout(save, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [edits]);

  async function attach(list: FileList | File[]) {
    let total = files.reduce((n, a) => n + a.size, 0);
    for (const f of [...list]) {
      if (api.share && f.size + total > Math.min(LINK_OVER, api.maxUpload ?? Infinity)) { await shareLink(f); continue; }
      total += f.size;
      setUploading((n) => n + 1);
      try { const a = await api.upload(f); setFiles((fs) => [...fs, a]); changed(); }
      catch (e) { setError(`${f.name}: ${(e as Error).message}`); }
      finally { setUploading((n) => n - 1); }
    }
  }

  /** Too big to attach: upload it to the sender's storage and put a download link in the message instead. */
  async function shareLink(f: File) {
    const days = await chooseIt({ title: `${f.name} is too big to attach`, label: 'The link works for',
      body: `It’s ${fileSize(f.size)}, and many mail servers refuse messages over 25 MB. Send a download link instead? The file is kept in your storage, and you can remove it any time in Settings → Shared files.`,
      value: '30', options: [['7', '7 days'], ['30', '30 days'], ['0', 'Until I remove it']], confirm: 'Upload and add link' });
    if (days === null) return;
    setUploading((n) => n + 1);
    try {
      const t = document.createElement('template'); t.innerHTML = fileLinkHtml(await api.share!(f, Number(days) as 7 | 30 | 0));
      // Above the signature and any quoted reply, like a line you'd type there.
      const ed = editor.current!, stop = ed.querySelector('[data-sig], blockquote');
      const at = stop?.previousElementSibling?.textContent?.startsWith('On ') ? stop.previousElementSibling : stop;
      if (at) at.before(t.content); else ed.append(t.content);
      changed();
    } catch (e) { setError(`${f.name}: ${(e as Error).message}`); }
    finally { setUploading((n) => n - 1); }
  }

  async function close() {
    if (edits) { await save(); onClose('saved'); } else onClose('closed');
  }

  async function discard() {
    const hasContent = htmlToText(editor.current!.innerHTML).trim() || subject.trim() || files.length;
    if (hasContent && !(await confirmIt({ title: 'Discard this draft?', body: 'What you wrote will be deleted.', confirm: 'Discard', danger: true }))) return;
    await saving.current;
    if (draftId.current) await api.discard(draftId.current).catch(() => {});
    onClose('discarded');
  }

  async function send(sendAt?: Date) {
    const t = parseAddresses(to), c = parseAddresses(showCc ? cc : ''), b = parseAddresses(showBcc ? bcc : '');
    const bad = [...t.invalid, ...c.invalid, ...b.invalid];
    if (bad.length) return setError(`Check ${bad.length > 1 ? 'these addresses' : 'this address'}: ${bad.join(', ')}`);
    if (!t.list.length && !c.list.length && !b.list.length) return setError('Add at least one recipient');
    if (uploading) return setError('Wait for attachments to finish uploading');
    if (encrypt) {
      if (!keys.ready) return setError(keys.checking ? 'Still looking up encryption keys. Try again in a moment.' : `No usable encryption key for ${keys.missing.join(', ')} (none found, or it changed: see Settings → Security). Remove them or turn off encryption.`);
      if (!(await ensureUnlocked(me))) return;
    }
    const text = htmlToText(editor.current!.innerHTML);
    if (!files.length && /\battach(ed|ment|ing)\b/i.test(text.split('\n> ')[0]) && !(await confirmIt({ title: 'Forgot the attachment?', body: 'You mention an attachment, but nothing is attached.', confirm: 'Send anyway' }))) return;
    if (!subject.trim() && !(await confirmIt({ title: 'Send without a subject?', body: 'Messages with a subject are easier to find and less likely to look like spam.', confirm: 'Send anyway' }))) return;
    await saving.current;
    onSend(snapshot(), sendAt);
  }

  async function link() {
    // The dialog takes focus, so remember where the cursor (or selection) was and put it back before inserting.
    const sel = getSelection(), range = sel?.rangeCount && editor.current?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null;
    const url = await promptIt({ title: 'Add a link', label: 'Address', placeholder: 'https://…', confirm: 'Add link' });
    editor.current?.focus();
    if (range) { sel!.removeAllRanges(); sel!.addRange(range); }
    if (!url) return;
    if (!/^(https?:\/\/|mailto:)/i.test(url.trim())) return setError('Links must start with https://, http:// or mailto:');
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
    <section className={`compose${dragging ? ' dragging' : ''}`} role="dialog" aria-label={subject || 'New message'}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
        else if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); link(); }
        else if (e.key === 'Escape') { e.preventDefault(); close(); }
      }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); attach(e.dataTransfer.files); }}>
      <header>
        <h2>{subject.trim() || 'New message'}</h2>
        <Button variant="quiet" icon="close" label="Save draft and close" shortcut="Esc" onClick={close} />
      </header>

      {identities.length > 1 && (
        <label className="field"><span>From</span>
          <select className="from-select" value={from} onChange={(e) => { setFrom(e.target.value); changed(); }}>
            {identities.map((i) => <option key={i.email} value={i.email}>{i.name && !i.name.includes('@') ? `${i.name} <${i.email}>` : i.email /* Stalwart names alias identities after the account */}</option>)}
          </select>
        </label>
      )}
      <label className="field">
        <span>To</span>
        <RecipientInput label="To" inputRef={toRef} value={to} onChange={(v) => { setTo(v); changed(); }} contacts={contacts} />
        {!showCc && <Button variant="link" onClick={() => setShowCc(true)}>Cc</Button>}
        {!showBcc && <Button variant="link" onClick={() => setShowBcc(true)}>Bcc</Button>}
      </label>
      {showCc && (
        <label className="field"><span>Cc</span>
          <RecipientInput label="Cc" value={cc} onChange={(v) => { setCc(v); changed(); }} contacts={contacts} />
        </label>
      )}
      {showBcc && (
        <label className="field"><span>Bcc</span>
          <RecipientInput label="Bcc" value={bcc} onChange={(v) => { setBcc(v); changed(); }} contacts={contacts} />
        </label>
      )}
      <label className="field"><span>Subject</span>
        <input value={subject} onChange={(e) => { setSubject(e.target.value); changed(); }} />
      </label>

      <div ref={editor} className="editor" contentEditable role="textbox" aria-multiline="true" aria-label="Message"
        onInput={changed}
        onPaste={(e) => {
          e.preventDefault();
          if (e.clipboardData.files.length) return void attach(e.clipboardData.files);
          const html = e.clipboardData.getData('text/html');
          if (html) exec('insertHTML', cleanHtml(html)); else exec('insertText', e.clipboardData.getData('text/plain'));
        }} />

      {(files.some((f) => !f.cid) || uploading > 0) && (
        <ul className="chips" aria-label="Attachments">
          {files.filter((f) => !f.cid).map((f) => ( /* embedded images live in the text, not here */
            <li key={f.blobId} className="chip">
              <Icon name="file" size={16} /><span className="fname">{f.name}</span><span className="fsize">{fileSize(f.size)}</span>
              <Button variant="quiet" size="sm" icon="close" label={`Remove ${f.name}`} onClick={() => { setFiles((fs) => fs.filter((x) => x !== f)); changed(); }} />
            </li>
          ))}
          {uploading > 0 && <li className="chip pending">Uploading {uploading} file{uploading > 1 ? 's' : ''}…</li>}
        </ul>
      )}

      <footer>
        <span className="split">
          <Button variant="primary" onClick={() => send()} title={`Send (${mod}Enter)`}>{encrypt ? 'Send encrypted' : 'Send'}</Button>
          <Menu label="Schedule send" up button={<Button variant="primary" icon="clock" label="Schedule send" />}>
            {(close) => <><p className="menu-title">Schedule send</p><TimeChoices verb="Schedule" close={close} onPick={(d) => send(d)} /></>}
          </Menu>
        </span>
        <div className="fmts" role="toolbar" aria-label="Formatting">
          {tool('bold', `Bold (${mod}B)`, () => exec('bold'))}
          {tool('italic', `Italic (${mod}I)`, () => exec('italic'))}
          {tool('link', `Link (${mod}K)`, link)}
          {tool('bullets', 'Bulleted list', () => exec('insertUnorderedList'))}
          {tool('numbers', 'Numbered list', () => exec('insertOrderedList'))}
          {tool('quote', 'Quote', () => exec('formatBlock', 'blockquote'))}
          {tool('clearFormat', 'Remove formatting', () => exec('removeFormat'))}
          <Button variant="quiet" icon="clip" label="Attach files" onClick={() => fileInput.current?.click()} />
          <Button variant="quiet" icon="receipt" label={receipt ? 'Read receipt requested (click to cancel)' : 'Request a read receipt'} pressed={receipt}
            onClick={() => { setReceipt(!receipt); changed(); }} />
          {keys.mine && <Button variant="quiet" icon="lock" pressed={encrypt} disabled={!encrypt && !keys.ready}
            label={encrypt ? 'Encrypted end to end (click to turn off)' : keys.ready ? 'Encrypt end to end' : keys.missing.length ? `Can’t encrypt: no usable key for ${keys.missing.join(', ')}` : 'Encrypt end to end (looking up keys…)'}
            onClick={() => { setEncrypt(!encrypt); changed(); }} />}
          <Menu label="Templates" up align="right" button={<Button variant="quiet" icon="templates" label="Templates" />}>
            {(close) => <TemplatesMenu api={api} close={close}
              onInsert={(t) => {
                editor.current?.focus();
                exec('insertHTML', cleanHtml(t.html));
                if (!subject.trim()) setSubject(t.subject);
                setFiles((fs) => [...fs, ...t.attachments.filter((a) => a.disposition !== 'inline')]);
                changed();
              }}
              onSave={async () => {
                const d = snapshot();
                if (!htmlToText(d.html).trim()) return setError('Write something first, then save it as a template.');
                await api.saveTemplate({ ...d, subject: d.subject || 'Untitled template' });
                setStatus(`Saved “${d.subject || 'Untitled template'}” as a template`);
              }} />}
          </Menu>
          {canRewrite() && (
            <Menu label="Writing help" up align="right" button={<Button variant="quiet" icon="compose" label="Writing help (on this device)" />}>
              {(close) => <>
                <p className="menu-title">Rewrite {getSelection()?.toString().trim() ? 'the selection' : 'your message'}</p>
                {([['formal', 'More formal'], ['casual', 'More casual'], ['shorter', 'Shorter']] as const).map(([k, t]) => (
                  <button key={k} className="menu-item" role="menuitem" onClick={() => { close(); polish(k); }}><Icon name="compose" size={16} />{t}</button>
                ))}
                <p className="menu-note">Runs on this device. Your words never leave your computer.</p>
              </>}
            </Menu>
          )}
          <Menu label="Remind me" up align="right" button={<Button variant="quiet" icon="bell" pressed={!!followUp}
            label={followUp ? `Reminder if no reply in ${followUp} day${followUp > 1 ? 's' : ''} (click to change)` : 'Remind me if nobody replies'} />}>
            {(close) => <>
              <p className="menu-title">If nobody replies, bring it back in</p>
              {[[1, '1 day'], [3, '3 days'], [7, '1 week']].map(([d, t]) => (
                <button key={d} className="menu-item" role="menuitem" aria-checked={followUp === d} onClick={() => { close(); setFollowUp(d as number); changed(); }}>
                  <Icon name={followUp === d ? 'check' : 'bell'} size={16} /><span className="grow">{t}</span>
                </button>
              ))}
              {followUp && <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); setFollowUp(undefined); changed(); }}><Icon name="close" size={16} />No reminder</button>}
            </>}
          </Menu>
          {signatures.length > 0 && (
            <Menu label="Signature" up align="right" button={<Button variant="quiet" icon="signature" label="Signature" />}>
              {(close) => <>
                <p className="menu-title">Signature</p>
                {[...signatures, null].map((sg) => (
                  <button key={sg?.name ?? ''} className="menu-item" role="menuitem" onClick={() => { close(); applySignature(sg); }}>
                    <Icon name="signature" size={16} /><span className="grow">{sg?.name ?? 'No signature'}</span>
                  </button>
                ))}
              </>}
            </Menu>
          )}
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files) attach(e.target.files); e.target.value = ''; }} />
        </div>
        <span className="status" role="status">{error ? <span className="error">{error}</span> : status}</span>
        <Button variant="quiet" icon="trash" label="Discard draft" onClick={discard} />
      </footer>
      {dragging && <div className="dropzone">Drop files to attach</div>}
    </section>
  );
}

/** Insert a saved template, save the current message as one, or delete one. */
function TemplatesMenu({ api, close, onInsert, onSave }: {
  api: ComposeApi; close: () => void; onInsert: (t: Template) => void; onSave: () => void;
}) {
  const [list, setList] = useState<Template[] | null>(null);
  useEffect(() => { api.templates().then(setList, () => setList([])); }, []);
  return (
    <>
      <p className="menu-title">Templates</p>
      {list === null && <p className="menu-note">Loading…</p>}
      {list?.length === 0 && <p className="menu-note">No templates yet. Write a message you send often, then save it here.</p>}
      {list?.map((t) => (
        <div key={t.id} className="menu-row">
          <button className="menu-item" role="menuitem" onClick={() => { close(); onInsert(t); }}>
            <Icon name="templates" size={16} /><span className="grow">{t.subject || 'Untitled template'}</span>
          </button>
          <Button variant="quiet" size="sm" icon="trash" label={`Delete template ${t.subject}`}
            onClick={async () => { if (await confirmIt({ title: `Delete the template “${t.subject}”?`, confirm: 'Delete template', danger: true })) { await api.deleteTemplate(t.id); setList((l) => l?.filter((x) => x.id !== t.id) ?? l); } }} />
        </div>
      ))}
      <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); onSave(); }}><Icon name="compose" size={16} />Save this message as a template</button>
    </>
  );
}
