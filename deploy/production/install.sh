#!/usr/bin/env bash
# One-command install of mail (Stalwart) + webmail (this repo's web client) on a fresh server.
# Safe to re-run: every step checks what already exists. Answers are remembered in .env.
#
#   ./install.sh                         interactive
#   ./install.sh --yes --domain example.com --hostname mx.example.com --email you@gmail.com \
#                --user you [--password ...] [--relay smtp-relay.brevo.com:587 --relay-user ... --relay-password ...]
#   ./install.sh --refresh-certs         copy Caddy's certificate into Stalwart (cron runs this daily)
#   ./install.sh --dns                   print the DNS records again
#   ./install.sh --local-test ...        throwaway stack on alternate ports, Caddy's internal CA, no cron
#
# Run ./install.sh --help for all flags.
# shellcheck disable=SC1091,SC2034  # .env is generated; settings are read back via ${!name}
set -euo pipefail
cd "$(dirname "$0")"
HERE=$PWD
REPO=$(cd ../.. && pwd)

say()  { printf '\033[1m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[33mWARNING: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: ./install.sh [options]
  --domain D            mail domain, the part after @ (e.g. example.com)
  --hostname H          server name (e.g. mx.example.com); webmail lives at https://H
  --email E             your email for Let's Encrypt expiry notices
  --user NAME           first mailbox: NAME@domain (also receives postmaster@)
  --password P          its password (default: ask, or generate one with --yes)
  --relay HOST:PORT     send outgoing mail through this smarthost (e.g. smtp-relay.brevo.com:587)
  --relay-user U        smarthost login
  --relay-password P    smarthost password
  --relay-spf INCLUDE   SPF include for the smarthost (guessed for Brevo, SMTP2GO, Mailgun, SES, Oracle)
  --no-relay            remove a previously configured relay (send directly on port 25)
  --ip IP               public IPv4 for the DNS records (default: detected)
  --web-dist DIR        use an already built web client instead of building web/
  --rebuild-web         rebuild the web client (do this after git pull)
  --yes                 never ask; use flags, saved answers and defaults
  --refresh-certs       only copy Caddy's certificate into Stalwart and reload it
  --dns                 only print the DNS records
  --local-test          test stack: project openmail-test, ports 10025/10465/10587/10993/10080/10443,
                        admin API on 127.0.0.1:18080, self-signed certificates, no cron
EOF
}

# ---------------------------------------------------------------------------------------------
# Settings: saved .env first, then flags.
YES=0 MODE=install REBUILD_WEB=0 LOCAL_TEST=0 NO_RELAY=0 USER_NAME="" USER_PASS=""
if [ -f .env ]; then set -a; . ./.env; set +a; fi
while [ $# -gt 0 ]; do
  case $1 in
    --domain) MAIL_DOMAIN=$2; shift ;;
    --hostname) MAIL_HOSTNAME=$2; shift ;;
    --email) ACME_EMAIL=$2; shift ;;
    --user) USER_NAME=$2; shift ;;
    --password) USER_PASS=$2; shift ;;
    --relay) RELAY_HOST=${2%:*}; RELAY_PORT=${2##*:}; [ "$RELAY_PORT" = "$2" ] && RELAY_PORT=587; shift ;;
    --relay-user) RELAY_USER=$2; shift ;;
    --relay-password) RELAY_PASSWORD=$2; shift ;;
    --relay-spf) RELAY_SPF=$2; shift ;;
    --no-relay) NO_RELAY=1 ;;
    --ip) SERVER_IP=$2; shift ;;
    --web-dist) WEB_DIST=$(cd "$2" && pwd); shift ;;
    --rebuild-web) REBUILD_WEB=1 ;;
    --yes|-y) YES=1 ;;
    --refresh-certs) MODE=certs; YES=1 ;;
    --dns) MODE=dns; YES=1 ;;
    --local-test) LOCAL_TEST=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "unknown option $1" ;;
  esac
  shift
done
[ "$NO_RELAY" = 1 ] && RELAY_HOST="" RELAY_PORT="" RELAY_USER="" RELAY_PASSWORD="" RELAY_SPF=""

ask() { # ask VAR "question" [default]: keeps the current value of VAR as the default
  local cur=${!1:-${3:-}} ans
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then printf -v "$1" '%s' "$cur"; return; fi
  read -r -p "$2${cur:+ [$cur]}: " ans
  printf -v "$1" '%s' "${ans:-$cur}"
}

# ---------------------------------------------------------------------------------------------
# Small helpers around the Stalwart management API (JMAP at /jmap/ on the loopback admin port).
dc() { docker compose "$@"; }
jstr() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }
# jq-lite: jget 'python expression over r (the methodResponses list)' < response
jget() { python3 -c "import json,sys; r=json.load(sys.stdin)['methodResponses']; v=$1; print('' if v is None else v)"; }

api() { # api '<methodCalls JSON>': prints the response, fails on any JMAP-level error
  local out
  out=$(curl -sS --fail-with-body -u "$ADMIN_AUTH" -H 'Content-Type: application/json' "$API/jmap/" \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":$1}") \
    || die "Stalwart API call failed: $out"
  printf '%s' "$out" | python3 -c '
import json, sys
for name, args, _ in json.load(sys.stdin)["methodResponses"]:
    bad = [args] if name == "error" else [v for k in ("notCreated", "notUpdated", "notDestroyed") for v in (args.get(k) or {}).values()]
    if bad: sys.exit(json.dumps(bad))' || die "Stalwart refused: see the message above"
  printf '%s' "$out"
}

wait_for_stalwart() {
  local i
  for _ in $(seq 1 120); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/jmap/session" || true)" != 000 ] && return
    sleep 2
  done
  die "Stalwart did not answer on $API (check: docker compose logs stalwart)"
}

restart_stalwart() { say "Restarting Stalwart"; dc restart stalwart >/dev/null; wait_for_stalwart; }

refresh_certs() { # copy Caddy's cert for the mail host into Stalwart, register it once, reload
  local crt certs id
  crt=$(dc exec -T caddy sh -c "ls -t /data/caddy/certificates/*/$MAIL_HOSTNAME/$MAIL_HOSTNAME.crt 2>/dev/null | head -n1" || true)
  if [ -z "$crt" ]; then
    warn "Caddy has no certificate for $MAIL_HOSTNAME yet (usually: DNS doesn't point here yet)."
    warn "Mail ports use a self-signed certificate until then. After DNS is set up, run: $HERE/install.sh --refresh-certs"
    return 0
  fi
  dc exec -T caddy cat "$crt" | dc exec -T stalwart sh -c 'mkdir -p /etc/stalwart/tls && cat > /etc/stalwart/tls/fullchain.pem'
  dc exec -T caddy cat "${crt%.crt}.key" | dc exec -T stalwart sh -c 'umask 077 && cat > /etc/stalwart/tls/privkey.pem'
  certs=$(api '[["x:Certificate/get",{"ids":null},"c"]]')
  id=$(jget "next((c['id'] for c in r[0][1]['list'] if c['certificate'].get('filePath') == '/etc/stalwart/tls/fullchain.pem'), None)" <<<"$certs")
  if [ -z "$id" ]; then
    id=$(api '[["x:Certificate/set",{"create":{"c":{
      "certificate":{"@type":"File","filePath":"/etc/stalwart/tls/fullchain.pem"},
      "privateKey":{"@type":"File","filePath":"/etc/stalwart/tls/privkey.pem"}}}},"c"]]' | jget "r[0][1]['created']['c']['id']")
    # Default certificate, so clients that send no server name (SNI) get it too.
    api "[[\"x:SystemSettings/set\",{\"update\":{\"singleton\":{\"defaultCertificateId\":$(jstr "$id")}}},\"s\"]]" >/dev/null
  fi
  api '[["x:Action/set",{"create":{"a":{"@type":"ReloadTlsCertificates"}}},"a"]]' >/dev/null
  say "Stalwart is using Caddy's certificate for $MAIL_HOSTNAME"
}

print_dns() { # build the record list from Stalwart's suggested zone, save it for check-dns.sh, print it
  local zone
  zone=$(api '[["x:Domain/get",{"ids":null,"properties":["name","dnsZoneFile"]},"d"]]')
  printf '%s' "$zone" | DOMAIN=$MAIL_DOMAIN HOST=$MAIL_HOSTNAME IP=$SERVER_IP RELAY_SPF=${RELAY_SPF:-} python3 -c '
import json, os, re, sys
env = os.environ
d = next(x for x in json.load(sys.stdin)["methodResponses"][0][1]["list"] if x["name"] == env["DOMAIN"])
text = re.sub(r"\(\s*(.*?)\s*\)", lambda m: " ".join(m.group(1).split()), d["dnsZoneFile"], flags=re.S)
rows = [(env["HOST"] + ".", "A", env["IP"])]
for line in text.splitlines():
    name, _, rtype, value = (line.split(None, 3) + [""] * 4)[:4]
    if not rtype:
        continue
    if rtype == "TXT":
        value = "".join(re.findall(r"\"((?:[^\"\\\\]|\\\\.)*)\"", value))
    # Skip POP3 (port not published) and TLSA: DANE pins would break at every Caddy renewal
    # (new key each time), and only matter with DNSSEC anyway.
    if name.startswith("_pop3s.") or rtype == "TLSA":
        continue
    if rtype == "TXT" and value.startswith("v=spf1") and name == env["DOMAIN"] + "." and env["RELAY_SPF"]:
        value = value.replace(" -all", " include:%s -all" % env["RELAY_SPF"])
    rows.append((name, rtype, value))
with open("dns-records.tsv", "w") as f:
    f.writelines("%s\t%s\t%s\n" % r for r in rows)
w = max(len(r[0]) for r in rows)
for name, rtype, value in rows:
    print("  %-6s %-*s  %s" % (rtype, w, name, value))
'
  cat <<EOF

  Names are full names; many DNS panels want only the part before ".$MAIL_DOMAIN" (or "@" for the domain itself).
  MX "10 $MAIL_HOSTNAME." means priority 10, target $MAIL_HOSTNAME. SRV is "priority weight port target".
  Don't add an AAAA (IPv6) record for $MAIL_HOSTNAME (see docs/self-hosting.md).

  ALSO set reverse DNS (PTR) for $SERVER_IP to $MAIL_HOSTNAME in your VPS provider's panel.
  Without it, Gmail and Outlook reject or spam-folder your mail.

  Then check everything with: $HERE/check-dns.sh   (saved to $HERE/dns-records.tsv)
EOF
}

# ---------------------------------------------------------------------------------------------
# Preflight.
for c in curl python3; do command -v $c >/dev/null || die "$c is required (apt install $c)"; done
if ! command -v docker >/dev/null; then
  [ "$(uname -s)" = Linux ] || die "Install Docker first: https://docs.docker.com/get-docker/"
  ans=n; [ "$YES" = 1 ] && ans=y
  [ "$YES" = 1 ] || read -r -p "Docker isn't installed. Install it now with get.docker.com? [Y/n] " ans
  case ${ans:-y} in [Yy]*) curl -fsSL https://get.docker.com | sh ;; *) die "Docker is required" ;; esac
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required (docker compose version)"
docker info >/dev/null 2>&1 || die "Can't talk to Docker. Run as root, or add yourself to the docker group."

if [ "$MODE" != install ]; then
  [ -f .env ] && [ -f .admin-credentials ] || die "Run ./install.sh first"
  API=http://127.0.0.1:${ADMIN_PORT:-8080}
  ADMIN_AUTH=$(cat .admin-credentials)
  if [ "$MODE" = certs ]; then refresh_certs; else print_dns; fi
  exit 0
fi

# ---------------------------------------------------------------------------------------------
# Questions.
say "Mail server setup"
ask MAIL_DOMAIN   "Mail domain, the part after @ (e.g. example.com)"
[ -n "${MAIL_DOMAIN:-}" ] || die "A mail domain is required (--domain)"
ask MAIL_HOSTNAME "Server hostname for this machine" "mx.$MAIL_DOMAIN"
ask ACME_EMAIL    "Your email for certificate expiry notices (not on this server)"
valid='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
[[ $MAIL_DOMAIN =~ $valid && $MAIL_HOSTNAME =~ $valid ]] || die "Domain and hostname must be lowercase names like example.com"
[ -n "${ACME_EMAIL:-}" ] || [ "$LOCAL_TEST" = 1 ] || die "An email for Let's Encrypt is required (--email)"
if [ "$YES" = 0 ] && [ -t 0 ] && [ -z "${RELAY_HOST:-}" ] && [ "$NO_RELAY" = 0 ]; then
  echo "Many clouds (Oracle, AWS, GCP, Azure, DigitalOcean...) block outgoing port 25."
  echo "If yours does, send through a relay (Brevo, SMTP2GO, Oracle Email Delivery...) on port 587."
  read -r -p "Use an outgoing mail relay? [y/N] " ans
  if [[ ${ans:-n} == [Yy]* ]]; then
    ask RELAY_HOST "Relay host (e.g. smtp-relay.brevo.com)"; ask RELAY_PORT "Relay port" 587
    ask RELAY_USER "Relay username"; read -r -s -p "Relay password: " RELAY_PASSWORD; echo
  fi
fi
if [ -n "${RELAY_HOST:-}" ] && [ -z "${RELAY_SPF:-}" ]; then
  case $RELAY_HOST in # ponytail: well-known providers only; others pass --relay-spf
    *brevo.com|*sendinblue.com) RELAY_SPF=spf.brevo.com ;;
    *smtp2go.com) RELAY_SPF=spf.smtp2go.com ;;
    *mailgun.org) RELAY_SPF=mailgun.org ;;
    *amazonaws.com) RELAY_SPF=amazonses.com ;;
    *oraclecloud.com) RELAY_SPF=rp.oracleemaildelivery.com ;;
  esac
  ask RELAY_SPF "SPF include for the relay (from your relay provider's docs)"
  [ -n "${RELAY_SPF:-}" ] || warn "No SPF include for the relay: SPF will fail for relayed mail (DKIM still passes)."
fi
[[ "${RELAY_PASSWORD:-}" != *"'"* ]] || die "Relay password can't contain a single quote (')"

if [ "$LOCAL_TEST" = 1 ]; then
  COMPOSE_PROJECT_NAME=openmail-test CADDY_CERT_ISSUER=internal ADMIN_PORT=18080
  HTTP_PORT=10080 HTTPS_PORT=10443 SMTP_PORT=10025 SUBMISSIONS_PORT=10465 SUBMISSION_PORT=10587 IMAPS_PORT=10993
  PUBLIC_URL=https://$MAIL_HOSTNAME:$HTTPS_PORT ACME_EMAIL=${ACME_EMAIL:-test@example.com}
  SERVER_IP=${SERVER_IP:-203.0.113.10}
else
  PUBLIC_URL=https://$MAIL_HOSTNAME
fi
API=http://127.0.0.1:${ADMIN_PORT:-8080}
[ -n "${SERVER_IP:-}" ] || SERVER_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
[ -n "${SERVER_IP:-}" ] || die "Couldn't detect this server's public IPv4; pass --ip"

# ---------------------------------------------------------------------------------------------
# Web client.
WEB_DIST=${WEB_DIST:-$REPO/web/dist}
if [ "$REBUILD_WEB" = 1 ] || [ ! -f "$WEB_DIST/index.html" ]; then
  [ "$WEB_DIST" = "$REPO/web/dist" ] || die "No index.html in $WEB_DIST"
  say "Building the web client (in a Node container, nothing installed on this machine)"
  docker run --rm -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$REPO/web:/app" -w /app node:22-alpine \
    sh -c 'npm ci --no-audit --no-fund && npm run build'
fi

# ---------------------------------------------------------------------------------------------
# .env (secrets: 600). Every value is single-quoted, which both bash and Compose read literally.
say "Writing $HERE/.env"
umask 077
{
  for v in COMPOSE_PROJECT_NAME MAIL_DOMAIN MAIL_HOSTNAME ACME_EMAIL PUBLIC_URL WEB_DIST \
           RELAY_HOST RELAY_PORT RELAY_USER RELAY_PASSWORD RELAY_SPF SERVER_IP CADDY_CERT_ISSUER \
           ADMIN_PORT HTTP_PORT HTTPS_PORT SMTP_PORT SUBMISSIONS_PORT SUBMISSION_PORT IMAPS_PORT; do
    [ -n "${!v:-}" ] && printf "%s='%s'\n" "$v" "${!v}"
  done
} > .env
umask 022

say "Starting the stack"
dc up -d
wait_for_stalwart

# ---------------------------------------------------------------------------------------------
# Bootstrap (first run only): Stalwart returns the permanent admin password exactly once.
if [ ! -f .admin-credentials ]; then
  boot_pass=$(dc logs --no-log-prefix stalwart 2>&1 | sed -n 's/^ *password: *//p' | tail -n1)
  [ -n "$boot_pass" ] || die "Stalwart is already set up but $HERE/.admin-credentials is missing. See 'Lost admin password' in docs/self-hosting.md."
  say "Bootstrapping Stalwart for $MAIL_DOMAIN"
  ADMIN_AUTH="admin:$boot_pass"
  res=$(api "[[\"x:Bootstrap/set\",{\"update\":{\"singleton\":{
    \"defaultHostname\":$(jstr "$MAIL_HOSTNAME"),\"defaultDomain\":$(jstr "$MAIL_DOMAIN"),
    \"requestTlsCertificate\":false,\"generateDkimKeys\":true,
    \"tracer\":{\"@type\":\"Stdout\",\"level\":\"info\"}}}},\"b\"]]")
  admin=$(jget "r[0][1]['updated']['singleton']['username'] + ':' + r[0][1]['updated']['singleton']['secret']" <<<"$res")
  (umask 077; printf '%s\n' "$admin" > .admin-credentials)
  say "Admin login saved to $HERE/.admin-credentials (keep a copy in your password manager)"
  restart_stalwart
fi
ADMIN_AUTH=$(cat .admin-credentials)

# ---------------------------------------------------------------------------------------------
# Server settings (idempotent).
NEED_RESTART=0

# Caddy sits in front of HTTP, so take the client IP from X-Forwarded-For (rate limits, auto-ban).
api '[["x:Http/set",{"update":{"singleton":{"clientIpSource":"xForwardedFor"}}},"h"]]' >/dev/null

# Port 587 (STARTTLS submission) isn't a Stalwart default; some mail apps and networks want it.
listeners=$(api '[["x:NetworkListener/get",{"ids":null,"properties":["name"]},"l"]]')
if [ "$(jget "any(l['name'] == 'submission' for l in r[0][1]['list'])" <<<"$listeners")" = False ]; then
  say "Adding the port 587 submission listener"
  api '[["x:NetworkListener/set",{"create":{"l":{"name":"submission","bind":{"[::]:587":true},
    "protocol":"smtp","useTls":true,"implicitTls":false}}},"l"]]' >/dev/null
  NEED_RESTART=1
fi

# Outgoing relay: a route named "relay", selected for every non-local recipient.
routes=$(api '[["x:MtaRoute/get",{"ids":null},"r"]]')
relay_id=$(jget "next((x['id'] for x in r[0][1]['list'] if x['name'] == 'relay'), None)" <<<"$routes")
if [ -n "${RELAY_HOST:-}" ]; then
  say "Sending outgoing mail via $RELAY_HOST:$RELAY_PORT"
  implicit=false; [ "$RELAY_PORT" = 465 ] && implicit=true
  fields="\"host\":$(jstr "$RELAY_HOST"),\"port\":$RELAY_PORT,\"implicitTls\":$implicit,
    \"authUsername\":$(jstr "${RELAY_USER:-}"),
    \"authSecret\":{\"@type\":\"EnvironmentVariable\",\"variableName\":\"RELAY_PASSWORD\"}"
  if [ -n "$relay_id" ]; then
    api "[[\"x:MtaRoute/set\",{\"update\":{$(jstr "$relay_id"):{$fields}}},\"r\"]]" >/dev/null
  else
    api "[[\"x:MtaRoute/set\",{\"create\":{\"r\":{\"@type\":\"Relay\",\"name\":\"relay\",
      \"description\":\"Outgoing smarthost (install.sh)\",$fields}}},\"r\"]]" >/dev/null
  fi
  route="'relay'"
else
  route="'mx'"
  [ -n "$relay_id" ] && api "[[\"x:MtaRoute/set\",{\"destroy\":[$(jstr "$relay_id")]},\"r\"]]" >/dev/null
fi
api "[[\"x:MtaOutboundStrategy/set\",{\"update\":{\"singleton\":{\"route\":{
  \"match\":{\"0\":{\"if\":\"is_local_domain(rcpt_domain)\",\"then\":\"'local'\"}},\"else\":\"$route\"}}}},\"s\"]]" >/dev/null

# Sending limits (docs/research/scale.md): signed-in senders may address 500 recipients per message (the default
# 100 stops a 150-person message from Thunderbird or Outlook; port 25 keeps 100), outgoing mail is spam-scanned
# too, and each account can reach at most 2,000 outside recipients a day (raise for trusted users).
api '[["x:MtaStageRcpt/set",{"update":{"singleton":{"maxRecipients":{"match":{"0":{"if":"!is_empty(authenticated_as)","then":"500"}},"else":"100"}}}},"r"]]' >/dev/null
api '[["x:MtaStageData/set",{"update":{"singleton":{"enableSpamFilter":{"match":{},"else":"true"}}}},"d"]]' >/dev/null
if ! api '[["x:MtaInboundThrottle/get",{"ids":null,"properties":["description"]},"t"]]' | grep -q 'Per-account daily recipient cap'; then
  api '[["x:MtaInboundThrottle/set",{"create":{"t":{"description":"Per-account daily recipient cap","enable":true,"key":{"authenticatedAs":true},
    "match":{"match":{},"else":"!is_empty(authenticated_as) && !is_local_domain(rcpt_domain)"},"rate":{"count":2000,"period":86400000}}}},"t"]]' >/dev/null
fi

# Login abuse: Stalwart bans an IP after 100 failed sign-ins a day, by default forever. Forever locks out whole offices or
# schools behind one shared IP (one phone with an old password is enough); an hour still stops password guessing.
api '[["x:Security/set",{"update":{"singleton":{"authBanPeriod":3600000}}},"s"]]' >/dev/null

# Apply the changes above (listeners only take effect after a restart).
if [ "$NEED_RESTART" = 1 ]; then restart_stalwart
else api '[["x:Action/set",{"create":{"a":{"@type":"ReloadSettings"}}},"a"]]' >/dev/null; fi
refresh_certs

# ---------------------------------------------------------------------------------------------
# First mailbox.
ask USER_NAME "First mailbox name (NAME@$MAIL_DOMAIN), empty to skip"
if [ -n "$USER_NAME" ]; then
  [[ $USER_NAME =~ ^[a-z0-9._-]+$ ]] || die "Mailbox name may use only a-z, 0-9, dot, dash, underscore"
  if [ -z "$USER_PASS" ]; then
    if [ "$YES" = 0 ] && [ -t 0 ]; then
      read -r -s -p "Password for $USER_NAME@$MAIL_DOMAIN (empty = generate one): " USER_PASS; echo
    fi
    [ -n "$USER_PASS" ] || { USER_PASS=$(python3 -c 'import secrets; print(secrets.token_urlsafe(15))'); NEW_PASS=1; }
  fi
  domains=$(api '[["x:Domain/get",{"ids":null,"properties":["name"]},"d"]]')
  domain_id=$(jget "next(d['id'] for d in r[0][1]['list'] if d['name'] == '$MAIL_DOMAIN')" <<<"$domains")
  accounts=$(api '[["x:Account/get",{"ids":null,"properties":["name","emailAddress","aliases"]},"a"]]')
  if [ "$(jget "any(a.get('emailAddress') == '$USER_NAME@$MAIL_DOMAIN' for a in r[0][1]['list'])" <<<"$accounts")" = True ]; then
    say "$USER_NAME@$MAIL_DOMAIN already exists (password unchanged)"
  else
    # postmaster@ is where DMARC and TLS reports go, so it lands in this first mailbox.
    alias=""
    [ "$(jget "any(a.get('emailAddress') == 'postmaster@$MAIL_DOMAIN' or any(x['name'] == 'postmaster' and x['domainId'] == '$domain_id'
      for x in (a.get('aliases') or {}).values()) for a in r[0][1]['list'])" <<<"$accounts")" = False ] \
      && [ "$USER_NAME" != postmaster ] \
      && alias=",\"aliases\":{\"0\":{\"name\":\"postmaster\",\"domainId\":$(jstr "$domain_id")}}"
    api "[[\"x:Account/set\",{\"create\":{\"u\":{\"@type\":\"User\",\"name\":$(jstr "$USER_NAME"),
      \"domainId\":$(jstr "$domain_id"),\"roles\":{\"@type\":\"User\"},
      \"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":$(jstr "$USER_PASS")}}$alias}}},\"a\"]]" >/dev/null
    say "Created $USER_NAME@$MAIL_DOMAIN${NEW_PASS:+ with password: $USER_PASS  (shown once)}"
  fi
fi

# ---------------------------------------------------------------------------------------------
# Register the webmail as an OAuth client, so it signs in with tokens (and two-factor) instead of passwords.
# Idempotent: updates the redirect address and scope if the client already exists.
clients=$(api '[["x:OAuthClient/get",{"ids":null,"properties":["clientId"]},"c"]]')
client_id=$(jget "next((c['id'] for c in r[0][1]['list'] if c['clientId'] == 'openmail-web'), None)" <<<"$clients")
oauth="\"redirectUris\":{$(jstr "$PUBLIC_URL/"):true},\"scopes\":{\"mail\":true,\"contacts\":true,\"calendars\":true,\"security\":true},\"description\":\"Webmail\""
if [ -n "$client_id" ]; then
  api "[[\"x:OAuthClient/set\",{\"update\":{$(jstr "$client_id"):{$oauth}}},\"c\"]]" >/dev/null
else
  api "[[\"x:OAuthClient/set\",{\"create\":{\"c\":{\"clientId\":\"openmail-web\",$oauth}}},\"c\"]]" >/dev/null
fi
say "Webmail sign-in (OAuth) registered for $PUBLIC_URL/"

# System sender for the account service (sign-up codes): noreply@domain with a random password, kept in
# .system-mail.env (root only) and read by the signup container. Created once; re-runs keep it.
if [ ! -f .system-mail.env ]; then
  sys_pass=$(python3 -c 'import secrets; print(secrets.token_urlsafe(24))')
  domains=$(api '[["x:Domain/get",{"ids":null,"properties":["name"]},"d"]]')
  domain_id=$(jget "next(d['id'] for d in r[0][1]['list'] if d['name'] == '$MAIL_DOMAIN')" <<<"$domains")
  api "[[\"x:Account/set\",{\"create\":{\"n\":{\"@type\":\"User\",\"name\":\"noreply\",\"domainId\":$(jstr "$domain_id"),
    \"description\":\"System sender (sign-up codes)\",\"credentials\":{\"0\":{\"@type\":\"Password\",\"secret\":$(jstr "$sys_pass")}}}}},\"n\"]]" >/dev/null
  ( umask 077; printf 'SYSTEM_SMTP_USER=noreply@%s\nSYSTEM_SMTP_PASS=%s\nSYSTEM_SMTP_TLS_NAME=%s\n' "$MAIL_DOMAIN" "$sys_pass" "$MAIL_HOSTNAME" > .system-mail.env )
  say "System sender noreply@$MAIL_DOMAIN created (sign-up codes)"
fi

# ---------------------------------------------------------------------------------------------
# Daily certificate hand-over from Caddy to Stalwart.
if [ "$LOCAL_TEST" = 0 ]; then
  line="17 4 * * * root $HERE/install.sh --refresh-certs >> /var/log/openmail-certs.log 2>&1"
  if [ -w /etc/cron.d ]; then
    echo "$line" > /etc/cron.d/openmail-certs
  else
    warn "Can't write /etc/cron.d (not root). Add this to root's crontab so certificate renewals reach Stalwart:"
    echo "  ${line/ root / }"
  fi
fi

# ---------------------------------------------------------------------------------------------
say "Add these DNS records at your DNS provider"
print_dns
if [ -z "${RELAY_HOST:-}" ] && [ "$LOCAL_TEST" = 0 ]; then
  timeout 5 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null \
    || warn "Outgoing port 25 looks blocked here. Re-run with --relay (see docs/self-hosting.md)."
fi
cat <<EOF

Done.
  Webmail:   $PUBLIC_URL   (works once DNS points here and the certificate is issued)
  Admin UI:  $PUBLIC_URL/admin   login in $HERE/.admin-credentials
  Mail apps: IMAP $MAIL_HOSTNAME:993 (TLS), SMTP $MAIL_HOSTNAME:465 (TLS) or 587 (STARTTLS)
  Backups:   $HERE/backup.sh   (see docs/self-hosting.md)
EOF
