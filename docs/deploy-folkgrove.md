# Going live: folkgrove.com on Oracle Cloud

Everything to do on deploy day, in order. About 30 minutes of clicking and one command. Steps 1–3 don't need the
server and can be done any time before.

What you end up with: mail for `@folkgrove.com` on your own server, webmail at `https://mail.folkgrove.com`, outgoing
mail through Brevo (Oracle blocks port 25), backups, and monitoring.

## 1. Brevo (outgoing mail), ~10 min

1. Sign up at [brevo.com](https://www.brevo.com) (free: 300 mails a day).
2. **Senders, Domains & Dedicated IPs → Domains → Add a domain**: `folkgrove.com`. Brevo shows a few DNS records
   (a `brevo-code` TXT and DKIM records). Add them at your DNS host now (step 3), then press **Verify** in Brevo.
3. **SMTP & API → SMTP**: note the **login** (looks like `1234abc@smtp-brevo.com`) and create an **SMTP key**
   (starts with `xsmtpsib-`). These are `--relay-user` and `--relay-password` below.

## 2. Oracle Cloud (the server), ~10 min

1. **Compute → Instances → Create instance.**
   - Image: **Ubuntu 24.04** (Canonical).
   - Shape: **Ampere A1** (Always Free, ARM): 2 OCPU and 12 GB memory is plenty. If Ampere has no capacity in your
     region, VM.Standard.E2.1.Micro (1 GB) works too: the installer adds swap.
   - Add your SSH public key. Create.
2. **Reserve the IP** so it never changes: Instance → Attached VNICs → the VNIC → IPv4 addresses → edit the public
   IP → **Reserved public IP**. Note it (called `IP` below).
3. **Open the ports**: Networking → Virtual cloud networks → your VCN → the subnet → its **Security List** → Add
   ingress rules, source `0.0.0.0/0`, TCP, one per port: **25, 80, 443, 465, 587, 993**. (The installer also opens them
   in the server's own firewall, which Oracle's Ubuntu image closes by default.)
4. Optional, later: reverse DNS (PTR) for `IP` → `mx.folkgrove.com` through an Oracle support request. With Brevo
   sending your mail it isn't required (Brevo's servers are the ones Gmail sees).

## 3. DNS at your registrar, ~5 min now + the rest after install

Before installing, add just these two, so the HTTPS certificate can be issued:

| Type | Name | Value |
|---|---|---|
| A | `mx.folkgrove.com` | `IP` |
| CNAME | `mail.folkgrove.com` | `mx.folkgrove.com` |

Plus Brevo's records from step 1. **Don't** change the MX yet: mail keeps going where it goes today until step 5.

## 4. Install (one command), ~5 min

```sh
ssh ubuntu@IP
sudo apt-get update && sudo apt-get install -y git
git clone https://github.com/MrArun005/mail.folkgrove.com.git openmail && cd openmail/deploy/production
sudo ./install.sh --yes --domain folkgrove.com --hostname mx.folkgrove.com --webmail-host mail.folkgrove.com \
  --email YOU@gmail.com --user arun \
  --relay smtp-relay.brevo.com:587 --relay-user 'LOGIN@smtp-brevo.com' --relay-password 'xsmtpsib-...' \
  --monitoring
```

It installs Docker, opens the firewall, builds the web app, starts everything, creates `arun@folkgrove.com` (prints its
password once: save it), the `abuse@`/`postmaster@` team mailbox, and prints the DNS records for step 5.

Then, as root, in `deploy/production`:

- `.admin-credentials`: the server admin login. Put it in your password manager.
- Backups: on your own computer make a key pair (`age-keygen -o openmail-backup.key`, keep that file safe and off the
  server), then on the server `sudo ./backup.sh --recipient age1...` (the public key it printed). That also schedules a
  nightly backup at 03:30. Copy `backups/` somewhere else now and then (docs/self-hosting.md §7).
- The OpenMail admin console is at `https://mail.folkgrove.com/admin`; `arun` is its admin (the first mailbox).
  More admins: `sudo ./install.sh --yes --admins arun,priya`.

## 5. The rest of DNS, ~5 min

Add every record the installer printed (run `sudo ./install.sh --dns` to see them again): MX, SPF (it already includes
Brevo), DKIM, DMARC, MTA-STS, TLS-RPT, autoconfig/SRV. Changing the **MX** is the moment mail starts arriving here.

Check it: `./check-dns.sh` (each record PASS/FAIL; new records can take a while to show).

## 6. Test, ~5 min

1. Open `https://mail.folkgrove.com`, sign in as `arun@folkgrove.com`.
2. Send a mail to your Gmail; reply to it. Both should arrive (check Gmail's Spam the first time).
3. Send one to the address [mail-tester.com](https://www.mail-tester.com) gives you: aim for 9/10 or better.
4. Turn on notifications (Settings → Notifications) on your phone and laptop: push needs this HTTPS address.

## Before opening sign-up to the public

Sign-up stays off (`SIGNUP=off`) until these are done (PLAN.md, Gate 1): deliverability proven for a couple of weeks,
the legal pages filled in (`docs/legal/`, placeholders in brackets) and reviewed, and `ARF_REPORTERS` set once you've
joined the Yahoo and Microsoft feedback loops.

## If something goes wrong

- `cd ~/openmail/deploy/production && sudo docker compose ps` (all should be Up/healthy) and
  `sudo docker compose logs --tail 100 stalwart` (or `caddy`, `signup`).
- Certificate not issued: the A record for `mx.folkgrove.com` isn't live yet, or port 80 isn't open (Security List).
- Mail not arriving: MX not changed yet, or port 25 not open in the Security List.
- More in docs/self-hosting.md §10 (Troubleshooting).
