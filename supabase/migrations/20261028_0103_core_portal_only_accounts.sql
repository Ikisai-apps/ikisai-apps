-- 0103 · Portales: una cuenta de portal nunca es una cuenta del personal (B1 de la auditoría del 27-10).
--
-- Antes, quien emitía un enlace de portal (un editor de Booking, o un organizador con su propio enlace) podía indicar el correo
-- de alguien del personal: `portal_find_user` devolvía esa cuenta, el enlace se emitía para ella y la URL volvía a quien la pidió,
-- que al canjearla entraba como esa persona (owner en todas las apps). Ahora:
--   1. `core.is_portal_account(user)`: tiene pertenencias y todas son de portal (organizers o guests, editor con `scopes.grants`).
--   2. `portal_find_user` solo reutiliza por correo cuentas de portal; si el correo es de otra cuenta, falla con
--      PORTAL_EMAIL_STAFF (409) y la Edge no crea nada.
--   3. `portal_link_resolve` no da sesión a un enlace cuya cuenta no es de portal (los enlaces antiguos a cuentas del personal
--      dejan de valer: LINK_INVALID).

create or replace function core.is_portal_account(p_user uuid)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships m where m.user_id = p_user)
     and not exists (
       select 1 from core.memberships m
        where m.user_id = p_user
          and (m.app not in ('organizers', 'guests') or m.role <> 'editor' or jsonb_typeof(m.scopes->'grants') <> 'array')
     )
$$;

create or replace function core.portal_find_user(p_app text, p_scope jsonb, p_email text)
returns uuid language plpgsql stable as $$
declare v_user uuid;
begin
  if coalesce(p_email, '') <> '' then
    select id into v_user from auth.users where lower(email) = lower(p_email) limit 1;
    if v_user is not null then
      if not core.is_portal_account(v_user) then
        perform core.fail('PORTAL_EMAIL_STAFF', 409, jsonb_build_object('reason', 'the email belongs to a non-portal account'));
      end if;
      return v_user;
    end if;
  end if;
  if p_app = 'guests' and coalesce(p_scope->>'guest_id', '') <> '' then
    select l.user_id into v_user from core.portal_links l
     where l.app = 'guests' and l.scope->>'guest_id' = p_scope->>'guest_id' and l.scope->>'reservation_id' = p_scope->>'reservation_id'
     order by l.created_at desc limit 1;
    if v_user is not null and not core.is_portal_account(v_user) then return null; end if;
  end if;
  return v_user;
end $$;

create or replace function core.portal_link_resolve(p_app text, p_digest text)
returns jsonb language plpgsql as $$
declare v_link core.portal_links; v_until timestamptz;
begin
  select * into v_link from core.portal_links where digest = p_digest and app = p_app for update;
  if v_link.id is null or v_link.revoked_at is not null then return null; end if;
  -- Un enlace solo abre una cuenta de portal: nunca la de alguien del personal.
  if not core.is_portal_account(v_link.user_id) then return null; end if;
  v_until := core.portal_link_valid_until(v_link);
  if v_until is null or v_until < now() then return jsonb_build_object('expired', true, 'validUntil', v_until); end if;
  update core.portal_links set last_used_at = now() where id = v_link.id;
  return jsonb_build_object('userId', v_link.user_id, 'linkId', v_link.id, 'scope', v_link.scope, 'validUntil', v_until);
end $$;

-- B6: la Edge revoca los enlaces anteriores del huésped (`replace`) después de que `portal_link_issue` haya autorizado y
-- emitido el nuevo; `p_keep` conserva ese enlace recién emitido.
create or replace function core.portal_revoke_guest_links(p_scope jsonb, p_keep uuid)
returns integer language plpgsql as $$
declare v_n int;
begin
  update core.portal_links set revoked_at = now()
   where app = 'guests' and revoked_at is null and scope->>'guest_id' = p_scope->>'guest_id' and scope->>'reservation_id' = p_scope->>'reservation_id'
     and (p_keep is null or id <> p_keep);
  get diagnostics v_n = row_count;
  return v_n;
end $$;
create or replace function public.core_portal_revoke_guest_links(p_scope jsonb, p_keep uuid) returns integer
language sql security definer set search_path = '' as $$ select core.portal_revoke_guest_links(p_scope, p_keep) $$;
