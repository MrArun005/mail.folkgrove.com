// Web Key Directory (draft-koch-openpgp-webkey-service): other mail apps (Thunderbird, Proton, GnuPG) find our users'
// OpenPGP public keys here, so they can write to them encrypted. A user's key is the one they uploaded in
// Settings → Security (Stalwart x:PublicKey); only keys made out to the address asked about are served.
//   direct:   https://<domain>/.well-known/openpgpkey/hu/<hash>?l=<local>
//   advanced: https://openpgpkey.<domain>/.well-known/openpgpkey/<domain>/hu/<hash>?l=<local>
// ponytail: answers only with ?l= (every current client sends it; without it we'd have to hash every account),
// and only for account names, not aliases.
import { createHash } from 'node:crypto';

export function zbase32(data) {
  const A = 'ybndrfg8ejkmcpqxot1uwisza345h769';
  let out = '', bits = 0, value = 0;
  for (const byte of data) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return out;
}
export const wkdHash = (local) => zbase32(createHash('sha1').update(local.replace(/[A-Z]/g, (c) => c.toLowerCase())).digest());

/** ASCII-armored key → binary (WKD serves binary). Null when it isn't an armored public key. */
export function dearmor(text) {
  const m = /-----BEGIN PGP PUBLIC KEY BLOCK-----\r?\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/.exec(text ?? '');
  if (!m) return null;
  const body = m[1].replace(/^(?:[^\r\n]*:[^\r\n]*\r?\n)*\r?\n/, ''); // armor headers ("Comment: …"), then a blank line
  return Buffer.from(body.split(/\r?\n/).filter((l) => !/^=[A-Za-z0-9+/]{4}$/.test(l.trim())).join(''), 'base64');
}

export function wkdRoutes({ cfg, jmap, getDomainId, RateLimiter, ipOf }) {
  const limit = new RateLimiter(60, 60e3);
  const reply = (res, status, body = '', type = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', 'Cache-Control': status === 200 ? 'public, max-age=3600' : 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  };
  return async function handle(req, res, url) {
    const m = url.pathname.match(/^\/\.well-known\/openpgpkey\/(?:([a-z0-9.-]+)\/)?(policy|hu\/([a-z0-9]{32}))$/);
    if (!m) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(res, 405), true;
    if (m[1] && m[1] !== cfg.domain) return reply(res, 404), true;
    if (m[2] === 'policy') return reply(res, 200), true; // an empty policy: "we run a WKD"
    if (limit.take(ipOf(req))) return reply(res, 429), true;
    const local = url.searchParams.get('l') ?? '';
    if (!local || local.length > 64 || wkdHash(local) !== m[3]) return reply(res, 404), true;
    const name = local.toLowerCase(), email = `${name}@${cfg.domain}`;
    const ids = (await jmap([['x:Account/query', { filter: { name, domainId: await getDomainId() } }, 'q']])).ids ?? [];
    if (ids.length !== 1) return reply(res, 404), true;
    const keys = (await jmap([['x:PublicKey/get', { accountId: ids[0], ids: null, properties: ['key', 'kind', 'emailAddresses'] }, 'k']])).list ?? [];
    const found = keys.filter((k) => k.kind === 'openPgp' && k.emailAddresses?.[email]).map((k) => dearmor(k.key)).filter(Boolean);
    if (!found.length) return reply(res, 404), true;
    return reply(res, 200, Buffer.concat(found), 'application/octet-stream'), true;
  };
}
