// Sign-in with OAuth 2.1 (authorization code + PKCE) against the mail server. The app never sees the password:
// the server's own sign-in page handles it (and two-factor codes), then hands back a short-lived token.
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

/** Step 1: send the browser to the server's sign-in page. */
export async function startSignIn(loginHint?: string) {
  const verifier = random(48), state = random(16);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  store.set('pkce', { verifier, state });
  const q = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri(), scope: SCOPE,
    code_challenge: challenge, code_challenge_method: 'S256', state, ...(loginHint ? { login_hint: loginHint } : {}),
  });
  location.assign(`/login?${q}`);
}

export interface Tokens { access: string; refresh: string; expiresAt: number; username: string }

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch('/auth/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(j.error_description || j.error || `Sign-in failed (${res.status})`);
  return { access: j.access_token, refresh: j.refresh_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, username: j.username ?? '' };
}

/** Step 2: back on our page with ?code=… — exchange it. Returns null when this isn't a sign-in return. */
export async function finishSignIn(): Promise<Tokens | null> {
  const params = new URLSearchParams(location.search);
  if (!params.has('code') && !params.has('error')) return null;
  history.replaceState(null, '', location.pathname); // never leave the code in the address bar or history
  const pkce = store.get<{ verifier: string; state: string }>('pkce');
  store.set('pkce', null);
  if (params.get('error')) throw new Error(params.get('error_description') || 'Sign-in was cancelled.');
  if (!pkce || params.get('state') !== pkce.state) throw new Error('This sign-in link is out of date. Please sign in again.');
  const t = await tokenRequest({ grant_type: 'authorization_code', code: params.get('code')!, redirect_uri: redirectUri(), code_verifier: pkce.verifier });
  store.set('refresh', { token: t.refresh, username: t.username });
  return t;
}

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
