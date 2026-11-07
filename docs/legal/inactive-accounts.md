# Inactive accounts

**Draft — have a lawyer review before public launch.**

Last updated: [date]. An account nobody uses still receives mail and still holds personal data. This is what we do with accounts that have gone quiet, and what we never do.

## The policy

1. **An account is inactive** after 12 months with no sign-in (web, mail app, phone or calendar sync all count). We count sign-ins from the day this policy took effect, so no account is inactive before 12 months after that day.
2. **Reminders.** We email the account itself and the address verified at sign-up 60 days, 30 days and 7 days before the 12 months are up. Signing in once, anywhere, resets the clock.
3. **Blocking.** After 12 months, the account is put on a list for our staff, who block it: signing in and sending are switched off. Nothing is deleted at this point. [Refusing new mail to a blocked account, so senders learn the address no longer works, is not in place yet; until it is, mail to it keeps arriving and is kept.]
4. **Getting it back.** For [90 days] after blocking, you can ask [support contact] to unblock it. You'll need to prove it's yours (for example with a code sent to your verified address).
5. **Deletion.** After that, the account's mail, contacts, calendars and settings are deleted, the same as if you had chosen Settings → Delete your account.

## Never recycled

The address is **never** given to anyone else, not after blocking and not after deletion. Masked addresses are retired the same way. A recycled address would receive the previous owner's password resets, bank letters and private mail.

## Exceptions

Accounts with [a paid plan / legal hold] are not blocked while that lasts.

## Status

What the software does by itself today:

- **Sign-ins are recorded** per account (the mail server reports each successful sign-in to the account service).
- **Reminders** go out automatically by email, 60, 30 and 7 days before the 12 months are up, to the account and to the address verified at sign-up. Each is sent once; signing in resets everything.
- **After 12 months** the account appears as "due for blocking" in the admin console.

What people do: an administrator blocks a due account (one click in the admin console), handles requests to unblock, and deletes accounts after the [90 days]. Nothing is blocked or deleted automatically. Account deletion and permanent retirement of addresses work today.
