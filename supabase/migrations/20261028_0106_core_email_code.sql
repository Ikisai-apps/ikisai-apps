-- 0106 · Portales: entrar con un código por correo (cuenta permanente sin Workspace; decisión de VG del 27-10-2026).
--
-- Quien organiza (y, si se enciende, el huésped) entra con un código de un solo uso de Supabase Auth enviado al correo de
-- su enlace, para no quedarse fuera en un móvil nuevo o tras cerrar sesión. Una sesión de Auth vale en todas las apps, así
-- que el código solo se manda a una cuenta que podría entrar igualmente por su enlace en esa app:
--   - es una cuenta de portal (`core.is_portal_account`, 0103): nunca la de alguien del personal;
--   - tiene en esa app un enlace sin revocar y vigente (`core.portal_link_valid_until`, como al canjearlo).
-- La Edge responde igual exista o no (no revela correos) y no crea cuentas (`create_user: false`).

create or replace function core.email_code_user(p_app text, p_email text)
returns uuid language sql stable as $$
  select u.id from auth.users u
   where p_app in ('organizers', 'guests')
     and coalesce(p_email, '') <> '' and lower(u.email) = lower(p_email)
     and core.is_portal_account(u.id)
     and exists (select 1 from core.portal_links l
                  where l.app = p_app and l.user_id = u.id and l.revoked_at is null
                    and coalesce(core.portal_link_valid_until(l), '-infinity'::timestamptz) >= now())
   limit 1
$$;

create or replace function public.core_email_code_user(p_app text, p_email text) returns uuid
language sql stable security definer set search_path = '' as $$ select core.email_code_user(p_app, p_email) $$;

revoke all on function core.email_code_user(text, text) from public, anon, authenticated;
grant execute on function core.email_code_user(text, text) to service_role;
revoke all on function public.core_email_code_user(text, text) from public, anon, authenticated;
grant execute on function public.core_email_code_user(text, text) to service_role;
