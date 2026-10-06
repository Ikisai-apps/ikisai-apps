/**
 * Sesión única entre las apps de ikisai.com (contrato §3.4).
 *
 * Al entrar con contraseña en cualquier app se emite un **pase** propio del núcleo (32 bytes aleatorios; en base de datos solo
 * su sha256) que viaja en la cookie `ikisai_sso` (HttpOnly, Secure, SameSite=Lax, Path=/api/v1/auth, Domain=.ikisai.com).
 * Otra app, sin sesión, llama a `POST /api/v1/auth/sso`: el `_worker.js` reenvía el pase en `X-Ikisai-Sso` y la Edge crea
 * para esa app una **sesión de Supabase nueva e independiente** (enlace mágico generado y verificado en el servidor, sin
 * correo), solo si la cuenta tiene acceso a la app. No se comparte ninguna sesión de Supabase entre apps: sus tokens de
 * refresco son de un solo uso y compartirlos haría que una app invalidara a otra.
 */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';
import type { SessionTokens } from './auth.ts';

export const SSO_COOKIE = 'ikisai_sso';
export const SSO_HEADER = 'x-ikisai-sso';
const PASS = /^[A-Za-z0-9_-]{43}$/;
const DAYS = 30;

export function newPass(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pase recibido: cabecera del `_worker.js` o, si se llama directamente a la Edge, la cookie. */
export function passFrom(request: Request): string | null {
  const header = request.headers.get(SSO_HEADER);
  if (header && PASS.test(header)) return header;
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${SSO_COOKIE}=([^;]+)`));
  return match && PASS.test(match[1]!) ? match[1]! : null;
}

/** Cabecera Set-Cookie del pase. En dominios de ikisai.com la cookie es común (Domain=.ikisai.com); en otros, del host. */
export function passCookie(pass: string | null, origin: string | null): string {
  let domain = '';
  try {
    const host = origin ? new URL(origin).hostname : '';
    if (host === 'ikisai.com' || host.endsWith('.ikisai.com')) domain = '; Domain=.ikisai.com';
  } catch { /* origen inválido: cookie del host */ }
  const base = `${SSO_COOKIE}=${pass ?? ''}; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax${domain}`;
  return pass ? `${base}; Max-Age=${DAYS * 86400}` : `${base}; Max-Age=0`;
}

function subjectOf(accessToken: string): string | null {
  try {
    const part = accessToken.split('.')[1] ?? '';
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof claims.sub === 'string' ? claims.sub : null;
  } catch {
    return null;
  }
}

export function createSso(supabase: Supabase, app: string) {
  /** Emite un pase para el usuario de unos tokens recién obtenidos. */
  async function issueFor(tokens: SessionTokens): Promise<string | null> {
    const user = subjectOf(tokens.token);
    if (!user) return null;
    const pass = newPass();
    await supabase.rpc('core_sso_issue', { p_user: user, p_digest: await sha256Hex(pass), p_days: DAYS });
    return pass;
  }

  async function issueForUser(user: string): Promise<string> {
    const pass = newPass();
    await supabase.rpc('core_sso_issue', { p_user: user, p_digest: await sha256Hex(pass), p_days: DAYS });
    return pass;
  }

  /** Sesión nueva para esta app a partir del pase. 401 NO_SSO si el pase no vale; 403 NO_MEMBERSHIP si no hay acceso. */
  async function login(pass: string | null): Promise<SessionTokens> {
    if (!pass) fail(401, 'NO_SSO', messageFor('NO_SSO'));
    const user = await supabase.rpc<string | null>('core_sso_resolve', { p_digest: await sha256Hex(pass), p_days: DAYS });
    if (!user) fail(401, 'NO_SSO', messageFor('NO_SSO'));
    // Comprueba el acceso a esta app antes de crear la sesión (lanza NO_MEMBERSHIP 403).
    await supabase.rpc('core_bootstrap', { p_app: app, p_user: user });
    const account = await supabase.remote(`/auth/v1/admin/users/${user}`, { service: true });
    if (typeof account?.email !== 'string') fail(401, 'NO_SSO', messageFor('NO_SSO'));
    const link = await supabase.remote('/auth/v1/admin/generate_link', { service: true, method: 'POST', body: { type: 'magiclink', email: account.email } });
    const hashed = link?.hashed_token ?? link?.properties?.hashed_token;
    if (typeof hashed !== 'string') fail(502, 'AUTH_ADMIN_FAILED', messageFor('AUTH_ADMIN_FAILED'));
    const session = await supabase.remote('/auth/v1/verify', { method: 'POST', body: { type: 'magiclink', token_hash: hashed } });
    if (typeof session?.access_token !== 'string') fail(502, 'AUTH_ADMIN_FAILED', messageFor('AUTH_ADMIN_FAILED'));
    return {
      token: session.access_token,
      refreshToken: session.refresh_token,
      expiresAt: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
      expiresIn: session.expires_in ?? 3600,
    };
  }

  async function revoke(pass: string | null, all = false): Promise<void> {
    if (!pass) return;
    await supabase.rpc('core_sso_revoke', { p_digest: await sha256Hex(pass), p_all: all });
  }

  async function revokeUser(user: string): Promise<void> {
    await supabase.rpc('core_sso_revoke_user', { p_user: user });
  }

  return { issueFor, issueForUser, login, revoke, revokeUser };
}
