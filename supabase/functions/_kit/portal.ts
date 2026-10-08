/**
 * Enlaces personales de los portales Organizers y Guests (contrato §3.6).
 *
 * Emisión (Booking y Organizers, `createApp({ portalIssuer: true })`): `POST portal-links` crea o reutiliza la cuenta de Auth
 * de la persona (por su correo, para que repita cuenta en el siguiente retiro; sin correo, una cuenta interna), registra el
 * enlace (solo el sha256 del token) y devuelve `https://<portal>/i/<token>` una sola vez. Lista, revoca y amplía.
 * Canje (cualquier portal): `POST auth/link {token}` → sesión propia de Supabase y pase de sesión única.
 */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';
import { newPass } from './sso.ts';
import type { RequestContext } from './sync.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const PORTAL_DOMAINS: Record<string, string> = { organizers: 'organizers.ikisai.com', guests: 'guests.ikisai.com' };

export function createPortalLinks(supabase: Supabase, issuerApp: string) {
  async function userFor(person: { name?: string; email?: string | null }, app: string, scope: Record<string, unknown>): Promise<string> {
    const email = typeof person.email === 'string' && person.email.trim() ? person.email.trim().toLowerCase() : null;
    if (email && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320)) fail(422, 'INVALID_OPERATION', 'Correo inválido.');
    // Misma persona: por correo (en la base, no en la primera página de Auth) o, en huéspedes, por su reserva y su huésped.
    const existing = await supabase.rpc<string | null>('core_portal_find_user', { p_app: app, p_scope: scope, p_email: email });
    if (existing) return existing;
    // Sin contraseña: se entra por enlace y, después, con la cuenta permanente (Google o código por correo).
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    const password = btoa(String.fromCharCode(...bytes));
    const created = await supabase.remote('/auth/v1/admin/users', {
      service: true, method: 'POST',
      body: { email: email ?? `p-${crypto.randomUUID()}@portales.ikisai.com`, password, email_confirm: true, user_metadata: { portal: true, name: person.name ?? null } },
    });
    if (typeof created?.id !== 'string') fail(502, 'AUTH_ADMIN_FAILED', messageFor('AUTH_ADMIN_FAILED'));
    return created.id;
  }

  async function issue(ctx: RequestContext, body: any) {
    if (ctx.user.kind === 'agent') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    const app = body?.app;
    if (!(app in PORTAL_DOMAINS)) fail(422, 'INVALID_OPERATION', 'Portal desconocido.');
    const scope = body?.scope;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope) || typeof scope.reservation_id !== 'string' || !UUID.test(scope.reservation_id)) {
      fail(422, 'INVALID_OPERATION', 'El ámbito necesita reservation_id.');
    }
    if (app === 'guests' && (typeof scope.guest_id !== 'string' || !UUID.test(scope.guest_id))) fail(422, 'INVALID_OPERATION', 'Un enlace de huésped necesita guest_id.');
    const clean = app === 'guests' ? { reservation_id: scope.reservation_id.toLowerCase(), guest_id: scope.guest_id.toLowerCase() } : { reservation_id: scope.reservation_id.toLowerCase() };
    // O6: enlace al huésped de muestra (vista previa del organizador). La sesión solo lee (PREVIEW_READ_ONLY en el kit).
    if (app === 'guests' && body?.preview === true) (clean as Record<string, unknown>).preview = true;
    const person = body?.person ?? {};
    const name = typeof person.name === 'string' ? person.name.trim().slice(0, 120) : '';
    // Autoriza antes de crear la cuenta (la función SQL vuelve a comprobarlo todo en la transacción).
    if (ctx.membership.role === 'reader') fail(403, 'FORBIDDEN', messageFor('FORBIDDEN'));
    if (issuerApp === 'organizers' && app !== 'guests') fail(403, 'FORBIDDEN', 'Un organizador solo genera enlaces de huésped.');
    const userId = await userFor(person, app, clean);
    // `replace`: el enlace nuevo deja sin efecto los anteriores de ese huésped (reenvío).
    if (app === 'guests' && body?.replace === true) await supabase.rpc('core_portal_revoke_guest_links', { p_scope: clean });
    const token = newPass();
    const link = await supabase.rpc<any>('core_portal_link_issue', {
      p_issuer_app: issuerApp, p_actor: ctx.user.id, p_app: app, p_user: userId, p_digest: await sha256Hex(token), p_scope: clean,
      p_label: typeof body.label === 'string' ? body.label : name || null, p_display_name: name || null,
    });
    return { ...link, url: `https://${PORTAL_DOMAINS[app]}/i/${token}`, shownOnce: true };
  }

  async function list(ctx: RequestContext, params: URLSearchParams) {
    const reservation = params.get('reservation') ?? '';
    if (!UUID.test(reservation)) fail(422, 'INVALID_FILTER', 'reservation inválida.');
    return { items: await supabase.rpc('core_portal_links_list', { p_issuer_app: issuerApp, p_actor: ctx.user.id, p_reservation: reservation }) };
  }

  async function manage(ctx: RequestContext, id: string, action: 'revoke' | 'extend', body: any) {
    if (!UUID.test(id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
    let until: string | null = null;
    if (action === 'extend') {
      const when = new Date(body?.until);
      if (Number.isNaN(when.getTime())) fail(422, 'INVALID_OPERATION', 'until inválido.');
      until = when.toISOString();
    }
    return supabase.rpc('core_portal_link_manage', { p_issuer_app: issuerApp, p_actor: ctx.user.id, p_link: id, p_action: action, p_until: until });
  }

  return { issue, list, manage };
}

/** Canje del enlace en el portal: usuario del enlace o error explicable (`LINK_INVALID`, `LINK_EXPIRED`). */
export async function resolvePortalLink(supabase: Supabase, app: string, token: unknown): Promise<string> {
  if (typeof token !== 'string' || !TOKEN.test(token)) fail(401, 'LINK_INVALID', messageFor('LINK_INVALID'));
  const out = await supabase.rpc<any>('core_portal_link_resolve', { p_app: app, p_digest: await sha256Hex(token) });
  if (!out) fail(401, 'LINK_INVALID', messageFor('LINK_INVALID'));
  if (out.expired) fail(401, 'LINK_EXPIRED', messageFor('LINK_EXPIRED'), { validUntil: out.validUntil ?? null });
  return out.userId as string;
}
