# Queue metrics that Stalwart 1.0.3's /metrics/prometheus doesn't give: how many messages are queued, how old the
# oldest is, and which destination domains have recipients stuck in retry. Stalwart's own delivery counters carry no
# labels, so this is the only per-destination signal. Read on every Prometheus scrape from the admin API (stdlib only).
#   GET :9101/metrics
import base64, json, os, time
from collections import Counter
from datetime import datetime
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, urlopen

URL = os.environ.get('STALWART_URL', 'http://stalwart:8080') + '/jmap/'
with open(os.environ.get('ADMIN_FILE', '/run/secrets/admin')) as f:
    AUTH = 'Basic ' + base64.b64encode(f.read().strip().encode()).decode()
TOP = 20  # ponytail: label at most 20 domains (worst first) so a spam run can't explode Prometheus's series count


def jmap(calls):
    body = json.dumps({'using': ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap'], 'methodCalls': calls}).encode()
    with urlopen(Request(URL, body, {'Authorization': AUTH, 'Content-Type': 'application/json'}), timeout=20) as r:
        out = json.load(r)['methodResponses']
    errors = [args for name, args, _ in out if name == 'error']
    if errors:
        raise RuntimeError(errors)
    return out


def queue():
    # ponytail: reads the whole queue each scrape (500 per get, 16 gets per request). Fine to ~50k queued messages;
    # beyond that, scrape less often or sample.
    ids, pos = [], 0
    while True:
        page = jmap([['x:QueuedMessage/query', {'position': pos, 'limit': 8000}, 'q']])[0][1]['ids']
        ids += page
        pos += len(page)
        if len(page) < 8000:
            break
    msgs = []
    for i in range(0, len(ids), 8000):
        chunk = ids[i:i + 8000]
        calls = [['x:QueuedMessage/get', {'ids': chunk[j:j + 500], 'properties': ['createdAt', 'recipients']}, str(j)]
                 for j in range(0, len(chunk), 500)]
        for _, res, _ in jmap(calls):
            msgs += res['list']
    return msgs


def render(msgs, now):
    oldest, pending, deferred = 0.0, Counter(), Counter()
    for m in msgs:
        oldest = max(oldest, now - datetime.fromisoformat(m['createdAt'].replace('Z', '+00:00')).timestamp())
        for rcpt, r in (m.get('recipients') or {}).items():
            # Observed: "Scheduled". "Completed"/"PermanentFailure" are the done states (names from the binary, not seen live).
            if r.get('status', {}).get('@type') in ('Completed', 'PermanentFailure'):
                continue
            domain = rcpt.rpartition('@')[2].lower()
            pending[domain] += 1
            if r.get('retryCount', 0) > 0:
                deferred[domain] += 1
    lines = [
        '# HELP openmail_queue_messages Messages in the outgoing queue.', '# TYPE openmail_queue_messages gauge',
        f'openmail_queue_messages {len(msgs)}',
        '# HELP openmail_queue_oldest_seconds Age of the oldest queued message.', '# TYPE openmail_queue_oldest_seconds gauge',
        f'openmail_queue_oldest_seconds {oldest:.0f}',
        '# HELP openmail_queue_recipients Recipients waiting for delivery, by destination domain (top 20).',
        '# TYPE openmail_queue_recipients gauge',
    ]
    lines += [f'openmail_queue_recipients{{domain="{d}"}} {n}' for d, n in pending.most_common(TOP)]
    lines += ['# HELP openmail_queue_deferred_recipients Recipients that failed at least once and wait for a retry, by domain (top 20).',
              '# TYPE openmail_queue_deferred_recipients gauge']
    lines += [f'openmail_queue_deferred_recipients{{domain="{d}"}} {n}' for d, n in deferred.most_common(TOP)]
    return '\n'.join(lines) + '\n'


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        try:
            status, text = 200, render(queue(), time.time())
        except Exception as e:  # scrape fails -> Prometheus marks the target down, the QueueExporterDown alert fires
            status, text = 500, f'error: {e}\n'
        self.send_response(status)
        self.send_header('Content-Type', 'text/plain; version=0.0.4')
        self.end_headers()
        self.wfile.write(text.encode())

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    if os.environ.get('SELF_TEST'):
        msgs = [{'createdAt': '2026-01-01T00:00:00Z', 'recipients': {
            'a@Gmail.com': {'retryCount': 2, 'status': {'@type': 'TemporaryFailure'}},
            'b@gmail.com': {'retryCount': 0, 'status': {'@type': 'Scheduled'}},
            'c@x.org': {'retryCount': 3, 'status': {'@type': 'PermanentFailure'}}}}]
        out = render(msgs, datetime.fromisoformat('2026-01-01T00:31:00+00:00').timestamp())
        assert 'openmail_queue_messages 1\n' in out and 'openmail_queue_oldest_seconds 1860\n' in out, out
        assert 'openmail_queue_recipients{domain="gmail.com"} 2' in out and 'x.org' not in out, out
        assert 'openmail_queue_deferred_recipients{domain="gmail.com"} 1' in out, out
        print('ok')
    else:
        HTTPServer(('', 9101), Handler).serve_forever()
