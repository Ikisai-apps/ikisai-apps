/**
 * Visitantes v2 (contrato C11 v2, migración 0106): varios móviles por visitante, correo optativo para guardar y recuperar el
 * acceso (código de un solo uso de Supabase Auth) y vínculo visitante ↔ huésped. Todo bajo `/api/v1/public/visitor/*` salvo
 * `visitor-link`, que va con la sesión del huésped en el portal. El núcleo nunca guarda el correo: solo su hash para el freno
 * y la cuenta de Auth que lo verificó.
 */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';
import type { RequestContext } from './sync.ts';
import { requireVisitor, resolveVisitor, VISITOR_HEADER, type Visitor } from './visitors.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function newVisitorToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * IP del cliente según el proxy: la que pone nuestro proxy (X-Ikisai-Client-Ip), la de Cloudflare, o la ÚLTIMA de X-Forwarded-For (la
 * añade el proxy más cercano; las primeras las puede escribir el cliente). Null si no hay ninguna. Sirve para frenos y para atar
 * el traspaso al móvil; nunca para autorizar.
 */
export function clientIp(request: Request): string | null {
  const own = request.headers.get('x-ikisai-client-ip') ?? request.headers.get('cf-connecting-ip');
  const forwarded = request.headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  const ip = (own ?? forwarded[forwarded.length - 1] ?? '').trim();
  return ip && ip.length <= 64 ? ip : null;
}

function cleanEmail(value: unknown): string {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EMAIL.test(email) || email.length > 320) fail(422, 'INVALID_OPERATION', 'Correo inválido.');
  return email;
}

/** Pista del correo para «¿Eres v•••@g•••.com?»: primera letra de cada parte y el dominio final. */
export function emailHint(email: string | null | undefined): string | null {
  if (!email || !email.includes('@')) return null;
  const [user, domain] = email.split('@');
  const dot = domain!.lastIndexOf('.');
  const host = dot > 0 ? domain!.slice(0, dot) : domain!;
  const tld = dot > 0 ? domain!.slice(dot) : '';
  return `${user!.slice(0, 1)}•••@${host.slice(0, 1)}•••${tld}`;
}

/** A · «Salir de este móvil»: revoca solo el token de la cabecera. */
export async function logoutVisitor(supabase: Supabase, request: Request): Promise<{ ok: true }> {
  const token = request.headers.get(VISITOR_HEADER);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) fail(401, 'VISITOR_REQUIRED', messageFor('VISITOR_REQUIRED'));
  await supabase.rpc('core_visitor_token_revoke', { p_token_hash: await sha256Hex(token) });
  return { ok: true };
}

/** B · pide a Auth un código de un solo uso. Responde siempre «enviado»: nunca dice si el correo existe. */
export async function requestVisitorEmail(supabase: Supabase, request: Request, body: unknown): Promise<{ sent: true }> {
  const email = cleanEmail((body as any)?.email);
  const visitor = await resolveVisitor(supabase, request);
  await supabase.rpc('core_visitor_email_request', { p_email_hash: await sha256Hex(email), p_ip: clientIp(request), p_visitor: visitor?.id ?? null });
  try {
    await supabase.remote('/auth/v1/otp', { method: 'POST', body: { email, create_user: true } });
  } catch (error) {
    // Un 429 de Auth sí se cuenta al cliente; cualquier otro fallo se calla (no revela nada y el freno ya quedó anotado).
    if ((error as any)?.status === 429) throw error;
    console.error('[ikisai] visitor otp', (error as any)?.code ?? String(error));
  }
  return { sent: true };
}

/** B · verifica el código. Con X-Visitor liga el correo a este móvil; si el correo ya era de otro visitante, lo recupera aquí. */
export async function verifyVisitorEmail(supabase: Supabase, request: Request, body: unknown): Promise<Record<string, unknown>> {
  const email = cleanEmail((body as any)?.email);
  const code = typeof (body as any)?.code === 'string' ? (body as any).code.trim() : '';
  if (!/^[0-9]{6,10}$/.test(code)) fail(400, 'CODE_INVALID', messageFor('CODE_INVALID'));
  const visitor = await resolveVisitor(supabase, request);
  const session = await supabase.remote('/auth/v1/verify', { method: 'POST', body: { type: 'email', email, token: code } }).catch(() => null);
  const authUser = typeof session?.user?.id === 'string' ? session.user.id as string : null;
  if (!authUser) fail(400, 'CODE_INVALID', messageFor('CODE_INVALID'));
  const out = await supabase.rpc<{ visitorId: string; saved?: boolean; recovered?: boolean }>('core_visitor_email_link', { p_visitor: visitor?.id ?? null, p_auth_user: authUser });
  if (out.recovered) {
    const token = newVisitorToken();
    await supabase.rpc('core_visitor_token_add', { p_visitor: out.visitorId, p_token_hash: await sha256Hex(token) });
    return { visitorId: out.visitorId, token, recovered: true };
  }
  return { visitorId: out.visitorId, saved: true };
}

export async function forgetVisitorEmail(supabase: Supabase, request: Request): Promise<{ ok: true }> {
  const visitor = await requireVisitor(supabase, request);
  await supabase.rpc('core_visitor_email_forget', { p_visitor: visitor.id });
  return { ok: true };
}

/** B · lo que el visitante sabe de sí mismo; el correo solo como pista. */
export async function visitorMe(supabase: Supabase, request: Request): Promise<Record<string, unknown>> {
  const visitor = await requireVisitor(supabase, request);
  const me = await supabase.rpc<{ visitorId: string; emailSaved: boolean; authUserId: string | null; devices: number; guestIds: string[] } | null>('core_visitor_me', { p_visitor: visitor.id });
  if (!me) fail(401, 'VISITOR_INVALID', messageFor('VISITOR_INVALID'));
  let hint: string | null = null;
  if (me.authUserId) {
    const account = await supabase.remote('/auth/v1/admin/users/' + me.authUserId, { service: true }).catch(() => null);
    hint = emailHint(typeof account?.email === 'string' ? account.email : null);
  }
  return { visitorId: me.visitorId, emailSaved: me.emailSaved, emailHint: hint, devices: me.devices, guestIds: me.guestIds ?? [] };
}

/**
 * C · el visitante reclama la ficha de su petición aceptada: la app dueña (resolutor `core.allow_visitor_claim`) dice de qué
 * huésped es; el núcleo liga y emite un enlace de portal de un solo uso y diez minutos para la cuenta de portal del huésped.
 * `portalUser` crea o reutiliza esa cuenta (nunca una del personal: 0103).
 */
export async function claimVisitor(supabase: Supabase, request: Request, body: unknown, portalDomain: string,
  portalUser: (person: { name?: string; email?: string | null }, app: string, scope: Record<string, unknown>) => Promise<string>): Promise<Record<string, unknown>> {
  const visitor = await requireVisitor(supabase, request);
  const requestId = typeof (body as any)?.requestId === 'string' ? (body as any).requestId.toLowerCase() : '';
  if (!UUID.test(requestId)) fail(422, 'INVALID_OPERATION', 'requestId inválido.');
  const found = await supabase.rpc<{ guest_id: string; reservation_id: string | null; app: string }>('core_visitor_claim_resolve', { p_visitor: visitor.id, p_request: requestId });
  const scope = { reservation_id: String(found.reservation_id ?? '').toLowerCase(), guest_id: String(found.guest_id).toLowerCase() };
  if (!UUID.test(scope.reservation_id) || !UUID.test(scope.guest_id)) fail(404, 'NOT_FOUND', messageFor('NOT_FOUND'));
  const user = await portalUser({}, 'guests', scope);
  const token = newVisitorToken().slice(0, 43).replace(/[^A-Za-z0-9_-]/g, 'a');
  const out = await supabase.rpc<{ linkId: string; validUntil: string }>('core_visitor_claim_finish', {
    p_visitor: visitor.id, p_app: 'guests', p_guest: scope.guest_id, p_reservation: scope.reservation_id, p_user: user, p_digest: await sha256Hex(token),
  });
  return { loginToken: token, loginUrl: `https://${portalDomain}/i/${token}`, guestId: scope.guest_id, validUntil: out.validUntil };
}

/** D · traspaso entre dominios: código de un solo uso (5 minutos) que el otro dominio canjea por un token propio del mismo visitante. */
export async function createVisitorHandoff(supabase: Supabase, request: Request): Promise<{ code: string; validUntil: string }> {
  const visitor = await requireVisitor(supabase, request);
  const ip = clientIp(request);
  if (!ip) fail(400, 'INVALID_OPERATION', 'No se puede identificar este móvil; el traspaso necesita la IP del proxy.');
  const code = newVisitorToken();
  const validUntil = await supabase.rpc<string>('core_visitor_handoff_create', { p_visitor: visitor.id, p_code_hash: await sha256Hex(code), p_ip: ip });
  return { code, validUntil };
}

export async function redeemVisitorHandoff(supabase: Supabase, request: Request, body: unknown): Promise<{ visitorId: string; token: string }> {
  const code = typeof (body as any)?.code === 'string' ? (body as any).code : '';
  if (!/^[0-9a-f]{64}$/.test(code)) fail(401, 'CODE_INVALID', messageFor('CODE_INVALID'));
  // Mismo móvil, otro dominio: la IP tiene que coincidir con la que pidió el código (contra la fijación de identidad); sin IP, no hay canje.
  const ip = clientIp(request);
  if (!ip) fail(401, 'CODE_INVALID', messageFor('CODE_INVALID'));
  const visitorId = await supabase.rpc<string | null>('core_visitor_handoff_redeem', { p_code_hash: await sha256Hex(code), p_ip: ip });
  if (!visitorId) fail(401, 'CODE_INVALID', messageFor('CODE_INVALID'));
  const token = newVisitorToken();
  await supabase.rpc('core_visitor_token_add', { p_visitor: visitorId, p_token_hash: await sha256Hex(token) });
  return { visitorId, token };
}

/** C · el huésped, con su sesión en el portal, une el móvil de visitante (X-Visitor) a su ficha. Idempotente. */
export async function linkVisitorToGuest(supabase: Supabase, ctx: RequestContext, request: Request, body: unknown): Promise<{ linked: true; visitorId: string }> {
  const visitor: Visitor = await requireVisitor(supabase, request);
  const guestId = typeof (body as any)?.guestId === 'string' ? (body as any).guestId.toLowerCase() : '';
  if (!UUID.test(guestId)) fail(422, 'INVALID_OPERATION', 'guestId inválido.');
  const grants = Array.isArray((ctx.membership.scopes as any)?.grants) ? (ctx.membership.scopes as any).grants as Array<Record<string, unknown>> : [];
  const grant = grants.find((g) => typeof g.guest_id === 'string' && g.guest_id.toLowerCase() === guestId);
  if (!grant) fail(403, 'FORBIDDEN', 'Esa ficha no es tuya.');
  await supabase.rpc('core_visitor_link_set', {
    p_visitor: visitor.id, p_app: ctx.app, p_guest: guestId, p_reservation: typeof grant.reservation_id === 'string' ? grant.reservation_id : null, p_user: ctx.user.id, p_via: 'guest',
  });
  return { linked: true, visitorId: visitor.id };
}

export async function unlinkVisitorFromGuest(supabase: Supabase, ctx: RequestContext, guestId: string): Promise<{ ok: true; revoked: number }> {
  const id = guestId.toLowerCase();
  if (!UUID.test(id)) fail(422, 'INVALID_OPERATION', 'guestId inválido.');
  const grants = Array.isArray((ctx.membership.scopes as any)?.grants) ? (ctx.membership.scopes as any).grants as Array<Record<string, unknown>> : [];
  if (!grants.some((g) => typeof g.guest_id === 'string' && g.guest_id.toLowerCase() === id)) fail(403, 'FORBIDDEN', 'Esa ficha no es tuya.');
  const revoked = await supabase.rpc<number>('core_visitor_link_revoke', { p_guest: id, p_user: ctx.user.id });
  return { ok: true, revoked };
}
