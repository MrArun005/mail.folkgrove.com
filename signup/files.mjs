// Large-file links: a file too big to attach is uploaded to the sender's own file storage (Stalwart FileNode, in a
// "Shared files" folder, so it counts toward their storage quota) and the message carries a download link instead.
// Stalwart's own upload limits (50 MB per upload and per hour for a user) are for attachments; this service uploads
// with admin rights, which they don't apply to, so it enforces its own: MAX_FILE_BYTES and FILES_QUOTA_BYTES.
//
//   POST   /api/files?name=&expires=1|7|30|0 raw body (Content-Length required) → 201 { file }
//   GET    /api/files                        the caller's links
//   DELETE /api/files/:id                    revoke: the link stops working and the file is deleted
//   GET    /f/:id                            public download, always as an attachment, never rendered
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { callerOf } from './aliases.mjs';

const FOLDER = 'Shared files';
const DAY = 86400e3;
const FN = ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:filenode'];
const ID = /^[A-Za-z0-9_-]{24}$/;

// ponytail: links live in one JSON file, rewritten on every change (downloads too). Fine to some 10k links and a
// few writes a second; past that, SQLite or Valkey.
function links(cfg) {
  if (cfg.links) return cfg.links;
  if (!cfg.filesDb) console.warn('files: FILES_DB is not set; file links are only kept until restart');
  const saved = cfg.filesDb && existsSync(cfg.filesDb) ? JSON.parse(readFileSync(cfg.filesDb, 'utf8')) : {};
  return (cfg.links = new Map(Object.entries(saved)));
}
function save(cfg) {
  if (!cfg.filesDb) return;
  writeFileSync(cfg.filesDb + '.tmp', JSON.stringify(Object.fromEntries(links(cfg))));
  renameSync(cfg.filesDb + '.tmp', cfg.filesDb);
}

/** A deleted account's links stop working. Stalwart deletes its files with it; account ids can be reused later. */
export function forgetFiles(cfg, accountId) {
  const m = links(cfg);
  for (const [id, l] of m) if (l.acct === accountId) m.delete(id);
  save(cfg);
}

const view = (id, l) => ({ id, url: `/f/${id}`, name: l.name, size: l.size, created: l.created, expires: l.expires, downloads: l.downloads });
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f\u007f/\\<>:"|?*]/g, '').trim().slice(0, 200) || 'file';

export function fileRoutes({ cfg, jmap, getDomainId, send, fail, RateLimiter, ipOf }) {
  const caller = callerOf({ cfg, jmap, getDomainId });
  const badAuth = new RateLimiter(20, 15 * 60e3); // as in aliases.mjs
  const uploads = new RateLimiter(cfg.filesPerHour ?? 20, 3600e3);
  const downloads = new RateLimiter(cfg.downloadsPerHour ?? 200, 3600e3);
  const auth = 'Basic ' + Buffer.from(`${cfg.admin.user}:${cfg.admin.pass}`).toString('base64');
  const fn = async (call) => {
    const r = await fetch(`${cfg.stalwartUrl}/jmap/`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ using: FN, methodCalls: [call] }), signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`Stalwart JMAP HTTP ${r.status}`);
    const [[name, res]] = (await r.json()).methodResponses;
    if (name === 'error') throw new Error(`Stalwart JMAP error ${res.type}`);
    return res;
  };
  const destroy = (l) => fn(['FileNode/set', { accountId: l.acct, destroy: [l.node] }, 'd']).catch((e) => console.error('files: delete failed:', e.message));
  const expired = (l) => l.expires && l.expires < Date.now();
  const inflight = new Map(); // account → bytes of uploads still streaming

  // Expired links go, and so do their files (that frees the sender's storage). Hourly; unref: never keeps us alive.
  const sweep = async () => {
    for (const [id, l] of links(cfg)) if (expired(l)) { links(cfg).delete(id); await destroy(l); }
    save(cfg);
  };
  setInterval(() => sweep().catch((e) => console.error('files: sweep:', e.message)), 3600e3).unref();

  async function folder(acct) {
    const q = await fn(['FileNode/query', { accountId: acct, filter: { isTopLevel: true, name: FOLDER } }, 'q']);
    if (q.ids?.[0]) return q.ids[0];
    const r = await fn(['FileNode/set', { accountId: acct, create: { f: { '@type': 'Directory', name: FOLDER, parentId: null } } }, 'f']);
    if (!r.created?.f) throw new Error('could not create the folder: ' + JSON.stringify(r.notCreated?.f));
    return r.created.f.id;
  }

  async function upload(req, res, url, who) {
    const size = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(size) || size <= 0) return fail(res, 411, 'length_required', 'Send the file with its size (Content-Length).');
    const max = cfg.maxFileBytes ?? 2 * 1024 ** 3;
    if (size > max) return fail(res, 413, 'too_large', `Files can be at most ${Math.round(max / 1e6)} MB.`);
    // 1 day: confidential messages (web/src/confidential.ts), stored here as ciphertext.
    const days = { 1: 1, 7: 7, 30: 30, 0: 0 }[url.searchParams.get('expires') ?? '30'];
    if (days === undefined) return fail(res, 400, 'bad_expiry', 'Choose 1, 7 or 30 days, or never.');
    const name = cleanName(url.searchParams.get('name'));
    const wait = uploads.take(who.id);
    if (wait) return fail(res, 429, 'rate_limited', 'You’ve uploaded a lot of files recently. Try again in a little while.', { retryAfter: wait });
    // Uploads still streaming count too, and the check and the reservation happen with no await in between, so
    // parallel uploads can't each see the old total. ponytail: per process; with replicas, keep this in Valkey.
    const mine = [...links(cfg).values()].filter((l) => l.acct === who.id && !expired(l));
    const quota = cfg.filesQuotaBytes ?? 5 * 1024 ** 3, busy = inflight.get(who.id) ?? 0;
    if (mine.reduce((s, l) => s + l.size, 0) + busy + size > quota)
      return fail(res, 413, 'quota', 'You’ve shared a lot of large files. Remove some in Settings → Shared files, then try again.');
    inflight.set(who.id, busy + size);
    // The request may take longer than the service's usual 15 s (server.mjs), but only as long as a minimum rate
    // allows: a minute plus the file at 256 KB/s (2 GiB ≈ 2.3 hours). Stalls still end after a minute without data.
    req.allowSlowBody?.(60e3 + (size / (256 * 1024)) * 1000);
    req.setTimeout?.(60e3);
    let nodeId = null;
    try { return await store(req, res, who, size, name, days, (n) => { nodeId = n; }); }
    catch (e) { if (nodeId) await destroy({ acct: who.id, node: nodeId }); throw e; } // no file without its link
    finally { const left = (inflight.get(who.id) ?? size) - size; if (left > 0) inflight.set(who.id, left); else inflight.delete(who.id); }
  }

  async function store(req, res, who, size, name, days, created) {

    // Straight through to the sender's own account, never buffered here. The type is only a label for their own
    // storage: downloads are always served as application/octet-stream.
    const type = /^[\w.+-]+\/[\w.+-]+$/.test(req.headers['content-type'] ?? '') ? req.headers['content-type'] : 'application/octet-stream';
    const up = await fetch(`${cfg.stalwartUrl}/jmap/upload/${who.id}/`, { method: 'POST', duplex: 'half', body: Readable.toWeb(req),
      headers: { Authorization: auth, 'Content-Type': type, 'Content-Length': String(size) } });
    // ponytail: when anything below fails, the raw upload is left to Stalwart, which drops unreferenced uploads after
    // x:Jmap uploadTtl (1 hour) and doesn't count them toward the user's quota (checked on the dev server).
    if (!up.ok) { console.error('files: upload refused:', up.status, await up.text()); return fail(res, 503, 'unavailable', 'The file couldn’t be stored right now. Try again later.'); }
    const blob = await up.json();
    const parentId = await folder(who.id);
    const id = randomBytes(18).toString('base64url'); // 144 bits
    // Two files with one name can't share a folder: the second gets a bit of its link id.
    let r;
    for (const n of [name, name.replace(/(\.[^.]*)?$/, ` (${id.slice(0, 6)})$1`)]) {
      r = await fn(['FileNode/set', { accountId: who.id, create: { n: { '@type': 'File', name: n, parentId, blobId: blob.blobId, mediaType: type } } }, 'n']);
      if (r.created?.n || r.notCreated?.n?.type === 'overQuota') break;
    }
    if (r.notCreated?.n?.type === 'overQuota') return fail(res, 413, 'over_quota', 'Your storage is full. Delete some mail or shared files, then try again.');
    if (!r.created?.n) { console.error('files: Stalwart refused the file:', JSON.stringify(r.notCreated?.n)); return fail(res, 503, 'unavailable', 'The file couldn’t be stored right now. Try again later.'); }
    created(r.created.n.id);
    const node = (await fn(['FileNode/get', { accountId: who.id, ids: [r.created.n.id], properties: ['blobId'] }, 'g'])).list[0];
    const l = { acct: who.id, node: r.created.n.id, blobId: node.blobId, name, size: blob.size, created: Date.now(), expires: days ? Date.now() + days * DAY : null, downloads: 0 };
    links(cfg).set(id, l);
    try { save(cfg); } catch (e) { links(cfg).delete(id); throw e; }
    return send(res, 201, { ok: true, file: view(id, l) });
  }

  async function download(req, res, id) {
    const wait = downloads.take(ipOf(req));
    if (wait) return res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(wait) }).end('Too many downloads from your network. Try again later.\n');
    const l = ID.test(id) ? links(cfg).get(id) : undefined;
    const gone = () => res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' })
      .end('This link has expired or was removed by the sender. Ask them to share the file again.\n');
    if (!l || expired(l)) return gone();
    const r = await fetch(`${cfg.stalwartUrl}/jmap/download/${l.acct}/${l.blobId}/file?accept=application/octet-stream`, { headers: { Authorization: auth } });
    if (!r.ok) return gone(); // the sender deleted it from their storage
    l.downloads++; save(cfg);
    const ascii = l.name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
    // Never rendered here: a fixed binary type, attachment, no sniffing, and a sandbox in case a browser opens it anyway.
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': r.headers.get('content-length') ?? String(l.size),
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(l.name)}`,
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer' });
    if (req.method === 'HEAD') return void r.body?.cancel(), res.end();
    await pipeline(Readable.fromWeb(r.body), res).catch(() => {}); // the downloader went away
  }

  return async function handle(req, res, url) {
    const f = url.pathname.match(/^\/f\/([^/]+)$/);
    if (f) return (req.method === 'GET' || req.method === 'HEAD' ? await download(req, res, f[1]) : fail(res, 405, 'method_not_allowed', 'Not allowed.')), true;
    const m = url.pathname.match(/^\/api\/files(?:\/([A-Za-z0-9_-]{1,64}))?$/);
    if (!m) return false;
    // Sign-in checks as in aliases.mjs: only failures use up the per-network budget.
    const ip = ipOf(req), blocked = badAuth.take(ip), win = badAuth.window(ip);
    if (blocked) return fail(res, 429, 'rate_limited', 'Too many failed sign-ins from your network. Try again later.', { retryAfter: blocked }), true;
    let who;
    try { who = await caller(req); } catch (e) { badAuth.refund(ip, win); throw e; }
    if (!who) return fail(res, 401, 'unauthorized', 'Please sign in again.'), true;
    badAuth.refund(ip, win);

    if (!m[1] && req.method === 'POST') return await upload(req, res, url, who), true;
    if (!m[1] && req.method === 'GET') {
      const mine = [...links(cfg)].filter(([, l]) => l.acct === who.id && !expired(l));
      // Files the owner deleted from their storage (e.g. over WebDAV) take their links with them.
      const nodes = mine.length ? await fn(['FileNode/get', { accountId: who.id, ids: mine.map(([, l]) => l.node), properties: ['id'] }, 'g']) : { notFound: [] };
      const lost = new Set(nodes.notFound ?? []);
      if (lost.size) { for (const [id, l] of mine) if (lost.has(l.node)) links(cfg).delete(id); save(cfg); }
      return send(res, 200, { ok: true, files: mine.filter(([, l]) => !lost.has(l.node)).map(([id, l]) => view(id, l)).sort((a, b) => b.created - a.created) }), true;
    }
    if (m[1] && req.method === 'DELETE') {
      const l = links(cfg).get(m[1]);
      if (!l || l.acct !== who.id) return fail(res, 404, 'not_found', 'That link no longer exists.'), true;
      links(cfg).delete(m[1]); save(cfg);
      await destroy(l);
      return send(res, 200, { ok: true }), true;
    }
    return fail(res, 405, 'method_not_allowed', 'Not allowed.'), true;
  };
}
