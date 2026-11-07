// System mail (sign-up codes): sent through our own mail server as a system account, over SMTP submission with TLS.
// Stalwart then routes it like any mail (directly, or through the relay). No dependency: a few SMTP commands.
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

/** One message. cfg: { host, port, user, pass, servername?, insecure? } (implicit TLS, i.e. port 465). */
export function sendMail(cfg, { from, to, subject, text }) {
  if (/[\r\n]/.test(from + to + subject)) return Promise.reject(new Error('header injection')); // never trust inputs
  const msg = [
    `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@').pop().replace(/>$/, '')}>`,
    'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated', '', text,
  ].join('\r\n');
  return sendRaw(cfg, { from: addr(from), to: [addr(to)], raw: msg });
}

/** A ready-made message (CRLF lines) to any recipients, as is. Used to release held mail (hold.mjs). */
export function sendRaw(cfg, { from, to, raw }) {
  if (/[\r\n<>]/.test(from + to.join(''))) return Promise.reject(new Error('bad address'));
  const plain = Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64');
  const steps = [
    ['', 220], [`EHLO ${cfg.helo ?? 'openmail-account-service'}`, 250], [`AUTH PLAIN ${plain}`, 235],
    [`MAIL FROM:<${from}>`, 250], ...to.map((t) => [`RCPT TO:<${t}>`, 250]), ['DATA', 354],
    [raw.replace(/\r?\n/g, '\r\n').replace(/(\r\n)?$/, '\r\n').replace(/^\./gm, '..') + '.', 250], ['QUIT', 221],
  ];
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.servername ?? cfg.host, rejectUnauthorized: !cfg.insecure });
    let buf = '', i = 0;
    const next = () => { if (++i < steps.length) sock.write(steps[i][0] + '\r\n'); };
    sock.setTimeout(20_000, () => { sock.destroy(); reject(new Error('mail server timed out')); });
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf += d;
      // A reply is complete when a line has "NNN " (space, not dash) at the start.
      const lines = buf.split('\r\n'); buf = lines.pop();
      for (const l of lines) {
        if (!/^\d{3} /.test(l)) continue;
        if (Number(l.slice(0, 3)) !== steps[i][1]) { sock.destroy(); return reject(new Error(`mail server said: ${l}`)); }
        if (i === steps.length - 1) { sock.end(); return resolve(); }
        next();
      }
    });
  });
}
const addr = (s) => (/<([^>]+)>/.exec(s)?.[1] ?? s).trim();
