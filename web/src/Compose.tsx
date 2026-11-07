import { useEffect, useRef, useState } from 'react';
import type { Address, Attachment, Draft, Template } from './jmap';
import { Button } from './Button';
import { Icon, type IconName } from './icons';
import { cleanHtml, fileSize, formatAddresses, htmlToText, parseAddresses } from './mailutil';
import { RecipientInput } from './RecipientInput';
import { Menu, TimeChoices } from './Menu';

export interface ComposeApi {
  upload: (f: File) => Promise<Attachment>;
  save: (d: Draft) => Promise<string>;
  discard: (id: string) => Promise<void>;
  /** Fetch an attachment's bytes (to show embedded images inside the editor). */
  download: (a: Attachment) => Promise<Blob>;
  templates: () => Promise<Template[]>;
  saveTemplate: (d: Draft) => Promise<void>;
  deleteTemplate: (id: string) => Promise<void>;
}

const AUTOSAVE_MS = 2500;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

// ponytail: formatting uses document.execCommand. It's deprecated on paper but every browser still ships it,
// and it's a few lines instead of an editor framework. Swap for a real editor model if we need tables or images.
const exec = (cmd: string, arg?: string) => document.execCommand(cmd, false, arg);

export function Compose({ initial, contacts, api, onSend, onClose }: {
  initial: Draft; contacts: Address[]; api: ComposeApi;
  onSend: (d: Draft, sendAt?: Date) => void; onClose: (outcome: 'saved' | 'discarded' | 'closed') => void;
}) {
  const [to, setTo] = useState(formatAddresses(initial.to));
  const [cc, setCc] = useState(formatAddresses(initial.cc));
  const [showCc, setShowCc] = useState(initial.cc.length > 0);
  const [subject, setSubject] = useState(initial.subject);
  const [files, setFiles] = useState<Attachment[]>(initial.attachments);
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

  const snapshot = (): Draft => {
    // Back from blob: previews to cid: references; drop embedded images the user deleted from the text.
    const copy = editor.current!.cloneNode(true) as HTMLElement;
    copy.querySelectorAll('img[data-cid]').forEach((img) => { img.setAttribute('src', `cid:${img.getAttribute('data-cid')}`); img.removeAttribute('data-cid'); });
    const html = copy.innerHTML;
    const attachments = files.filter((a) => !a.cid || html.includes(`cid:${a.cid}`));
    return {
      ...initial, id: draftId.current, subject: subject.trim(), html, text: htmlToText(html), attachments,
      to: parseAddresses(to).list, cc: parseAddresses(showCc ? cc : '').list,
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
    for (const f of [...list]) {
      setUploading((n) => n + 1);
      try { const a = await api.upload(f); setFiles((fs) => [...fs, a]); changed(); }
      catch (e) { setError(`${f.name}: ${(e as Error).message}`); }
      finally { setUploading((n) => n - 1); }
    }
  }

  async function close() {
    if (edits) { await save(); onClose('saved'); } else onClose('closed');
  }

  async function discard() {
    const hasContent = htmlToText(editor.current!.innerHTML).trim() || subject.trim() || files.length;
    if (hasContent && !confirm('Discard this draft?')) return;
    await saving.current;
    if (draftId.current) await api.discard(draftId.current).catch(() => {});
    onClose('discarded');
  }

  async function send(sendAt?: Date) {
    const t = parseAddresses(to), c = parseAddresses(showCc ? cc : '');
    const bad = [...t.invalid, ...c.invalid];
    if (bad.length) return setError(`Check ${bad.length > 1 ? 'these addresses' : 'this address'}: ${bad.join(', ')}`);
    if (!t.list.length) return setError('Add at least one recipient');
    if (uploading) return setError('Wait for attachments to finish uploading');
    const text = htmlToText(editor.current!.innerHTML);
    if (!files.length && /\battach(ed|ment|ing)\b/i.test(text.split('\n> ')[0]) && !confirm('You mention an attachment, but nothing is attached. Send anyway?')) return;
    if (!subject.trim() && !confirm('Send without a subject?')) return;
    await saving.current;
    onSend(snapshot(), sendAt);
  }

  function link() {
    const url = prompt('Link address (https://…)');
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

      <label className="field">
        <span>To</span>
        <RecipientInput label="To" inputRef={toRef} value={to} onChange={(v) => { setTo(v); changed(); }} contacts={contacts} />
        {!showCc && <Button variant="link" onClick={() => setShowCc(true)}>Cc</Button>}
      </label>
      {showCc && (
        <label className="field"><span>Cc</span>
          <RecipientInput label="Cc" value={cc} onChange={(v) => { setCc(v); changed(); }} contacts={contacts} />
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
          <Button variant="primary" onClick={() => send()} title={`Send (${mod}Enter)`}>Send</Button>
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
          <Menu label="Templates" up button={<Button variant="quiet" icon="templates" label="Templates" />}>
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
            onClick={async () => { if (confirm(`Delete the template “${t.subject}”?`)) { await api.deleteTemplate(t.id); setList((l) => l?.filter((x) => x.id !== t.id) ?? l); } }} />
        </div>
      ))}
      <button className="menu-item menu-sep" role="menuitem" onClick={() => { close(); onSave(); }}><Icon name="compose" size={16} />Save this message as a template</button>
    </>
  );
}
