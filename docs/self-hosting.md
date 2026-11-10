# Self-hosting OpenMail

This guide sets up your own mail server with webmail on a rented server (a VPS). You need a domain you control and about 30 minutes, most of which is waiting for DNS.

What you get:

- **Mail server:** [Stalwart](https://stalw.art) receives, sends, and stores your mail, and filters spam.
- **Webmail:** this project's web client at `https://mx.example.com`.
- **Mail apps:** Thunderbird, Apple Mail, phones and similar apps connect over IMAP and SMTP.
- **HTTPS:** free Let's Encrypt certificates, renewed automatically.
- **Backups:** encrypted, with a restore procedure that has been tested.

Throughout this guide, `example.com` is your mail domain (the part after `@`) and `mx.example.com` is the server's name. Replace them with your own.

## 1. Requirements

**A server.** Ubuntu 24.04 with 2 GB RAM (1 GB works if you add swap) and 20 GB of disk or more. It needs a static public IPv4 address. Oracle Cloud Always Free, Hetzner, OVH and similar hosts all work.

**A domain** where you can add DNS records.

**Inbound ports.** Open these in your cloud provider's firewall:

| Port | Used for |
|---|---|
| 25 | Receiving mail from other servers |
| 80, 443 | Webmail, HTTPS certificates, autoconfig, MTA-STS |
| 465, 587 | Mail apps sending mail |
| 993 | Mail apps reading mail (IMAP) |

On Oracle Cloud, add these ports as ingress rules in the subnet's Security List.

**Outbound port 25.** Most clouds block it to stop spam, including Oracle, AWS, Google Cloud, Azure, DigitalOcean, and new accounts at many other hosts. Without it, your server can't deliver mail directly. You have two options:

- Ask your provider to unblock it. Hetzner does this after your first paid invoice; AWS and others have a request form.
- Send through a **relay**, also called a smarthost: a service that delivers mail for you over port 587, which clouds don't block. [Brevo](https://www.brevo.com) has a free tier of 300 mails a day, [SMTP2GO](https://www.smtp2go.com) has 1,000 a month, and [Oracle Email Delivery](https://docs.oracle.com/iaas/Content/Email/home.htm) is included with Oracle Cloud. Create an account, verify your domain with the provider, and note the SMTP host, port, username and password. Receiving mail still works directly and doesn't use the relay.

The installer tests port 25 for you and warns if it's blocked.

**Reverse DNS (PTR).** Your server's IP must map back to `mx.example.com`. You set this in your VPS provider's panel, not at your DNS host. Look for "reverse DNS" or "PTR"; on Oracle, file a support request. Gmail and Outlook reject or spam-folder mail from servers without it.

**IPv6:** leave it off for now. Docker passes inbound IPv6 connections through a proxy that hides the sender's real address. Stalwart's SPF checks on incoming mail need that address, so don't add an AAAA record for `mx.example.com`. IPv4 handles all mail.

## 2. Install

```sh
git clone https://github.com/<you>/openmail.git
cd openmail/deploy/production
sudo ./install.sh
```

The installer asks for:

- your mail domain
- the server hostname (default `mx.<domain>`)
- an email address for certificate-expiry notices
- whether to use a relay
- the first mailbox name and password

It then:

1. installs Docker, if it's missing and you agree
2. builds the web client inside a temporary Node container, so nothing extra is installed on the server
3. starts Stalwart and Caddy
4. sets up Stalwart
5. saves the admin password to `deploy/production/.admin-credentials`, readable by root only. Copy it to your password manager.
6. creates a team mailbox for `abuse@` and `postmaster@` (where complaints, DMARC and TLS reports go), then your mailbox, which is a member: open the team mailbox from the account menu in the web app
7. prints the DNS records you need to add

To install without prompts, for example on Oracle Cloud with a Brevo relay:

```sh
sudo ./install.sh --yes --domain example.com --hostname mx.example.com --email you@gmail.com \
  --user you --relay smtp-relay.brevo.com:587 --relay-user 1234abc@smtp-brevo.com --relay-password 'xsmtpsib-...'
```

Run `./install.sh --help` for all options. The installer is safe to re-run. It remembers your answers in `.env` and only changes what's needed. Re-running it is how you:

| Task | Command |
|---|---|
| Add or change the relay | `--relay ...` |
| Remove the relay | `--no-relay` |
| Add another mailbox | `--yes --user bob` (prints a generated password) |
| Update after `git pull` | `--rebuild-web` |
| Show the DNS records again | `--dns` |

### How it fits together

```
Internet ──80/443──▶ Caddy ── /, /assets/*  → web client (web/dist)
                           └─ everything else (/jmap, /.well-known, /admin, /dav, …) → Stalwart :8080
Internet ──25/465/587/993──▶ Stalwart
```

Caddy gets the HTTPS certificate. Stalwart needs the same certificate for its mail ports. It can't fetch one itself here, because its certificate check (ACME) needs port 443, which Caddy already uses. So a daily cron job, `install.sh --refresh-certs` in `/etc/cron.d/openmail-certs`, copies Caddy's current certificate into Stalwart and reloads it.

## 3. DNS

Add every record the installer printed at your DNS host. Here's what each one does:

| Record | Purpose |
|---|---|
| `A mx.example.com` | Points the server name at your IP |
| `MX example.com` | Tells the world where to deliver mail for `@example.com` |
| `TXT example.com v=spf1 …` (SPF) | Lists which servers may send as `@example.com`. With a relay, it includes the relay's servers. |
| `TXT …._domainkey…` (DKIM) | Public keys for the signature Stalwart adds to every outgoing message. There are two: Ed25519 and RSA. |
| `TXT _dmarc…` (DMARC) | Tells receivers to reject mail that fails SPF and DKIM, and where to send reports |
| `CNAME mta-sts…`, `TXT _mta-sts…`, `TXT _smtp._tls…` | MTA-STS and TLS-RPT: other servers must use encryption when sending to you, and report problems |
| `SRV _imaps._tcp…`, `_submissions._tcp…`, `CNAME autoconfig…`, `autodiscover…` | Let mail apps find your server settings automatically |
| `CNAME openpgpkey.example.com` → your mail host (optional, add it yourself) | Web Key Directory: other mail apps (Thunderbird, Proton, GnuPG) find your users' encryption keys here. Caddy serves it from the account service |

The record names are printed in full. Many DNS panels want only the part before your domain, for example `_dmarc` instead of `_dmarc.example.com`, and `@` for the domain itself. The RSA DKIM value is long. Paste it as one value; most panels split it automatically.

Check your records with:

```sh
./check-dns.sh
```

It prints one PASS or FAIL line per record, plus checks for reverse DNS and outbound port 25. New records usually show up within minutes but can take a few hours.

Once the `A` record resolves, Caddy gets the certificate within a minute or two. To give it to Stalwart right away instead of waiting for the nightly job, run:

```sh
sudo ./install.sh --refresh-certs
```

## 4. Test it

1. Open `https://mx.example.com` and sign in with your full address and password.
2. **Receiving:** send yourself a message from Gmail or another account.
3. **Sending:** go to [mail-tester.com](https://www.mail-tester.com), copy the address it shows, and send a normal-looking message to it from webmail: a real subject and a few sentences. Then click "check your score". Aim for 9/10 or better. The usual reasons for a lower score:
   - **Reverse DNS missing or wrong:** set the PTR record (see Requirements).
   - **SPF fails:** with a relay, the relay's `include:` is missing from SPF, or the relay hasn't verified your domain.
   - **DKIM missing:** the `_domainkey` records aren't published yet.
   - **Listed on a blocklist:** new or cheap IPs sometimes are. Request delisting at the link mail-tester gives you.
4. Send a message to a Gmail address and choose **Show original**. SPF, DKIM and DMARC should all say `PASS`.
5. **Mail apps:** most apps set themselves up from your address. If not, use:
   - IMAP: `mx.example.com`, port 993, SSL/TLS
   - SMTP: `mx.example.com`, port 465 with SSL/TLS, or port 587 with STARTTLS
   - Username: your full email address

A brand-new domain and IP have no sending reputation. Big providers may send your first messages to spam for a few days or weeks. Replies, and recipients marking you "not spam", fix that over time.

## 5. Administration

OpenMail's own admin console is at `https://mx.example.com/admin`: users (create, disable, reset password, storage limits), blocked IP addresses, new-account sending limits, the outgoing queue and users' own domains. Set `ADMINS=you` (usernames, comma-separated) for the account service, then sign in to the web app as one of them. Many accounts at once: **Users → Add accounts from a CSV file** (username, display name, password, storage in GB; empty passwords are generated and offered as a file to save, once).

Support staff who shouldn't have full control go in `HELPDESK=sam,raj` (`install.sh --helpdesk sam,raj`): they see users, reset passwords, switch sign-in on or off, lift sending suspensions, release or delete held mail and read the audit log, and nothing else (no creating or deleting accounts, storage limits, team mailboxes, blocked IPs, retention or new-account limits), and never on an admin's or another helpdesk account. The audit log notes which role made each change.

**Users' own domains.** Anyone with an account can add a domain they own in Settings → Your domain: they prove it with a TXT record, then add MX, SPF (`include:` your main domain), DKIM and DMARC records, which the page lists and checks live. The account service creates the domain in Stalwart (with its DKIM keys) and the user's address on it. The owner can offer addresses on it to other accounts on the server; each becomes theirs only when they accept the invitation (it waits `DOMAIN_INVITE_DAYS`, 14 by default). Defaults: 3 domains per account (`MAX_DOMAINS`), 10 addresses per domain (`MAX_DOMAIN_ADDRESSES`); `CUSTOM_DOMAINS=off` turns it off; `RESERVED_DOMAINS` refuses more domains besides your own. The admin console's Domains tab lists them with owner and status. The checks use the server's DNS resolver (`DNS_SERVERS=1.1.1.1` to pick one); if a domain's TXT record is gone for 7 days, its addresses pause until it's back. For your *own* extra domains, use Stalwart's admin as before.

**Outgoing spam is held for review.** Every message your users send passes a spam check first (Stalwart's spam filter, called by the account service). Likely spam isn't sent: the sender sees "This message looks like spam, so it is held for review", and it waits under **Held mail** in the console, where you send it on or delete it. When one person has 3 messages waiting, their sending is paused (they can still read mail) until you click **Let them send** on the Users tab. `install.sh` sets this up (an MTA hook to the account service, secret in `.hold.env`, held mail in `signup-data/held/`, included in backups). While the account service is down, sending waits and mail apps retry. Tuning (`HOLD_SCORE`, `HOLD_SUSPEND_AFTER`) and how it works: [signup/README.md](../signup/README.md#outgoing-spam-held-for-review).

**Spam complaints.** Join the big providers' feedback loops (Yahoo CFL, Microsoft JMRP) with `abuse@` your domain as the address. The account service reads that team mailbox every 5 minutes (and puts everyone in `ADMINS` in it). A complaint counts only if the report passes DKIM/DMARC for its sender (or comes from an IP in `ARF_REPORTERS`) and the reported message carries your DKIM signature or Message-ID, so forged reports don't count. 5 complaints about one account in 24 hours (`ARF_LIMIT`, `ARF_WINDOW_HOURS`) suspend its sending, listed under **Suspended & inactive**; only an admin can lift it. Once you've joined the loops, set `ARF_REPORTERS=yahoo.com,…` (their report domains) in `.env`. Details: [signup/README.md](../signup/README.md#spam-complaints-arf-reports).

**Inactive accounts.** When you disable an account the inactive list shows as due, mail to it is refused too (`550 5.2.1 This mailbox is inactive`); enabling it again accepts mail again. [docs/legal/inactive-accounts.md](legal/inactive-accounts.md) has the policy.

Stalwart's full admin interface is at `https://mx.example.com/admin/` (note the slash at the end). Sign in with the details in `.admin-credentials`. From there you can manage everything else: settings, spam filter, logs.

Logs:

```sh
cd deploy/production
docker compose logs -f stalwart     # mail
docker compose logs -f caddy        # HTTPS / certificates
```

### Single sign-on (Google Workspace, Microsoft Entra ID, Okta, Keycloak)

```sh
sudo ./install.sh --oidc-issuer https://accounts.google.com --oidc-client-id <id> --oidc-secret <secret>
```

Register a **web application** client at your provider with the redirect URI `https://mx.example.com/api/sso/callback`.
For Google, set the consent screen to **Internal** (only your Workspace users) and pass `--oidc-tenant yourcompany.com`
(checked against the token's `hd`). For Microsoft, use your tenant's issuer
(`https://login.microsoftonline.com/<tenant-id>/v2.0`), pass `--oidc-tenant <tenant-id>` (checked against `tid`), and
add the optional ID-token claims `email` and `xms_edov`: an address counts only when the provider vouches for it
(`email_verified`, or `xms_edov` for Entra). `preferred_username` is never used for Microsoft (users can change it in
some tenants). At every provider, leave implicit / ID-token grants **off** for this client: then only the account service
(which holds the secret) can obtain tokens Stalwart accepts. The account service also refuses names in `ADMINS`,
reserved names and retired names, so with SSO on the OpenMail console (`/admin`) can't be used; manage the server
in Stalwart's admin with the recovery admin login.

What happens: Stalwart's OIDC directory (open-source edition) checks the provider's signed ID tokens and creates a
mailbox the first time someone signs in; existing mailboxes with the same address keep their mail. Only addresses in
your own mail domains get in. The account service (`signup/sso.mjs`) runs the sign-in and keeps the session in an
HttpOnly cookie. Know before you switch it on:

- **It's server-wide.** Nobody signs in with a Stalwart password any more, and mail apps (IMAP/SMTP) can't be used:
  external-directory accounts can't have app passwords. A directory per domain is Stalwart Enterprise.
- Your old admin password stops working too. The installer switches `.admin-credentials` to Stalwart's recovery admin
  (a random secret in `.env`, `RECOVERY_ADMIN`) and keeps the old file as `.admin-credentials.before-sso`.
- Public sign-up and the noreply system sender are off (they need passwords). In the console, "Create account"
  pre-creates a mailbox without a password; "Reset password" is off (the provider owns passwords).
- To switch it off: in Stalwart's admin, set Authentication → Directory back to Internal and reload settings.

### Retention and legal hold

The OpenMail console (`/admin` → Retention) has:

- **Trash and Junk**: emptied by Stalwart after 30 days by default (`x:DataRetention.expungeTrashAfter`). Change it
  here; 0 = never. People can pick a shorter time in their own Settings.
- **Delete old mail**: "delete mail older than N years", for every account or per account (0 = keep forever).
  Before a rule is saved you see how many messages it would delete. The account service runs it every night and logs
  what it removed. Rules are kept in `signup-data/retention.json`.
- **Legal hold** per account: Stalwart's permissions to destroy mail, folders, IMAP EXPUNGE and POP3 DELE are taken
  away, the nightly job skips the account, and neither its owner nor an admin can delete it. Limit: Stalwart's own
  Trash/Junk auto-empty is server-wide and still runs; set Trash and Junk to 0 while a hold lasts.
  "Keep mail at least N years" for everyone can't be enforced short of a hold (Stalwart can't time-gate a delete), and
  undelete/archiving is Stalwart Enterprise.

## 6. Upgrades

Back up first (see below). Then:

```sh
cd openmail && git pull
cd deploy/production && sudo ./install.sh --yes --rebuild-web
```

This rebuilds the web client and re-registers the webmail's sign-in permissions (encryption in Settings → Security needs the `settings` permission, added in this version). If `git pull` brought a new Stalwart or Caddy version, it also pulls the new image and restarts. Image versions are pinned in `docker-compose.yml`, so nothing changes under you without a `git pull`. Before moving to a new major Stalwart version, read its [upgrade notes](https://stalw.art/docs/install/upgrade/).

## 7. Backups

`backup.sh` makes an encrypted copy of everything needed to rebuild the server: all mail, contacts, calendars, filters, accounts and settings, the DKIM keys, the account service's data (`signup-data/`: held mail, retention rules, audit log, file links) and the files `install.sh` generated next to it (`.env`, the admin login in `.admin-credentials`, `.system-mail.env`, `.hold.env`, `webmail.caddy`, `.metrics-password`).

Backups are encrypted with [age](https://age-encryption.org) to a key that lives on your own computer, not on the server. A stolen server or backup bucket can't read them.

**One-time setup:**

1. On your computer, create the key pair. Install age with `brew install age` on macOS or `apt install age` on Linux, then run:

   ```sh
   age-keygen -o openmail-backup.key
   ```

   Keep `openmail-backup.key` safe, for example in your password manager. Without it, the backups can't be restored. The command prints a public key starting with `age1…`.

2. On the server, save that public key:

   ```sh
   sudo apt install age
   cd deploy/production
   sudo ./backup.sh --recipient age1...
   ```

3. Schedule a nightly backup:

   ```sh
   # ./backup.sh --recipient already did this when run as root; by hand:
   echo "30 3 * * * root $PWD/backup.sh >> /var/log/openmail-backup.log 2>&1" | sudo tee /etc/cron.d/openmail-backup
   ```

**Making a backup:** run `sudo ./backup.sh`. It writes `backups/openmail-<date>.tar.gz.age` and keeps the newest 14. Stalwart's database can't be copied while it runs, so Stalwart pauses for a few seconds while the copy is made. Other servers retry delivery, so no mail is lost.

**Keep copies somewhere else.** A backup on the same disk doesn't survive losing the server. For example:

```sh
# from your computer
rsync -av root@mx.example.com:openmail/deploy/production/backups/ ~/mail-backups/
# or from the server, to any storage that rclone supports
rclone copy backups/ remote:mail-backups/
```

**Restoring,** on the same server or a new one (install Docker and `age` first on a new one: `sudo apt install age`):

```sh
git clone https://github.com/<you>/openmail.git && cd openmail/deploy/production
# copy the backup file and your openmail-backup.key to the server, then:
sudo ./backup.sh --restore openmail-20260101-033000.tar.gz.age --identity openmail-backup.key   # asks you to type yes
sudo ./install.sh --yes --ip <this server's IP>     # builds webmail, starts everything, re-checks settings
```

The restore replaces whatever is on the server (an install you made there first included); the files it overwrites are kept as `*.before-restore`. A clone in a different directory than the old server's is fine: `install.sh` then builds the web client in the new checkout. A test install (`--local-test`) is remembered as one in `.env`, so the second command needs no extra flag there either.

On a new server, also update the `A` record, the reverse DNS, and the IP in SPF if you added one. Then delete the key file from the server. Passwords, the webmail sign-in, app passwords and DKIM keys are the same as before, so mail apps and DNS (apart from the IP) need no changes.

**Tested:** a test install (`install.sh --local-test`) got messages in two folders, a contact, a calendar event, a filter, a masked address and mail sent over SMTP; then `backup.sh`, `docker compose down -v`, every generated file and `signup-data/` deleted, and the two commands above. Every message (with its body), the folder, contact, event, filter, masked address and the owner's password came back, the account service stayed healthy, and new mail was delivered both ways. A backup takes a few seconds for a small server (Stalwart is stopped for about two of them); restore plus `install.sh` took 15 seconds. CI repeats this drill on every push (`.github/workflows/ci.yml`, job `installer`).

## 8. Monitoring (optional)

Prometheus watches the server, Alertmanager emails you when something is wrong, and Grafana shows it all on one dashboard. Turn it on (safe to re-run; the setting is remembered):

```sh
cd deploy/production
sudo ./install.sh --yes --monitoring --alert-email you@gmail.com
```

Use an alert address at **another provider**: if this server breaks, its own mailboxes break with it. Without `--alert-email`, alerts go to the `--email` address you gave for certificates. Alerts are sent through this server's Stalwart as `noreply@example.com`, so a dead Stalwart can't email you about itself. To get that alert on your phone too, uncomment the ntfy or Slack example in `monitoring/alertmanager.yml` and run `docker compose up -d alertmanager`.

The web pages listen only on the server itself. Open them from your computer through an SSH tunnel:

```sh
ssh -L 3000:127.0.0.1:3000 -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 root@mx.example.com
```

Then browse to <http://localhost:3000> (Grafana, dashboard "OpenMail: mail"; first login `admin`/`admin`, then it asks for a new password), <http://localhost:9090/alerts> (Prometheus) or <http://localhost:9093> (Alertmanager, to silence an alert during maintenance).

What each alert means and what to do:

| Alert | Means | Do |
|---|---|---|
| StalwartDown | No answer from Stalwart for 2 minutes. | `docker compose ps` and `docker compose logs --tail 100 stalwart`; `docker compose up -d`. Check free disk and memory. |
| QueueOldMessage | A message has waited over 30 minutes to go out. | Admin UI › Queues › Messages: read the error on that message (see Troubleshooting). |
| QueueGrowing | The outgoing queue grew for 5 minutes straight (over 20 messages). | Same as above. If one account is sending a lot, it may be compromised: disable it. |
| QueueBackPressure | Stalwart is turning new mail away because the queue is full. | Find what is stuck (above); free disk space if that is the cause. |
| DeliveryFailureRatioHigh | Over 5% of deliveries failed for 15 minutes. | Look for a pattern in the queue errors: blocked port 25, a blocklist listing ([MXToolbox](https://mxtoolbox.com/blacklists.aspx)), a broken relay login. |
| DestinationDeferring | 5+ recipients at one domain (shown in the alert) keep failing for 15 minutes. | That provider is rejecting or rate-limiting you. Read its error in the queue; check its postmaster pages (Gmail Postmaster Tools, Microsoft SNDS). |
| AuthFailureSpike | Over 200 failed sign-ins in 10 minutes. | Usually password-guessing bots; Stalwart bans IPs after 100 failures. If it's one of your users with an old password, tell them. Raise the threshold in `monitoring/alerts.yml` if your normal level is higher. |
| DiskAlmostFull | A disk is over 85% full. | `docker system prune` removes old images; `du -sh backups/` (old backups); add disk. Stalwart stops accepting mail when the disk is full. |
| MonitoringTargetDown | The queue or disk exporter is down, so those alerts can't fire. | `docker compose logs queue-exporter node-exporter`. |

Stalwart 1.0.3 doesn't count deliveries per destination, so the per-destination alert counts recipients stuck in the queue rather than a failure ratio. Data is kept for 30 days. To turn monitoring off: `docker compose rm -sf prometheus alertmanager grafana node-exporter queue-exporter`, then delete the `MONITORING`, `COMPOSE_FILE` and `ALERT_EMAIL` lines from `.env`.

## 9. Hosted mode (PostgreSQL)

For a public instance that will grow past one server, install with `--hosted`:

```sh
sudo ./install.sh --hosted --domain example.com --hostname mx.example.com --email you@gmail.com --user you
```

The same stack, but Stalwart keeps its data in PostgreSQL, message bodies and attachments in an S3 bucket (SeaweedFS on the same server), and rate-limit counters and locks in Valkey, instead of RocksDB on the local disk. More Stalwart servers can later point at the same three services ([scale.md](research/scale.md) §11, and `deploy/scale/` for a working two-server example). The extra services are in `deploy/production/hosted/`.

- **Decide at the first install.** There is no way to move an existing RocksDB server to PostgreSQL, and `--hosted` refuses to run on one. Self-hosters don't need it: leave it off.
- **Passwords** for PostgreSQL and S3 are generated into `.env` (readable by root only). The admin login is in `.admin-credentials` as usual (user `admin@example.com`).
- **Backups:** the same `backup.sh` commands. In hosted mode a backup holds a `pg_dump` of the database and a copy of the S3 bucket, taken while mail keeps flowing (no pause). Restore works the same way (it waits for PostgreSQL and the S3 store to start, so it takes a minute). Tested: a hosted test install (`install.sh --local-test --hosted`) got the same data as the simple-mode drill above plus a 200 KB attachment (stored in the bucket, with only metadata in PostgreSQL and nothing in RocksDB); it was backed up, all its Docker volumes, generated files and `signup-data/` deleted, and restored with the two commands above. Everything came back (attachment byte for byte, same DKIM keys, same passwords), and new mail went both ways afterwards.
- **Not done yet:** nightly dumps lose up to a day of mail if the disk dies. Before real users, add PostgreSQL WAL archiving (pgBackRest or WAL-G to off-site object storage) for point-in-time recovery, and move PostgreSQL, S3 and Valkey to replicated or managed services when adding servers.

## 10. Troubleshooting

**Webmail doesn't load, or shows a certificate error.** Check that `dig +short mx.example.com` returns your IP and that ports 80 and 443 are open in the cloud firewall. Then look in `docker compose logs caddy` for ACME errors. Let's Encrypt limits retries, so fix DNS before restarting repeatedly.

**Mail apps warn about a self-signed or invalid certificate.** Stalwart doesn't have Caddy's certificate yet. Run `sudo ./install.sh --refresh-certs`.

**Mail to Gmail or Outlook never arrives.** In the admin UI, check the queue under Queues › Messages.

- `connection timed out` to port 25 means outbound port 25 is blocked: re-run the installer with `--relay`.
- Relay authentication errors mean the relay username or password is wrong: re-run with the correct `--relay-user` and `--relay-password`.

**Mail goes to spam.** In this order:

1. Run `./check-dns.sh`.
2. Check reverse DNS.
3. Get a mail-tester.com score.
4. Check the IP at [MXToolbox](https://mxtoolbox.com/blacklists.aspx).
5. Give a new domain time.

**Admin sign-in says "Client metadata documents are disabled".** The public URL Stalwart expects doesn't match the address in your browser. Always use `https://mx.example.com/admin/`, not the IP address.

**Lost the admin password** (`.admin-credentials` deleted). Start Stalwart in recovery mode on a local-only port, reset the password, then restart normally:

```sh
cd deploy/production
sudo docker compose stop stalwart
sudo docker compose run -d --rm --name stalwart-recovery -p 127.0.0.1:8081:8080 \
  -e STALWART_RECOVERY_MODE=1 -e STALWART_RECOVERY_ADMIN=recovery:temporary-pass-123 stalwart
sleep 30
NEW=$(openssl rand -base64 18)
ID=$(curl -s -u recovery:temporary-pass-123 http://127.0.0.1:8081/jmap/ -H 'Content-Type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Account/query",{"filter":{"name":"admin"}},"q"]]}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["methodResponses"][0][1]["ids"][0])')
curl -s -u recovery:temporary-pass-123 http://127.0.0.1:8081/jmap/ -H 'Content-Type: application/json' \
  -d '{"using":["urn:ietf:params:jmap:core","urn:stalwart:jmap"],"methodCalls":[["x:Account/set",{"update":{"'"$ID"'":{"credentials":{"0":{"@type":"Password","secret":"'"$NEW"'"}}}}},"u"]]}'
sudo docker rm -f stalwart-recovery
sudo docker compose start stalwart
(umask 077; echo "admin@example.com:$NEW" | sudo tee .admin-credentials >/dev/null)
```

**Oracle Cloud: nothing connects even though the Security List is open.** Oracle's Ubuntu images also block ports with their own `iptables` rules. Docker's published ports normally get around these. If they don't, run:

```sh
sudo iptables -I INPUT -p tcp -m multiport --dports 25,80,443,465,587,993 -j ACCEPT
sudo netfilter-persistent save
```

**Start over completely** (this deletes all mail):

```sh
sudo docker compose down -v
sudo rm -rf .env .admin-credentials .system-mail.env .hold.env .metrics-password webmail.caddy dns-records.tsv signup-data
```

Remove all of them: with a leftover `.system-mail.env`, the next install skips creating the `noreply@` system sender on the new, empty Stalwart, and sign-up codes can't be sent.
