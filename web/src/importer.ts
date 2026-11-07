// Import from Gmail (Google Takeout .mbox), Zoho / Thunderbird / Apple Mail (.mbox) and single .eml files.
// Works on raw bytes end to end: a message is never decoded and re-encoded, so 8-bit bodies, odd charsets and
// attachments arrive exactly as exported. Streams the file, so multi-gigabyte exports don't load into memory.

const NL = 0x0a;
const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "

/** True when bytes[i..] starts with "From " (an mbox separator when it begins a line). */
const isFromAt = (b: Uint8Array, i: number) => FROM_.every((c, k) => b[i + k] === c);

/**
 * Split an mbox stream into raw messages. The separator is a line starting with "From " (after a newline, or at the
 * very start). The separator line itself is dropped, and the ">From " escaping writers add to body lines is undone.
 */
export async function* splitMbox(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let buf = new Uint8Array(0);
  let started = false;
  const emit = (msg: Uint8Array) => unescapeFrom(stripSeparator(msg));
  for await (const chunk of chunks) {
    const next = new Uint8Array(buf.length + chunk.length);
    next.set(buf); next.set(chunk, buf.length);
    buf = next;
    let start = 0;
    // Keep 5 bytes back: a separator might straddle the chunk boundary.
    for (let i = 0; i + FROM_.length <= buf.length; i++) {
      if ((i === 0 || buf[i - 1] === NL) && isFromAt(buf, i)) {
        if (started && i > start) yield emit(buf.subarray(start, i));
        started = true; start = i;
      }
    }
    buf = buf.slice(start);
  }
  if (started && buf.length) yield emit(buf);
  else if (!started && buf.length) yield buf; // not an mbox at all: one message (.eml)
}

function stripSeparator(m: Uint8Array): Uint8Array {
  const eol = m.indexOf(NL);
  let body = eol < 0 ? new Uint8Array(0) : m.subarray(eol + 1);
  // Drop the blank line mbox writers put between messages.
  let end = body.length;
  while (end > 0 && (body[end - 1] === NL || body[end - 1] === 0x0d)) end--;
  body = body.subarray(0, end);
  return body;
}

/** ">From " at the start of a line was "From " in the original (mboxo/mboxrd: remove one ">"). */
function unescapeFrom(m: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] === 0x3e && (i === 0 || m[i - 1] === NL)) {
      let j = i; while (m[j] === 0x3e) j++;
      if (isFromAt(m, j)) continue; // drop one '>'
    }
    out.push(m[i]);
  }
  return out.length === m.length ? m : Uint8Array.from(out);
}

/** The header block as text (headers are 7-bit by RFC 5322; latin1 keeps any stray byte 1:1). */
export function headerText(m: Uint8Array): string {
  let end = m.length;
  for (let i = 0; i < m.length - 1; i++) {
    if (m[i] === NL && (m[i + 1] === NL || (m[i + 1] === 0x0d && m[i + 2] === NL))) { end = i; break; }
  }
  return new TextDecoder('latin1').decode(m.subarray(0, Math.min(end, 64 * 1024)));
}

export interface Placement {
  /** Mailbox roles to file into (inbox, sent, junk, trash, drafts). */
  roles: string[];
  /** Your own Gmail labels, as folder paths ("Work/Clients"). */
  folders: string[];
  keywords: Record<string, true>;
}

/** Where a message goes, from Gmail's X-Gmail-Labels header. Without it, everything lands in one import folder. */
export function placement(headers: string): Placement {
  const unfolded = headers.replace(/\r?\n[ \t]+/g, ' ');
  const raw = /^X-Gmail-Labels:\s*(.*)$/im.exec(unfolded)?.[1];
  const p: Placement = { roles: [], folders: [], keywords: {} };
  if (!raw) { p.keywords.$seen = true; return p; }
  const labels = raw.split(',').map((l) => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
  let unread = false;
  for (const l of labels) {
    const k = l.toLowerCase();
    if (k === 'inbox') p.roles.push('inbox');
    else if (k === 'sent') p.roles.push('sent');
    else if (k === 'spam') p.roles.push('junk');
    else if (k === 'trash') p.roles.push('trash');
    else if (k === 'drafts' || k === 'draft') { p.roles.push('drafts'); p.keywords.$draft = true; }
    else if (k === 'starred') p.keywords.$flagged = true;
    else if (k === 'unread') unread = true;
    else if (k === 'opened' || k === 'important' || k.startsWith('category ') || k === 'archived' || k === 'chat') { /* Gmail-internal */ }
    else p.folders.push(l);
  }
  if (!unread) p.keywords.$seen = true;
  return p;
}

/** Turn a File into an async stream of byte chunks. */
export async function* fileChunks(f: Blob, size = 4 * 1024 * 1024): AsyncGenerator<Uint8Array> {
  for (let off = 0; off < f.size; off += size) yield new Uint8Array(await f.slice(off, off + size).arrayBuffer());
}
