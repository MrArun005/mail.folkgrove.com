#!/usr/bin/env node
// SMTP load tester: measures how many messages per second a server ACCEPTS (250 after DATA).
// No dependencies (raw SMTP over node:net / node:tls). Node 20+.
//
//   node deploy/scale/loadtest.mjs                       200 msgs to alice@openmail.test via localhost:2525
//   node deploy/scale/loadtest.mjs -n 5000 -c 50         5000 msgs, 50 parallel connections
//   node deploy/scale/loadtest.mjs --port 1465 --tls --insecure --user alice@openmail.test --pass alice-dev-pass \
//        --to bob@example.com --rcpts 150 -n 1            submission (implicit TLS + AUTH PLAIN)
//
// Options:
//   --host H        default localhost          --port P      default 2525
//   -n, --count N   messages, default 200      -c, --conc C  parallel connections, default 10
//   --per-conn M    messages per connection before QUIT, default 10 (Stalwart's default maxMessages
//                   per session is 10; more gets "452 4.4.5")
//   --to ADDR       recipient, default alice@openmail.test
//   --rcpts K       recipients per message, default 1. K>1 sends to local+1..K@domain of --to
//                   (sub-addresses, so they all land in one mailbox locally)
//   --from ADDR     MAIL FROM, default loadtest@example.org (or --user when authenticated)
//   --size BYTES    approximate body size, default 2048
//   --tls           implicit TLS (port 465 style)
//   --insecure      with --tls: skip certificate verification (dev server's self-signed cert only)
//   --user U --pass P   AUTH PLAIN after EHLO
//
// What it measures: the receiving side (SMTP session + spam filter + queue write + local delivery
// ingest). It does not measure outbound delivery to the internet; use Stalwart's queue metrics for that.
// ponytail: no PIPELINING/CHUNKING; one command, one reply. That understates a tuned client a little.
import net from 'node:net';
import tls from 'node:tls';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';

const { values: o } = parseArgs({
  options: {
    host: { type: 'string', default: 'localhost' },
    port: { type: 'string', default: '2525' },
    count: { type: 'string', short: 'n', default: '200' },
    conc: { type: 'string', short: 'c', default: '10' },
    'per-conn': { type: 'string', default: '10' },
    to: { type: 'string', default: 'alice@openmail.test' },
    rcpts: { type: 'string', default: '1' },
    from: { type: 'string' },
    size: { type: 'string', default: '2048' },
    tls: { type: 'boolean', default: false },
    insecure: { type: 'boolean', default: false },
    user: { type: 'string' },
    pass: { type: 'string' },
  },
});
const N = +o.count, C = Math.min(+o.conc, N), PER = +o['per-conn'], K = +o.rcpts, PORT = +o.port;
const FROM = o.from ?? o.user ?? 'loadtest@example.org';
const [toLocal, toDomain] = o.to.split('@');
const rcpts = K === 1 ? [o.to] : Array.from({ length: K }, (_, i) => `${toLocal}+${i + 1}@${toDomain}`);
const filler = (randomBytes(Math.ceil(+o.size * 0.75)).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
const runId = Date.now().toString(36);

// One SMTP connection: send a line, wait for the full (possibly multi-line) reply.
function connect() {
  return new Promise((resolve, reject) => {
    const opts = { host: o.host, port: PORT };
    const sock = o.tls ? tls.connect({ ...opts, rejectUnauthorized: !o.insecure, servername: o.host }) : net.connect(opts);
    let buf = '', waiter = null;
    const pump = () => {
      // A reply ends with a line "ddd " (space after the code); "ddd-" lines continue it.
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n/);
      if (!m || !waiter) return;
      const end = m.index + m[0].length;
      const text = buf.slice(0, end); buf = buf.slice(end);
      const w = waiter; waiter = null; w({ code: +m[1], text: text.trim() });
    };
    const read = () => new Promise((r) => { waiter = r; pump(); });
    sock.setEncoding('utf8');
    sock.on('data', (d) => { buf += d; pump(); });
    sock.on('error', (e) => { if (waiter) { const w = waiter; waiter = null; w({ code: 0, text: e.message }); } else reject(e); });
    sock.on('close', () => { if (waiter) { const w = waiter; waiter = null; w({ code: 0, text: 'connection closed' }); } });
    sock.once(o.tls ? 'secureConnect' : 'connect', async () => {
      const cmd = (line) => { sock.write(line + '\r\n'); return read(); };
      resolve({ greeting: await read(), cmd, raw: (s) => { sock.write(s); return read(); }, end: () => sock.end() });
    });
  });
}

const stats = { ok: 0, temp: 0, perm: 0, err: 0, rcptRefused: 0, lat: [], firstErrors: new Map() };
const note = (r) => { const k = r.text.split('\r\n').pop().slice(0, 90); stats.firstErrors.set(k, (stats.firstErrors.get(k) ?? 0) + 1); };
let next = 0;

async function worker() {
  while (next < N) {
    let s;
    try { s = await connect(); } catch (e) { stats.err++; note({ text: e.message }); next++; continue; }
    if (s.greeting.code !== 220) { stats.err++; note(s.greeting); s.end(); next++; continue; }
    let r = await s.cmd(`EHLO loadtest.${runId}.invalid`);
    if (r.code !== 250) { stats.err++; note(r); s.end(); next++; continue; }
    if (o.user) {
      r = await s.cmd('AUTH PLAIN ' + Buffer.from(`\0${o.user}\0${o.pass ?? ''}`).toString('base64'));
      if (r.code !== 235) { stats.perm++; note(r); s.end(); next = N; break; } // bad credentials: stop everything
    }
    for (let i = 0; i < PER && next < N; i++) {
      const id = next++;
      const t0 = performance.now();
      r = await s.cmd(`MAIL FROM:<${FROM}>`);
      if (r.code !== 250) { r.code >= 500 ? stats.perm++ : stats.temp++; note(r); await s.cmd('RSET'); continue; }
      let accepted = 0;
      for (const rc of rcpts) {
        const rr = await s.cmd(`RCPT TO:<${rc}>`);
        if (rr.code === 250 || rr.code === 251) accepted++; else { stats.rcptRefused++; note(rr); }
      }
      if (!accepted) { stats.temp++; await s.cmd('RSET'); continue; }
      r = await s.cmd('DATA');
      if (r.code !== 354) { r.code >= 500 ? stats.perm++ : stats.temp++; note(r); await s.cmd('RSET'); continue; }
      const msg = [
        `From: Load test <${FROM}>`, `To: <${rcpts[0]}>`, `Subject: loadtest ${runId} #${id}`,
        `Date: ${new Date().toUTCString()}`, `Message-ID: <${runId}.${id}@loadtest.invalid>`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=us-ascii', '',
        `Load test message ${id} of run ${runId}.`, filler, '',
      ].join('\r\n').replace(/\r\n\./g, '\r\n..'); // dot-stuffing
      r = await s.raw(msg + '\r\n.\r\n');
      if (r.code === 250) { stats.ok++; stats.lat.push(performance.now() - t0); }
      else { r.code >= 500 ? stats.perm++ : r.code >= 400 ? stats.temp++ : stats.err++; note(r); if (!r.code) break; }
    }
    await s.cmd('QUIT').catch(() => {});
    s.end();
  }
}

const t0 = performance.now();
const tick = setInterval(() => process.stderr.write(`\r${stats.ok} accepted, ${stats.temp + stats.perm + stats.err} failed...`), 1000);
await Promise.all(Array.from({ length: C }, worker));
clearInterval(tick);
const secs = (performance.now() - t0) / 1000;
const pct = (p) => { const a = [...stats.lat].sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : '-'; };
process.stderr.write('\r');
console.log(`target      ${o.tls ? 'smtps' : 'smtp'}://${o.host}:${PORT}  ${o.user ? 'auth ' + o.user : 'no auth'}  ${C} conns, ${PER}/conn, ${K} rcpt/msg, ~${o.size} B`);
console.log(`accepted    ${stats.ok}/${N} messages in ${secs.toFixed(2)} s  =  ${(stats.ok / secs).toFixed(1)} msgs/s  (${(stats.ok * K / secs).toFixed(1)} rcpts/s)`);
console.log(`latency     MAIL FROM..250 after DATA: p50 ${pct(0.5)} ms, p95 ${pct(0.95)} ms, p99 ${pct(0.99)} ms`);
console.log(`failures    temp ${stats.temp}, perm ${stats.perm}, conn ${stats.err}, refused rcpts ${stats.rcptRefused}`);
for (const [k, v] of stats.firstErrors) console.log(`  ${v}x  ${k}`);
process.exitCode = stats.ok === N ? 0 : 1;
