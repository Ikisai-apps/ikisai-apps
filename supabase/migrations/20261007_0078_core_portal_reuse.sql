-- Ikisai Core · cuentas de portal sin duplicados (peticiones C2 de Organizers).
-- Al reenviar el enlace de un huésped se reutiliza su cuenta (misma reserva y huésped) en lugar de crear otra; con correo, se
-- busca en la base (no en la primera página de Auth). Con `replace`, los enlaces anteriores de ese huésped se revocan en la
-- misma operación, para que un enlace reenviado deje sin efecto el antiguo.

create or replace function core.portal_find_user(p_app text, p_scope jsonb, p_email text)
returns uuid language plpgsql stable as $$
declare v_user uuid;
begin
  if coalesce(p_email, '') <> '' then
    select id into v_user from auth.users where lower(email) = lower(p_email) limit 1;
    if v_user is not null then return v_user; end if;
  end if;
  if p_app = 'guests' and coalesce(p_scope->>'guest_id', '') <> '' then
    select l.user_id into v_user from core.portal_links l
     where l.app = 'guests' and l.scope->>'guest_id' = p_scope->>'guest_id' and l.scope->>'reservation_id' = p_scope->>'reservation_id'
     order by l.created_at desc limit 1;
  end if;
  return v_user;
end $$;

-- Revoca los enlaces vigentes de ese huésped (sin quitar su permiso: el enlace nuevo lo mantiene).
create or replace function core.portal_revoke_guest_links(p_scope jsonb)
returns integer language plpgsql as $$
declare v_n int;
begin
  update core.portal_links set revoked_at = now()
   where app = 'guests' and revoked_at is null and scope->>'guest_id' = p_scope->>'guest_id' and scope->>'reservation_id' = p_scope->>'reservation_id';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

create or replace function public.core_portal_find_user(p_app text, p_scope jsonb, p_email text) returns uuid
language sql security definer set search_path = '' as $$ select core.portal_find_user(p_app, p_scope, p_email) $$;
create or replace function public.core_portal_revoke_guest_links(p_scope jsonb) returns integer
language sql security definer set search_path = '' as $$ select core.portal_revoke_guest_links(p_scope) $$;

do $$
declare f text;
begin
  foreach f in array array['core.portal_find_user(text, jsonb, text)', 'core.portal_revoke_guest_links(jsonb)',
                           'public.core_portal_find_user(text, jsonb, text)', 'public.core_portal_revoke_guest_links(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
