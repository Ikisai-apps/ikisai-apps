/**
 * Administración común del ecosistema (contrato §3.5): rutas `admin/*` que solo monta la función de Central (`admin: true`).
 * Cada operación la autoriza core.require_admin: ser `owner` de la app `central` y no ser agente.
 */
import { fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_ID = /^[a-z][a-z0-9_]{1,30}$/;
const ROLES = ['reader', 'editor', 'owner'];

export function createAdmin(supabase: Supabase) {
  function human(ctx: RequestContext) {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
  }

  async function accounts(ctx: RequestContext) {
    human(ctx);
    return { items: await supabase.rpc('core_admin_accounts', { p_actor: ctx.user.id }) };
  }

  async function setMembership(ctx: RequestContext, body: any) {
    human(ctx);
    if (typeof body?.app !== 'string' || !APP_ID.test(body.app)) fail(422, 'INVALID_OPERATION', 'App inválida.');
    if (typeof body?.userId !== 'string' || !UUID.test(body.userId)) fail(422, 'INVALID_OPERATION', 'userId inválido.');
    if (body.role !== null && !ROLES.includes(body.role)) fail(422, 'INVALID_ROLE', messageFor('INVALID_ROLE'));
    return supabase.rpc('core_admin_set_membership', {
      p_actor: ctx.user.id, p_app: body.app, p_user: body.userId, p_role: body.role, p_scopes: body.scopes ?? null,
      p_display_name: typeof body.displayName === 'string' ? body.displayName : null,
    });
  }

  /** Alta de una persona con contraseña temporal y sus accesos iniciales: `{email, displayName?, memberships: [{app, role, scopes?}]}`. */
  async function invite(ctx: RequestContext, body: any) {
    human(ctx);
    await supabase.rpc('core_admin_accounts', { p_actor: ctx.user.id }); // autoriza antes de crear nada
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) fail(422, 'INVALID_OPERATION', 'Correo inválido.');
    const memberships: Array<{ app: string; role: string; scopes?: unknown }> = Array.isArray(body.memberships) ? body.memberships : [];
    if (!memberships.length) fail(422, 'INVALID_OPERATION', 'Indica al menos un acceso.');
    for (const m of memberships) {
      if (typeof m?.app !== 'string' || !APP_ID.test(m.app) || !ROLES.includes(m.role)) fail(422, 'INVALID_OPERATION', 'Acceso inválido.', { membership: m });
    }
    const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
    const temporaryPassword = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
    let userId: string;
    let created = true;
    try {
      const user = await supabase.remote('/auth/v1/admin/users', { service: true, method: 'POST', body: { email, password: temporaryPassword, email_confirm: true } });
      userId = user.id;
    } catch (error: any) {
      if (error?.code !== 'USER_EXISTS') throw error;
      const page = await supabase.remote('/auth/v1/admin/users?page=1&per_page=1000', { service: true });
      const found = (Array.isArray(page?.users) ? page.users : []).find((u: any) => typeof u?.email === 'string' && u.email.toLowerCase() === email);
      if (!found) fail(409, 'USER_EXISTS', 'Ya existe una cuenta con ese correo.');
      userId = found.id;
      created = false;
    }
    const results = [];
    for (const m of memberships) {
      results.push(await supabase.rpc('core_admin_set_membership', {
        p_actor: ctx.user.id, p_app: m.app, p_user: userId, p_role: m.role, p_scopes: m.scopes ?? null,
        p_display_name: typeof body.displayName === 'string' ? body.displayName : null,
      }));
    }
    return { userId, email, created, temporaryPassword: created ? temporaryPassword : null, memberships: results };
  }

  async function accessLog(ctx: RequestContext, params: URLSearchParams) {
    human(ctx);
    const app = params.get('app');
    if (app !== null && !APP_ID.test(app)) fail(422, 'INVALID_FILTER', 'App inválida.');
    const before = params.get('before'); const limit = params.get('limit');
    if ((before !== null && !/^\d+$/.test(before)) || (limit !== null && !/^\d+$/.test(limit))) fail(422, 'INVALID_FILTER', 'Parámetros inválidos.');
    return supabase.rpc('core_admin_access_log', { p_actor: ctx.user.id, p_app: app, p_before: before === null ? null : Number(before), p_limit: limit === null ? null : Number(limit) });
  }

  async function agents(ctx: RequestContext) {
    human(ctx);
    return { items: await supabase.rpc('core_admin_agents', { p_actor: ctx.user.id }) };
  }

  async function revokeAgent(ctx: RequestContext, keyId: string) {
    human(ctx);
    if (!UUID.test(keyId)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    return supabase.rpc('core_admin_revoke_agent_key', { p_actor: ctx.user.id, p_key: keyId });
  }

  /** Contraseña temporal nueva (la persona la cambia al entrar); revoca sus pases de sesión única. */
  async function resetPassword(ctx: RequestContext, userId: string) {
    human(ctx);
    if (!UUID.test(userId)) fail(422, 'INVALID_OPERATION', 'userId inválido.');
    await supabase.rpc('core_admin_account_event', { p_actor: ctx.user.id, p_user: userId, p_event: 'password_reset' });
    const bytes = new Uint8Array(18); crypto.getRandomValues(bytes);
    const temporaryPassword = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '');
    await supabase.remote('/auth/v1/admin/users/' + userId, { service: true, method: 'PUT', body: { password: temporaryPassword } });
    return { userId, temporaryPassword };
  }

  /** Desactiva (sin acceso a ninguna app, sin borrar nada) o reactiva una cuenta. */
  async function setDisabled(ctx: RequestContext, userId: string, disabled: boolean) {
    human(ctx);
    if (!UUID.test(userId)) fail(422, 'INVALID_OPERATION', 'userId inválido.');
    await supabase.rpc('core_admin_account_event', { p_actor: ctx.user.id, p_user: userId, p_event: disabled ? 'account_disabled' : 'account_enabled' });
    await supabase.remote('/auth/v1/admin/users/' + userId, { service: true, method: 'PUT', body: { ban_duration: disabled ? '876000h' : 'none' } });
    return { userId, disabled };
  }

  /** Almacenamiento (ALMACENAMIENTO.md fase 0): tamaños, niveles respecto a los límites e historial semanal. */
  async function storage(ctx: RequestContext) {
    human(ctx);
    return supabase.rpc('core_admin_storage', { p_actor: ctx.user.id });
  }

  return { accounts, setMembership, invite, accessLog, agents, revokeAgent, resetPassword, setDisabled, storage };
}
