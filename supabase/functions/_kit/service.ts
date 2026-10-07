/**
 * Identidades de servicio (contrato §3.7, migraciones 0067 y 0068): cuenta propia y visible para que un worker escriba en otra
 * app con core.commit («Feedback (sistema)», «Booking (sistema)»). La cuenta de Auth se crea la primera vez que hace falta,
 * sin contraseña utilizable, y el núcleo le da los accesos de `core.service_grants`.
 */
import { fail, messageFor } from './errors.ts';
import type { Supabase } from './supabase.ts';

export async function ensureServiceActor(supabase: Supabase, name: string): Promise<string> {
  const existing = await supabase.rpc<string | null>('core_service_actor', { p_name: name });
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const user = await supabase.remote('/auth/v1/admin/users', {
    service: true, method: 'POST',
    body: { email: 'svc-' + name + '-' + crypto.randomUUID().slice(0, 8) + '@sistema.ikisai.com', password: btoa(String.fromCharCode(...bytes)), email_confirm: true, user_metadata: { service: name } },
  });
  if (typeof user?.id !== 'string') fail(502, 'AUTH_ADMIN_FAILED', messageFor('AUTH_ADMIN_FAILED'));
  return supabase.rpc<string>('core_register_service_actor', { p_user: user.id, p_name: name });
}
