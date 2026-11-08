#!/usr/bin/env bash
# Checks that the DNS records printed by install.sh are live, one PASS/FAIL line each.
#   ./check-dns.sh                 ask a public resolver (1.1.1.1)
#   ./check-dns.sh --resolver 8.8.8.8
# Exit code is the number of failed checks (0 = all good). New records can take minutes to hours to show up.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
RESOLVER=1.1.1.1
[ "${1:-}" = --resolver ] && RESOLVER=$2
[ -f dns-records.tsv ] && [ -f .env ] || { echo "Run ./install.sh first (it writes dns-records.tsv)"; exit 1; }
command -v dig >/dev/null || { echo "dig is required: apt install dnsutils"; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

fails=0
pass() { printf '\033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '\033[31mFAIL\033[0m  %s\n        want: %s\n        got:  %s\n' "$1" "$2" "${3:-(nothing)}"; fails=$((fails + 1)); }

# dig answers, one per line; TXT strings joined ("a" "b" -> ab) and unquoted.
lookup() { dig +short +time=3 +tries=2 "@$RESOLVER" "$2" "$1" | sed -e 's/" "//g' -e 's/^"//' -e 's/"$//'; }

while IFS=$'\t' read -r name type want; do
  got=$(lookup "$name" "$type")
  if [ "$type" = TXT ]; then
    match=$(grep -Fx -- "$want" <<<"$got")
    got=$(grep -F -- "${want%%[; ]*}" <<<"$got") # show only same-kind TXT records (v=spf1, v=DKIM1, ...)
  else match=$(grep -Fxi -- "$want" <<<"$got"); fi
  if [ -n "$match" ]; then pass "$type $name"; else fail "$type $name" "$want" "$(tr '\n' ' ' <<<"$got")"; fi
done < dns-records.tsv

# Reverse DNS (PTR) is set at the VPS provider, not at your DNS host.
got=$(dig +short +time=3 "@$RESOLVER" -x "$SERVER_IP")
if [ "$got" = "$MAIL_HOSTNAME." ]; then pass "PTR $SERVER_IP"; else fail "PTR $SERVER_IP (set it in your VPS provider's panel)" "$MAIL_HOSTNAME." "$got"; fi

# Optional: openpgpkey.<domain> lets other mail apps find users' encryption keys (Web Key Directory).
got=$(lookup "openpgpkey.$MAIL_DOMAIN" CNAME)
if [ -z "$got" ]; then printf '\033[33mNOTE\033[0m  CNAME openpgpkey.%s (optional): not set, so other mail apps can'"'"'t find your users'"'"' encryption keys\n' "$MAIL_DOMAIN"
elif [ "${got%.}" = "$MAIL_HOSTNAME" ]; then pass "CNAME openpgpkey.$MAIL_DOMAIN"
else fail "CNAME openpgpkey.$MAIL_DOMAIN (optional, but wrong)" "$MAIL_HOSTNAME." "$got"; fi

# Not DNS, but the other thing that silently breaks sending.
if [ -z "${RELAY_HOST:-}" ]; then
  if timeout 5 bash -c '</dev/tcp/gmail-smtp-in.l.google.com/25' 2>/dev/null; then pass "outgoing port 25 is open"
  else fail "outgoing port 25 (blocked? use a relay: ./install.sh --relay host:587 ...)" "connect to gmail-smtp-in.l.google.com:25" "timeout"; fi
fi

echo
if [ "$fails" = 0 ]; then echo "All good. Next: send a test to https://www.mail-tester.com"; else echo "$fails check(s) failed."; fi
exit "$fails"
