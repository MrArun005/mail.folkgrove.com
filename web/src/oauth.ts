// Sign-in with OAuth 2.1 (authorization code + PKCE) against the mail server, from our own branded form: the
// form posts the password (and two-factor code) to the server's sign-in API on this same origin, the server
// answers with an authorization code, and we exchange it for tokens. The password is never stored.
//
// Storage: the access token lives only in memory. The refresh token is kept in sessionStorage so a reload doesn't
// sign you out; closing the tab does. ponytail: a stolen refresh token works until it's used once (rotation) or
// revoked at sign-out; a backend-held httpOnly cookie would remove that window if we ever add a backend.

import { locale, serverText, t } from './i18n';

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
    const r = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .catch(async (e) => { throw new Error((await blockedNetwork()) ?? (e as Error).message); });
    if (!r.ok) throw new Error((await blockedNetwork()) ?? t('oauth.cantSignIn', { status: r.status }));
    return r.json() as Promise<{ type: string; location?: string; token?: string }>;
  };
  let r = await post({ type: 'authCode', accountName: user, accountSecret: pass, query, ...(otp && { mfaToken: otp.replace(/\s/g, '') }) });
  if (r.type === 'consentRequired' && r.token) r = await post({ type: 'authConsent', token: r.token, query, consent: true });
  if (r.type === 'mfaRequired') return 'code';
  if (r.type === 'failure') throw new Error((await blockedNetwork()) ?? (otp ? t('oauth.badCode') : t('oauth.wrongPassword')));
  if (r.type === 'expired') throw new Error(t('oauth.passwordExpired'));
  if (!r.location) throw new Error(t('oauth.badAnswer'));
  const back = new URL(r.location, location.origin).searchParams;
  if (back.get('error')) throw new Error(back.get('error_description') || t('oauth.refused'));
  if (back.get('state') !== state || !back.get('code')) throw new Error(t('oauth.mismatch'));
  return tokenRequest({ grant_type: 'authorization_code', code: back.get('code')!, redirect_uri: redirectUri(), code_verifier: verifier });
}

/**
 * After a failed sign-in: is this network blocked for too many failed sign-ins? (The mail server answers a blocked
 * address like a wrong password; the account service can tell, signup/abuse.mjs.) A message saying so, or null.
 */
async function blockedNetwork(): Promise<string | null> {
  const j = await fetch('/api/blocked').then((r) => (r.ok ? r.json() : null), () => null).catch(() => null);
  if (!j?.blocked) return null;
  const until = j.until ? new Date(j.until).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' }) : '';
  return until ? t('oauth.blockedUntil', { time: until }) : t('oauth.blocked');
}

/** Everyday sign-in: mail, contacts and calendars, remembered in this tab. */
export async function signIn(user: string, pass: string, otp?: string): Promise<Session | 'code'> {
  const tok = await authorize(user, pass, SCOPE, otp);
  if (tok === 'code') return tok;
  const s = new Session({ ...tok, username: tok.username || user.toLowerCase() });
  s.remember();
  return s;
}

export interface Tokens { access: string; refresh: string; expiresAt: number; username: string }

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch('/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const j = await res.json().catch(() => ({}));
  if (j.error === 'invalid_grant') throw new Error(t('oauth.sessionEnded')); // expired, revoked or account gone
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || t('oauth.failed', { status: res.status }));
  return { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, username: j.username ?? '' };
}

// Several accounts can be signed in at once (Gmail-style switcher). Two kinds:
//  - this tab only: refresh token in sessionStorage; closing the tab signs out.
//  - "Keep me signed in": the refresh token is in an HttpOnly cookie held by the account service (signup/session.mjs);
//    page scripts never see it. This device only remembers the username (localStorage) and asks for access tokens.
type Saved = Record<string, string>; // username → refresh token (this tab)
const saved = (): Saved => {
  const old = store.get<{ token: string; username: string }>('refresh'); // single-account format, before switching existed
  if (old) { store.set('refresh', null); store.set('accounts', { [old.username]: old.token }); store.set('active', old.username); }
  return store.get<Saved>('accounts') ?? {};
};
const device = {
  get: (): string[] => { try { return JSON.parse(localStorage.getItem('om:remembered') ?? '[]'); } catch { return []; } },
  set: (l: string[]) => { try { localStorage.setItem('om:remembered', JSON.stringify([...new Set(l)])); } catch { /* private mode */ } },
  active: (u?: string | null) => { try { if (u === undefined) return localStorage.getItem('om:active'); if (u) localStorage.setItem('om:active', u); else localStorage.removeItem('om:active'); } catch { /* fine */ } return null; },
};
const sessionApi = (path: string, body: object) => fetch(`/api/session/${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenMail': '1' }, body: JSON.stringify(body), credentials: 'same-origin',
});

/** True when this server runs the account service, so "Keep me signed in" can work. */
export async function canRememberDevice(): Promise<boolean> {
  const r = await fetch('/api/session/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-OpenMail': '1' }, body: '{}' }).catch(() => null);
  return !!r && (r.status === 400 || r.status === 401); // it answered: present (404/502: not running)
}

// ── Single sign-on (signup/sso.mjs) ──────
// The account service runs the provider's sign-in and keeps its refresh token in the HttpOnly cookie, exactly like
// "Keep me signed in"; it sends the browser back to /?sso=<username>. This device then only remembers the name.

/** The provider's name when this server signs in through one ("Google", "Contoso"), else null. */
export async function ssoProvider(): Promise<string | null> {
  const r = await fetch('/api/sso').catch(() => null);
  return r?.ok ? ((await r.json()).name as string) ?? null : null;
}
/** Back from the provider: make that account the active, device-remembered one. */
export function adoptSso(username: string) {
  device.set([...device.get(), username]); device.active(username); store.set('active', username);
}
const SSO_ERRORS = {
  expired: 'oauth.ssoExpired', cancelled: 'oauth.ssoCancelled', refused: 'oauth.ssoRefused',
  no_account: 'oauth.ssoNoAccount', rate_limited: 'oauth.ssoRateLimited',
} as const;
export const ssoError = (code: string) => t(SSO_ERRORS[code as keyof typeof SSO_ERRORS] ?? 'oauth.ssoUnavailable');

/** Usernames signed in here (this tab and remembered on this device), active first. */
export function signedInAccounts(): string[] {
  const a = [...new Set([...Object.keys(saved()), ...device.get()])];
  const active = store.get<string>('active') ?? device.active();
  return active && a.includes(active) ? [active, ...a.filter((x) => x !== active)] : a;
}
/** Drop the active session (it can't be renewed). */
export const forgetSession = () => {
  const a = saved(), active = store.get<string>('active') ?? device.active();
  if (active) { delete a[active]; device.set(device.get().filter((x) => x !== active)); }
  store.set('accounts', a); store.set('active', null); device.active(null);
};

/** A token source the JMAP client asks for headers; refreshes shortly before expiry or after a 401. */
export class Session {
  private refreshing: Promise<void> | null = null;
  private signedOut = false;
  /** Remembered on this device: tokens come from the account service's HttpOnly cookie. */
  private cookie = false;
  constructor(private t: Tokens) {}

  /** The active account's session (or a given account's): this tab first, then remembered on this device. */
  static resume(username?: string): Session | null {
    const a = saved(), u = username ?? store.get<string>('active') ?? device.active() ?? Object.keys(a)[0] ?? device.get()[0];
    if (!u) return null;
    if (a[u]) { store.set('active', u); return new Session({ access: '', refresh: a[u], expiresAt: 0, username: u }); }
    if (!device.get().includes(u)) return null;
    const s = new Session({ access: '', refresh: '', expiresAt: 0, username: u });
    s.cookie = true; store.set('active', u); device.active(u);
    return s;
  }

  get username() { return this.t.username; }
  get remembered() { return this.cookie; }
  /** Make this account the active one (and keep its tab-only token, if that's its kind). */
  remember() {
    if (this.cookie) { store.set('active', this.t.username); device.active(this.t.username); return; }
    store.set('accounts', { ...saved(), [this.t.username]: this.t.refresh }); store.set('active', this.t.username);
  }

  /**
   * "Keep me signed in": hand the refresh token to the account service (it goes into an HttpOnly cookie) and forget
   * it here. Returns false when this server has no account service; the session then stays tab-only.
   */
  async rememberOnDevice(): Promise<boolean> {
    const r = await sessionApi('remember', { username: this.t.username, refreshToken: this.t.refresh }).catch(() => null);
    if (!r?.ok) return false;
    const j = await r.json();
    this.t = { ...this.t, access: j.access_token, refresh: '', expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    this.cookie = true;
    const a = saved(); delete a[this.t.username]; store.set('accounts', a);
    device.set([...device.get(), this.t.username]); device.active(this.t.username); store.set('active', this.t.username);
    return true;
  }

  async header(): Promise<string> {
    if (Date.now() > this.t.expiresAt - 60_000) await this.refresh();
    return `Bearer ${this.t.access}`;
  }

  refresh(): Promise<void> {
    // One refresh at a time: refresh tokens rotate, so a second parallel request would use a dead token.
    this.refreshing ??= (this.cookie ? this.cookieRefresh() : tokenRequest({ grant_type: 'refresh_token', refresh_token: this.t.refresh })
      .then((tok) => {
        this.t = { ...tok, username: tok.username || this.t.username };
        // A refresh that finishes after sign-out must not bring the account back.
        if (!this.signedOut && this.t.username in saved()) store.set('accounts', { ...saved(), [this.t.username]: tok.refresh });
      }))
      .finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async cookieRefresh() {
    const r = await sessionApi('refresh', { username: this.t.username });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) {
      device.set(device.get().filter((x) => x !== this.t.username));
      throw new Error(j.error?.message ? serverText(j.error.code, j.error.message) : t('oauth.sessionEnded'));
    }
    this.t = { ...this.t, access: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  }

  async signOut() {
    this.signedOut = true;
    await this.refreshing?.catch(() => {}); // then revoke whichever refresh token is current
    const a = saved(); delete a[this.t.username];
    store.set('accounts', a);
    device.set(device.get().filter((x) => x !== this.t.username));
    if (store.get<string>('active') === this.t.username) { store.set('active', null); device.active(null); }
    if (this.cookie) { await sessionApi('forget', { username: this.t.username }).catch(() => {}); return; }
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
// The settings scope covers your public key and encryption at rest (x:PublicKey, x:AccountSettings). Servers whose
// webmail client predates it refuse the scope: then security works without it and encryption says what's missing.
// ponytail: that retry re-sends the same two-factor code; if the server rejects the replay, the user enters a new one.
const SETTINGS_SCOPE = ' urn:stalwart:oauth:scope:settings';
export async function stepUp(user: string, pass: string, otp?: string): Promise<string | 'code'> {
  const tok = await authorize(user, pass, SECURITY_SCOPE + SETTINGS_SCOPE, otp)
    .catch((e: Error) => (/scope/i.test(e.message) ? authorize(user, pass, SECURITY_SCOPE, otp) : Promise.reject(e)));
  return tok === 'code' ? tok : tok.access;
}
