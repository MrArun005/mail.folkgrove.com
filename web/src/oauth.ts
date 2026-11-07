// Sign-in with OAuth 2.1 (authorization code + PKCE) against the mail server, from our own branded form: the
// form posts the password (and two-factor code) to the server's sign-in API on this same origin, the server
// answers with an authorization code, and we exchange it for tokens. The password is never stored.
//
// Storage: the access token lives only in memory. The refresh token is kept in sessionStorage so a reload doesn't
// sign you out; closing the tab does. ponytail: a stolen refresh token works until it's used once (rotation) or
// revoked at sign-out; a backend-held httpOnly cookie would remove that window if we ever add a backend.

export const CLIENT_ID = 'openmail-web';
const SCOPE = 'openid offline_access urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts urn:ietf:params:oauth:scope:calendars';
const KEY = 'om:oauth';
const redirectUri = () => `${location.origin}/`;

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

const store = {
  get<T>(k: string): T | null { try { return JSON.parse(sessionStorage.getItem(`${KEY}:${k}`) ?? 'null'); } catch { return null; } },
  set(k: string, v: unknown) { try { v == null ? sessionStorage.removeItem(`${KEY}:${k}`) : sessionStorage.setItem(`${KEY}:${k}`, JSON.stringify(v)); } catch {} },
};

/** The server's answer to a sign-in attempt; 'code' means a second step (two-factor code) is needed. */
export type SignInStep = { tokens: Tokens } | 'code';

/**
 * Sign in through the server's sign-in API (what its own sign-in page calls). Signing in to this app is the
 * consent for this app, so the server's consent step is answered yes.
 */
async function authorize(user: string, pass: string, scope: string, otp?: string): Promise<Tokens | 'code'> {
  const verifier = random(48), state = random(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const query = new URLSearchParams({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(), scope,
    code_challenge: challenge, code_challenge_method: 'S256', state }).toString();
  const post = async (body: object) => {
    const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`The mail server couldn’t sign you in right now (${r.status}). Try again in a moment.`);
    return r.json() as Promise<{ type: string; location?: string; token?: string }>;
  };
  let r = await post({ type: 'authCode', accountName: user, accountSecret: pass, query, ...(otp && { mfaToken: otp.replace(/\s/g, '') }) });
  if (r.type === 'consentRequired' && r.token) r = await post({ type: 'authConsent', token: r.token, query, consent: true });
  if (r.type === 'mfaRequired') return 'code';
  if (r.type === 'failure') throw new Error(otp ? 'That code didn’t work. Check your authenticator app and try the newest code.' : 'Wrong email or password.');
  if (r.type === 'expired') throw new Error('Your password has expired. Ask your administrator to reset it.');
  if (!r.location) throw new Error('The mail server sent an answer this app doesn’t understand.');
  const back = new URL(r.location, location.origin).searchParams;
  if (back.get('error')) throw new Error(back.get('error_description') || 'Sign-in was refused.');
  if (back.get('state') !== state || !back.get('code')) throw new Error('That sign-in didn’t match. Please try again.');
  return tokenRequest({ grant_type: 'authorization_code', code: back.get('code')!, redirect_uri: redirectUri(), code_verifier: verifier });
}

/** Everyday sign-in: mail, contacts and calendars, remembered in this tab. */
export async function signIn(user: string, pass: string, otp?: string): Promise<Session | 'code'> {
  const t = await authorize(user, pass, SCOPE, otp);
  if (t === 'code') return t;
  store.set('refresh', { token: t.refresh, username: t.username });
  return new Session(t);
}

export interface Tokens { access: string; refresh: string; expiresAt: number; username: string }

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch('/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'invalid_grant') throw new Error('Your session has ended. Please sign in again.'); // expired, revoked or account gone
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `Sign-in failed (${res.status})`);
  return { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, username: j.username ?? '' };
}

/** Drop the remembered session (it can't be renewed). */
export const forgetSession = () => store.set('refresh', null);

/** A token source the JMAP client asks for headers; refreshes shortly before expiry or after a 401. */
export class Session {
  private refreshing: Promise<void> | null = null;
  constructor(private t: Tokens) {}

  static resume(): Session | null {
    const saved = store.get<{ token: string; username: string }>('refresh');
    return saved ? new Session({ access: '', refresh: saved.token, expiresAt: 0, username: saved.username }) : null;
  }

  async header(): Promise<string> {
    if (Date.now() > this.t.expiresAt - 60_000) await this.refresh();
    return `Bearer ${this.t.access}`;
  }

  refresh(): Promise<void> {
    // One refresh at a time: refresh tokens rotate, so a second parallel request would use a dead token.
    this.refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: this.t.refresh })
      .then((t) => { this.t = { ...t, username: t.username || this.t.username }; store.set('refresh', { token: t.refresh, username: this.t.username }); })
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async signOut() {
    store.set('refresh', null);
    await fetch('/auth/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CLIENT_ID, token: this.t.refresh, token_type_hint: 'refresh_token' }),
    }).catch(() => {});
  }
}

// ── Step-up: a fresh sign-in for security settings ──────
// Security changes (two-factor, app passwords, password) need a token with the security scope. The everyday
// session never gets it: a stolen mail token must not be able to mint permanent app passwords. Instead a small
// prompt asks for the password (and code) again; the resulting short-lived token lives only in memory.

// ponytail: app passwords inherit the creating token's permissions, so the step-up token also carries the mail scopes.
const SECURITY_SCOPE = 'openid urn:ietf:params:oauth:scope:mail urn:ietf:params:oauth:scope:contacts urn:ietf:params:oauth:scope:calendars urn:stalwart:oauth:scope:security';

/** Re-enter the password (and code) for a short-lived security token, kept only by the caller in memory. */
export async function stepUp(user: string, pass: string, otp?: string): Promise<string | 'code'> {
  const t = await authorize(user, pass, SECURITY_SCOPE, otp);
  return t === 'code' ? t : t.access;
}
