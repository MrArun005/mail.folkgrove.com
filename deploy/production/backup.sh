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
#
# Hosted mode (install.sh --hosted): instead of the volumes, a pg_dump of the PostgreSQL database (custom
# format) and a mirror of the S3 blob bucket, taken while Stalwart keeps running. Same commands, same file.
# ponytail: a nightly dump loses up to a day of mail if the disk dies. Next step: PostgreSQL WAL archiving
# (e.g. pgBackRest or WAL-G to object storage) for point-in-time recovery, plus S3 bucket versioning.
set -euo pipefail
cd "$(dirname "$0")"
KEEP=14
die() { echo "ERROR: $*" >&2; exit 1; }
command -v age >/dev/null || die "age is required: apt install age"
dc() { docker compose "$@"; }
# Runs a shell in a one-off Stalwart container that has the data volumes mounted (not the running one).
in_volumes() { dc run --rm --no-deps -T -u 0 --entrypoint sh stalwart -c "$1"; }
# shellcheck disable=SC1091
hosted=$( [ -f .env ] && . ./.env; echo "${HOSTED:-0}")
psql_() { dc exec -T postgres "$@"; }

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
    [ -f "$tmp/volumes.tar.gz" ] || [ -f "$tmp/stalwart.pgdump" ] || die "Not a openmail backup"
    for f in .env .admin-credentials .system-mail.env; do
      [ -f "$tmp/$f" ] || continue
      [ -f "$f" ] && cp -p "$f" "$f.before-restore"; cp -p "$tmp/$f" "$f"
    done
    dc stop stalwart 2>/dev/null || true
    if [ -f "$tmp/stalwart.pgdump" ]; then
      # Hosted: recreate the database from the dump, put the blobs back, and make the database password match
      # the restored .env (a new server's PostgreSQL may have been created with another one).
      dc up -d --wait postgres seaweedfs
      psql_ dropdb -U stalwart --if-exists stalwart
      psql_ createdb -U stalwart stalwart
      psql_ pg_restore -U stalwart -d stalwart --no-owner < "$tmp/stalwart.pgdump"
      # shellcheck disable=SC1091
      pg_pass=$(. ./.env; echo "$PG_PASSWORD")
      psql_ psql -q -U stalwart -d postgres -c "ALTER USER stalwart PASSWORD '$pg_pass'"
      for i in $(seq 1 30); do dc run --rm -T rclone mkdir s3:stalwart 2>/dev/null && break; [ "$i" = 30 ] && die "S3 not reachable"; sleep 2; done
      dc run --rm -T -v "$tmp/blobs:/mirror:ro" rclone sync /mirror s3:stalwart
    else
      in_volumes 'find /etc/stalwart /var/lib/stalwart -mindepth 1 -delete && tar -xzf - --numeric-owner -C /' < "$tmp/volumes.tar.gz"
    fi
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
    if [ "$hosted" = 1 ]; then
      # Database first, then blobs: every blob the dump points to is in the mirror.
      # ponytail: a blob deleted in the seconds between the two is missing from this backup (its message was
      # being deleted anyway); bucket versioning closes that gap.
      psql_ pg_dump -U stalwart -Fc stalwart > "$tmp/stalwart.pgdump"
      mkdir "$tmp/blobs"
      dc run --rm -T -v "$tmp/blobs:/mirror" rclone sync s3:stalwart /mirror
      data="stalwart.pgdump blobs"
    else
      dc stop stalwart
      in_volumes 'tar -czf - --numeric-owner -C / etc/stalwart var/lib/stalwart' > "$tmp/volumes.tar.gz"
      dc start stalwart
      data=volumes.tar.gz
    fi
    cp -p .env .admin-credentials "$tmp/"
    [ -f .system-mail.env ] && cp -p .system-mail.env "$tmp/" && data="$data .system-mail.env"
    # shellcheck disable=SC2086
    tar -cf - -C "$tmp" $data .env .admin-credentials | age -R backup-recipient.txt > "$out.part"
    mv "$out.part" "$out"
    # ponytail: local rotation only; copy backups/ off this server (see docs/self-hosting.md).
    find backups -name 'openmail-*.tar.gz.age' | sort -r | tail -n +$((KEEP + 1)) | xargs rm -f
    echo "Backup: $PWD/$out ($(du -h "$out" | cut -f1))" ;;

  *) sed -n '2,15p' "$0"; exit 1 ;;
esac
