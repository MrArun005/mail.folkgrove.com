#!/usr/bin/env node
// Configure the multi-node reference stack (deploy/scale/docker-compose.yml). Idempotent; re-run any time.
//   docker compose -f deploy/scale/docker-compose.yml up -d && node deploy/scale/setup.mjs
// Talks to stalwart-1 directly (127.0.0.1:18091). Settings live in the shared PostgreSQL data store, so
// both nodes get them; store/coordinator changes need a restart, done at the end one node at a time.
import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const NODE1 = 'http://127.0.0.1:18091', NODE2 = 'http://127.0.0.1:18092';
const ADMIN = 'Basic ' + Buffer.from(`admin:${process.env.ADMIN_PASSWORD ?? 'scale-dev-admin'}`).toString('base64');
const DOMAIN = 'openmail.test', USER = { name: 'alice', pass: 'alice-dev-pass' };
const sh = (cmd) => execSync(cmd, { cwd: here, stdio: 'inherit' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(calls, base = NODE1) {
  const res = await fetch(`${base}/jmap/`, {
    method: 'POST', headers: { Authorization: ADMIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ using: ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], methodCalls: calls }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const out = (await res.json()).methodResponses;
  for (const [name, args] of out) {
    const bad = name === 'error' ? [args] : ['notCreated', 'notUpdated', 'notDestroyed'].flatMap((k) => Object.values(args[k] ?? {}));
    if (bad.length) throw new Error(`${name}: ${JSON.stringify(bad)}`);
  }
  return out;
}
const set = (obj, value) => api([[`x:${obj}/set`, { update: { singleton: value } }, 's']]);
const list = async (obj, props) => (await api([[`x:${obj}/get`, { ids: null, ...(props && { properties: props }) }, 'g']]))[0][1].list;

async function waitReady(base) {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${base}/healthz/ready`)).ok) return; } catch {}
    await sleep(1000);
  }
  throw new Error(`${base} not ready (docker compose -f deploy/scale/docker-compose.yml logs)`);
}

await waitReady(NODE1);

// 1. Logs to stdout (the default Log tracer writes to /var/log/stalwart, which the image doesn't have).
if (!(await list('Tracer')).some((t) => t['@type'] === 'Stdout')) {
  await api([['x:Tracer/set', { create: { t: { '@type': 'Stdout', level: 'info' } } }, 't']]);
}

// 2. Shared stores. The data store (PostgreSQL) comes from config.json. Search stays in PostgreSQL (Default).
// The bucket must exist first, created through the S3 API: SeaweedFS 3.97 acks PUTs into a missing bucket
// (or one made with `weed shell` while its S3 gateway runs) but can't read them back, which Stalwart's
// verifyAfterWrite reports as "object not visible to read path". (Re-running: 409 "already exists" is fine.)
execSync('docker run --rm --network openmail-scale_mail curlimages/curl:8.11.1 -s -o /dev/null -X PUT ' +
  '--aws-sigv4 aws:amz:us-east-1:s3 --user stalwart:scale-dev-s3-secret http://seaweedfs:8333/stalwart', { stdio: 'inherit' });
await set('BlobStore', {
  '@type': 'S3', bucket: 'stalwart',
  region: { '@type': 'Custom', region: 'us-east-1', url: 'http://seaweedfs:8333' },
  accessKeyId: { '@type': 'Value', value: 'stalwart' },
  secretKey: { '@type': 'EnvironmentVariable', variableName: 'S3_SECRET' },
});
await set('InMemoryStore', { '@type': 'Redis', url: 'redis://valkey:6379' });
// Coordinator must come after a Redis in-memory store; Default = reuse that Redis connection (pub/sub).
await set('Coordinator', { '@type': 'Default' });

// 3. One public identity for every node, and real client IPs from haproxy's PROXY protocol header.
// (A fresh server started with config.json has no domain yet; SystemSettings requires a default one.)
let domain = (await list('Domain', ['name'])).find((d) => d.name === DOMAIN);
if (!domain) {
  const [[, r]] = await api([['x:Domain/set', { create: { d: { name: DOMAIN } } }, 'd']]);
  domain = { id: r.created.d.id };
}
await set('SystemSettings', { defaultHostname: `mx.${DOMAIN}`, defaultDomainId: domain.id, proxyTrustedNetworks: { '172.30.0.10/32': true } });

// 4. Mail limits (see docs/research/scale.md, "Recipient limits" and "Abuse controls").
await set('MtaStageRcpt', {
  // 100 is the default and the RFC 5321 minimum. Authenticated users get 500 so 150-recipient mail
  // from IMAP/SMTP clients works (JMAP submissions from the web client already bypass this limit).
  maxRecipients: { match: { 0: { if: '!is_empty(authenticated_as)', then: '500' } }, else: '100' },
});
// Scan outgoing (authenticated) mail too, not only inbound. A free provider needs this.
await set('MtaStageData', { enableSpamFilter: { match: {}, else: 'true' } });
// More parallel remote deliveries per node (default 50). Each thread holds one outbound SMTP connection.
const queues = await list('MtaVirtualQueue');
const remote = queues.find((q) => q.name === 'remote');
if (remote) await api([['x:MtaVirtualQueue/set', { update: { [remote.id]: { threadsPerNode: 200 } } }, 'q']]);
// Per-account daily cap on EXTERNAL recipients (counted cluster-wide in Valkey). Keyed on the account
// only; because match uses rcpt_domain it is checked at every RCPT TO, so it counts recipients, not
// messages. UNVERIFIED whether JMAP EmailSubmission (web client) passes through inbound throttles.
const throttles = await list('MtaInboundThrottle');
// --no-inbound-limits: switch off the two default throttles (5 connections/s per IP; 25/hour per sender
// domain+recipient) so loadtest.mjs from one IP to one mailbox measures the server, not the limits.
// Never in production.
if (process.argv.includes('--no-inbound-limits')) {
  const defaults = throttles.filter((t) => t.enable && ['Sender IP throttle', 'Sender address to recipient throttle'].includes(t.description));
  if (defaults.length) await api([['x:MtaInboundThrottle/set', { update: Object.fromEntries(defaults.map((t) => [t.id, { enable: false }])) }, 't']]);
}
if (!throttles.some((t) => t.description === 'Per-account daily recipient cap')) {
  await api([['x:MtaInboundThrottle/set', { create: { t: {
    description: 'Per-account daily recipient cap', enable: true, key: { authenticatedAs: true },
    match: { match: {}, else: '!is_empty(authenticated_as) && !is_local_domain(rcpt_domain)' },
    rate: { count: 2000, period: 86400000 },
  } } }, 't']]);
}

// 5. Prometheus metrics at /metrics/prometheus on every node (open-source; each node serves its own).
await set('Metrics', { prometheus: { '@type': 'Enabled', authUsername: 'prometheus',
  authSecret: { '@type': 'Value', secret: 'scale-dev-metrics' } } });

// 6. Test user, so loadtest.mjs works against this stack as it does against the dev server.
if (!(await list('Account', ['name'])).some((a) => a.name === USER.name)) {
  await api([['x:Account/set', { create: { u: { '@type': 'User', name: USER.name, domainId: domain.id,
    credentials: { 0: { '@type': 'Password', secret: USER.pass } } } } }, 'a']]);
}

// 7. Stores, coordinator and listeners are read at startup: restart the nodes one at a time.
for (const [svc, base] of [['stalwart-1', NODE1], ['stalwart-2', NODE2]]) {
  sh(`docker compose restart ${svc}`);
  await waitReady(base);
}
await waitReady('http://127.0.0.1:18081'); // haproxy marks the restarted nodes UP after a few checks
const nodes = await list('ClusterNode');
console.log('Cluster nodes:', nodes.map((n) => `${n.nodeId}=${n.hostname} (${n.status})`).join(', '));
const one = async (o) => (await api([[`x:${o}/get`, { ids: ['singleton'] }, 'g']]))[0][1].list[0]['@type'];
console.log(`Stores: blob=${await one('BlobStore')} inMemory=${await one('InMemoryStore')} coordinator=${await one('Coordinator')}`);
console.log(`
Ready. Through haproxy:
  SMTP    localhost:12525   node deploy/scale/loadtest.mjs --port 12525 -n 200
  JMAP    http://localhost:18081/jmap/session   (${USER.name}@${DOMAIN} / ${USER.pass})
  Metrics curl -u prometheus:scale-dev-metrics http://127.0.0.1:18091/metrics/prometheus`);
