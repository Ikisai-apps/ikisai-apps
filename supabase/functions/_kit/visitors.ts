/**
 * Visitantes anónimos (contrato C11, migración 0096): quien entra por el QR de un evento sin invitación. El navegador
 * guarda un token aleatorio y lo manda en la cabecera `X-Visitor`; aquí solo viaja y se guarda su resumen SHA-256.
 * Un visitante no es una sesión ni un miembro: sirve para firmar escrituras públicas (0094) y para las lecturas de «lo mío».
 */
import { fail, messageFor } from './errors.ts';
import { sha256Hex, type Supabase } from './supabase.ts';

export interface Visitor { id: string; eventCode: string | null }

export const VISITOR_HEADER = 'x-visitor';
const TOKEN = /^[0-9a-f]{64}$/;

/** Alta: token nuevo para el navegador (solo se enseña una vez) y su identidad. */
export async function issueVisitor(supabase: Supabase, eventCode: string | null): Promise<{ visitorId: string; token: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  const code = typeof eventCode === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(eventCode) ? eventCode : null;
  const visitorId = await supabase.rpc<string>('core_visitor_create', { p_token_hash: await sha256Hex(token), p_event_code: code });
  return { visitorId, token };
}

/** El visitante de la petición, o null si no trae cabecera. Con cabecera inválida o revocada: 401 VISITOR_INVALID. */
export async function resolveVisitor(supabase: Supabase, request: Request): Promise<Visitor | null> {
  const token = request.headers.get(VISITOR_HEADER);
  if (!token) return null;
  if (!TOKEN.test(token)) fail(401, 'VISITOR_INVALID', messageFor('VISITOR_INVALID'));
  const out = await supabase.rpc<{ id: string; eventCode: string | null } | null>('core_visitor_resolve', { p_token_hash: await sha256Hex(token) });
  if (!out?.id) fail(401, 'VISITOR_INVALID', messageFor('VISITOR_INVALID'));
  return { id: out.id, eventCode: out.eventCode ?? null };
}

/** Como resolveVisitor, pero la ruta exige visitante: sin cabecera, 401 VISITOR_REQUIRED. */
export async function requireVisitor(supabase: Supabase, request: Request): Promise<Visitor> {
  const visitor = await resolveVisitor(supabase, request);
  if (!visitor) fail(401, 'VISITOR_REQUIRED', messageFor('VISITOR_REQUIRED'));
  return visitor;
}

/**
 * Lectura pública con el visitante resuelto: `visitor_id` sale de la cabecera, nunca de los argumentos del cliente
 * (se descarta cualquier `visitor_id` que venga en la consulta). Sin cabecera, la lectura va sin visitante.
 */
export async function publicReadWithVisitor(supabase: Supabase, name: string, args: Record<string, unknown>, visitor: Visitor | null): Promise<unknown> {
  const { visitor_id: _dropped, ...rest } = args;
  const p_args = visitor ? { ...rest, visitor_id: visitor.id } : rest;
  return supabase.rpc<unknown>('core_public_read', { p_name: name, p_args });
}

/** Orígenes admitidos en las rutas `public/*` de cualquier Edge: los dominios del proyecto, no solo el de la propia app. */
export function isPublicOrigin(origin: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*ikisai\.com$/.test(origin) || /^https:\/\/ikisai-[a-z0-9-]+\.pages\.dev$/.test(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin);
}
