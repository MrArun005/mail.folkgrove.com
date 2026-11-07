#!/usr/bin/env bash
# Encrypted backup and restore of the whole mail server: Stalwart's two volumes (all mail, accounts,
# settings, DKIM keys, certificate copy) plus .env and .admin-credentials.
#
#   ./backup.sh --recipient age1...      first time: save the public key backups are encrypted to
#   ./backup.sh                          make backups/openmail-<date>.tar.gz.age (keeps the newest 14)
#   ./backup.sh --restore FILE --identity KEYFILE
#
# Encryption is age (apt install age) to a public key. Make the key pair on your own computer
# (age-keygen -o openmail-backup.key) and keep the private key off this server: then a stolen
# server or backup bucket can't read old backups.
#
# Stalwart's RocksDB can't be copied while running, so Stalwart stops for the few seconds the copy
# takes. Senders retry, so no mail is lost; webmail shows an error meanwhile.
set -euo pipefail
cd "$(dirname "$0")"
KEEP=14
die() { echo "ERROR: $*" >&2; exit 1; }
command -v age >/dev/null || die "age is required: apt install age"
dc() { docker compose "$@"; }
# Runs a shell in a one-off Stalwart container that has the data volumes mounted (not the running one).
in_volumes() { dc run --rm --no-deps -T -u 0 --entrypoint sh stalwart -c "$1"; }

case ${1:-} in
  --recipient)
    [[ ${2:-} == age1* ]] || die "Give the public key from age-keygen (starts with age1)"
    echo "$2" > backup-recipient.txt
    echo "Saved. Backups will be encrypted to $2" ;;

  --restore)
    file=${2:-}; [ "${3:-}" = --identity ] && key=${4:-} || key=""
    [ -f "$file" ] && [ -f "$key" ] || die "Usage: ./backup.sh --restore FILE --identity KEYFILE"
    read -r -p "This REPLACES all mail and settings on this server with the backup. Type yes: " ok
    [ "$ok" = yes ] || exit 1
    tmp=$(mktemp -d "$PWD/.restore.XXXXXX"); trap 'rm -rf "$tmp"' EXIT
    age -d -i "$key" "$file" | tar -xf - -C "$tmp"
    [ -f "$tmp/volumes.tar.gz" ] || die "Not a openmail backup"
    for f in .env .admin-credentials; do [ -f "$f" ] && cp -p "$f" "$f.before-restore"; cp -p "$tmp/$f" "$f"; done
    dc stop stalwart 2>/dev/null || true
    in_volumes 'find /etc/stalwart /var/lib/stalwart -mindepth 1 -delete && tar -xzf - --numeric-owner -C /' < "$tmp/volumes.tar.gz"
    # shellcheck disable=SC1091
    web=$(. ./.env; echo "$WEB_DIST")
    if [ -f "$web/index.html" ]; then dc up -d; fi
    echo "Restored. On a new server: run ./install.sh --yes --ip <new IP> (builds webmail, starts everything),"
    echo "then update the A record and reverse DNS to the new IP." ;;

  "")
    [ -f .env ] || die "Run ./install.sh first"
    [ -f backup-recipient.txt ] || die "First run: ./backup.sh --recipient age1... (see the top of this file)"
    mkdir -p backups
    out=backups/openmail-$(date +%Y%m%d-%H%M%S).tar.gz.age
    tmp=$(mktemp -d "$PWD/.backup.XXXXXX"); trap 'rm -rf "$tmp"; dc start stalwart >/dev/null 2>&1' EXIT
    dc stop stalwart
    in_volumes 'tar -czf - --numeric-owner -C / etc/stalwart var/lib/stalwart' > "$tmp/volumes.tar.gz"
    dc start stalwart
    cp -p .env .admin-credentials "$tmp/"
    tar -cf - -C "$tmp" volumes.tar.gz .env .admin-credentials | age -R backup-recipient.txt > "$out.part"
    mv "$out.part" "$out"
    # ponytail: local rotation only; copy backups/ off this server (see docs/self-hosting.md).
    find backups -name 'openmail-*.tar.gz.age' | sort -r | tail -n +$((KEEP + 1)) | xargs rm -f
    echo "Backup: $PWD/$out ($(du -h "$out" | cut -f1))" ;;

  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
