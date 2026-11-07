// WKD: the hash, armor → binary, and the route (with a stand-in for Stalwart's admin API).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../lib.mjs';
import { dearmor, wkdHash, wkdRoutes } from '../wkd.mjs';

test('hash is z-base-32 of SHA-1 of the lowercased local part (spec example)', () => {
  assert.equal(wkdHash('Joe.Doe'), 'iy9q119eutrkn8s1mk4r39qejnbu3n5q');
});

const bytes = Buffer.from('not really a key, but bytes all the same');
const armored = (headers = '') => `-----BEGIN PGP PUBLIC KEY BLOCK-----\n${headers}\n${bytes.toString('base64').replace(/.{20}/g, '$&\n')}\n=AbCd\n-----END PGP PUBLIC KEY BLOCK-----\n`;

test('dearmor drops armor headers and the checksum', () => {
  assert.deepEqual(dearmor(armored()), bytes);
  assert.deepEqual(dearmor(armored('Comment: hi\n')), bytes);
  assert.equal(dearmor('-----BEGIN CERTIFICATE-----'), null);
});

test('route: serves the key made out to the address, with CORS; refuses everything else', async () => {
  const calls = [];
  const jmap = async ([[method, args]]) => {
    calls.push(method);
    if (method === 'x:Account/query') return { ids: args.filter.name === 'joe.doe' ? ['a1'] : [] };
    return { list: [
      { kind: 'openPgp', emailAddresses: { 'joe.doe@x.test': true }, key: armored() },
      { kind: 'openPgp', emailAddresses: { 'other@else.test': true }, key: armored() }, // not this address: never served
      { kind: 'smime', emailAddresses: { 'joe.doe@x.test': true }, key: '-----BEGIN CERTIFICATE-----' },
    ] };
  };
  const handle = wkdRoutes({ cfg: { domain: 'x.test' }, jmap, getDomainId: async () => 'd', RateLimiter, ipOf: () => 'ip' });
  const get = async (path) => {
    const res = { writeHead(s, h) { Object.assign(this, { s, h }); }, end(b) { this.b = b; } };
    const handled = await handle({ method: 'GET' }, res, new URL(`http://x${path}`));
    return handled ? res : null;
  };
  const h = wkdHash('Joe.Doe');
  for (const path of [`/.well-known/openpgpkey/hu/${h}?l=Joe.Doe`, `/.well-known/openpgpkey/x.test/hu/${h}?l=Joe.Doe`]) {
    const r = await get(path);
    assert.equal(r.s, 200);
    assert.equal(r.h['Access-Control-Allow-Origin'], '*');
    assert.deepEqual(r.b, bytes); // one key: the other address's and the certificate are left out
  }
  assert.equal((await get(`/.well-known/openpgpkey/hu/${h}?l=someone.else`)).s, 404); // hash doesn't match l
  assert.equal((await get(`/.well-known/openpgpkey/hu/${h}`)).s, 404);
  assert.equal((await get(`/.well-known/openpgpkey/other.test/hu/${h}?l=Joe.Doe`)).s, 404);
  assert.equal((await get('/.well-known/openpgpkey/policy')).s, 200);
  assert.equal(await get('/.well-known/openpgpkey/hu/../../etc'), null);
});
