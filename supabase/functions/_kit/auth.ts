/** Identidad: sesión Supabase validada contra Auth y contra auth.sessions (logout inmediato). */
import { fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';

export interface Identity {
  id: string;
  email: string | null;
  sessionId: string;
}

export interface AuthService {
  identity(token: string | null | undefined): Promise<Identity>;
  login(body: unknown): Promise<SessionTokens>;
  refresh(body: unknown): Promise<SessionTokens>;
  logout(token: string): Promise<void>;
  changePassword(token: string, identity: Identity, body: unknown): Promise<{ changed: true }>;
}

export interface SessionTokens {
  token: string;
  refreshToken: string;
  expiresAt: number;
  expiresIn: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createAuth(supabase: Supabase): AuthService {
  function claimsOf(token: string): Record<string, unknown> {
    try {
      const part = token.split('.')[1] ?? '';
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    } catch {
      fail(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    }
  }

  async function identity(token: string | null | undefined): Promise<Identity> {
    if (typeof token !== 'string' || !token || token.length > 8192) fail(401, 'UNAUTHENTICATED', messageFor('UNAUTHENTICATED'));
    const user = await supabase.remote('/auth/v1/user', { bearer: token });
    if (!user?.id || user.role !== 'authenticated') fail(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    const claims = claimsOf(token);
    const sessionId = claims.session_id;
    if (claims.sub !== user.id || typeof sessionId !== 'string' || !UUID.test(sessionId)) fail(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    const active = await supabase.rpc<boolean>('core_session_active', { p_user: user.id, p_session: sessionId });
    if (!active) fail(401, 'UNAUTHORIZED', 'La sesión ha caducado o se ha cerrado.');
    return { id: user.id, email: user.email ?? null, sessionId };
  }

  function tokens(result: any): SessionTokens {
    return {
      token: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: result.expires_at ?? Math.floor(Date.now() / 1000) + (result.expires_in ?? 3600),
      expiresIn: result.expires_in ?? 3600,
    };
  }

  async function login(body: any): Promise<SessionTokens> {
    const username = body?.username ?? body?.email;
    if (typeof username !== 'string' || typeof body?.password !== 'string' || username.length > 320 || body.password.length > 256) {
      fail(401, 'LOGIN_FAILED', messageFor('LOGIN_FAILED'));
    }
    try {
      const result = await supabase.remote('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: username.trim().toLowerCase(), password: body.password } });
      return tokens(result);
    } catch (error: any) {
      if (error?.code === 'UNAUTHORIZED') fail(401, 'LOGIN_FAILED', messageFor('LOGIN_FAILED'));
      throw error;
    }
  }

  async function refresh(body: any): Promise<SessionTokens> {
    if (typeof body?.refreshToken !== 'string' || body.refreshToken.length > 4096) fail(401, 'UNAUTHORIZED', messageFor('UNAUTHORIZED'));
    const result = await supabase.remote('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: body.refreshToken } });
    return tokens(result);
  }

  async function logout(token: string): Promise<void> {
    const response = await supabase.remote('/auth/v1/logout?scope=local', { method: 'POST', bearer: token, raw: true });
    if (!response.ok && response.status !== 401 && response.status !== 404) fail(503, 'BACKEND_UNAVAILABLE', messageFor('BACKEND_UNAVAILABLE'));
  }

  async function changePassword(token: string, who: Identity, body: any): Promise<{ changed: true }> {
    if (typeof body?.currentPassword !== 'string' || typeof body?.newPassword !== 'string' || body.newPassword.length < 10 || body.newPassword.length > 256) {
      fail(422, 'INVALID_PASSWORD', 'La nueva contraseña debe tener al menos 10 caracteres.');
    }
    if (!who.email) fail(422, 'INVALID_ACCOUNT', 'La cuenta no tiene correo.');
    try {
      await supabase.remote('/auth/v1/token?grant_type=password', { method: 'POST', body: { email: who.email, password: body.currentPassword } });
    } catch {
      fail(401, 'LOGIN_FAILED', 'La contraseña actual no es correcta.');
    }
    await supabase.remote('/auth/v1/user', { method: 'PUT', bearer: token, body: { password: body.newPassword } });
    // Revoca el resto de sesiones del usuario; la actual se conserva.
    await supabase.remote('/auth/v1/logout?scope=others', { method: 'POST', bearer: token, raw: true });
    return { changed: true };
  }

  return { identity, login, refresh, logout, changePassword };
}
