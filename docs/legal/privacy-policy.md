# Privacy policy

**Draft — have a lawyer review before public launch.**

Last updated: [date]. [Operator name] ("we") runs the OpenMail service at [domain]. This explains what we store, why, where and for how long. It describes what the software actually does; if the two ever differ, tell us at [privacy contact] and we'll fix one or the other.

## What we store

| What | Why | How long |
|---|---|---|
| Your mail, contacts, calendars, notes, tasks and settings (filters, signatures, out-of-office, Screener list) | It's the service | Until you delete it or your account |
| Your username, password (stored hashed by the mail server), two-factor secret and app passwords | Signing in | Until you change them or delete your account |
| The email address you verified at sign-up, the time you signed up and the invite code you used | Proving you're a real person; contacting you about your account | With your account |
| Masked addresses you create | They deliver to you | With your account; a deleted masked address stays switched off on your account so it is never reused |
| Server logs (see below) | Keeping the service running and stopping abuse | [Until the log is rotated: set a retention, e.g. 30 days] |
| Encrypted backups of all of the above | Recovering from failures | The newest [14] backups are kept; older ones are deleted |
| Usernames and masked addresses of deleted accounts | So nobody can take over an old address and receive its password resets | Forever (just the name, nothing else) |

We don't collect anything else. There are no ads, no analytics, no tracking pixels and no third-party scripts in the web app. Fonts are served from our own server.

## What we don't do

- **No one reads your mail.** There is no content scanning for advertising, profiling or AI training. The only automated processing is spam and malware filtering of mail as it passes through the server (incoming and outgoing), your own filters and the Screener, and sorting newsletters into Updates if you leave that on.
- **AI stays on your device.** Translation, summaries and suggested replies use your browser's built-in models. The message never leaves your computer for them. Where the browser doesn't have those models, the features don't appear.
- **We don't sell or share your data**, except as described under "Who else sees data".
- **Remote images are blocked** until you choose to load them, so senders can't tell when you open a message.

## Server logs

The mail server (Stalwart) writes operational events to its log. At the level we run it, that includes:

- connections to the server, with the connecting IP address;
- sign-ins, successful and failed, with the account name and IP address;
- for each message received or sent: sender and recipient addresses, size, the servers involved and whether delivery succeeded.

Logs do not contain subject lines, message bodies or attachments. [Operator: confirm this against a sample of your own server's log before launch, and set log rotation.] The account service (sign-up, masked addresses, account deletion) logs errors and the address of each deleted account. The web server keeps no access log. Rate limits on sign-up and sign-in count attempts per IP address (IPv6: per /64) in memory only, for at most an hour.

## Where your data is

All of it is on servers we run at [hosting provider, country/region]. It doesn't leave them except:

- when you send mail (it goes to the recipients' mail servers, as email always does);
- if outgoing mail is sent through a relay ([relay provider], which then sees the same delivery details as any mail server);
- encrypted backups at [backup location], which only we can decrypt;
- if you turn on desktop notifications, your browser maker's push service (Google, Mozilla or Apple) relays an encrypted "something changed" signal to your browser.

## Your browser

Signing in keeps a short-lived token in the tab's memory and session storage. "Keep me signed in" stores a sign-in token in a secure cookie the page's scripts can't read, for up to 30 days after last use. Display preferences (theme, text size) are stored on your device only.

## Your rights

You can, at any time and without asking us:

- **get a copy of everything**: Settings → Export your data (all mail as .mbox, contacts as .vcf, calendar as .ics, settings as .json);
- **correct** your name, signatures and settings in Settings;
- **delete your account**: Settings → Delete your account. Your mail, contacts, calendars and settings are erased from the live server immediately; backup copies are gone once those backups are replaced (within [14] days). Only your address is kept, on the retired list, so nobody else can ever use it.

You can also contact us at [privacy contact] for anything else, including objecting to processing or asking what we hold about you. If you're in the EU/UK you can complain to your data protection authority. [Name the legal basis per purpose: contract for the service; legitimate interests for logs, spam filtering and abuse prevention.]

## Who else sees data

- The people you email, and their mail providers.
- Our hosting, relay and backup providers, only as needed to run the service ([list]).
- Authorities, only with valid legal process. See our [law enforcement guidelines](law-enforcement.md). Mail isn't end-to-end encrypted, so we can technically access stored mail; we only do so when the law compels us, and we tell you unless we're legally prohibited.

## Changes

We'll email you before any change that affects how your data is used.
