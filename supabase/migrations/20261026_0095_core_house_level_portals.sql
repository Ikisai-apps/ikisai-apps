-- Ikisai Core · el nivel de casa abre todas las puertas (decisión de VG, 26-10-2026, accesos; RELEVO-001).
--   1. core.house_level_roles: dirección es owner de las apps internas (Flow incluida) y entra en los portales con el
--      ámbito «todos»; staff es editor de Tasks, Food y Flow; outsider, outsider también en Flow.
--   2. core.apply_house_level: en un portal, el nivel dirección concede scopes.grants = [{"all": true}].
--   3. core.portal_in_scope: la entrada {"all": true} vale para cualquier reserva; en Guests solo para las lecturas del
--      retiro (sin huésped): con un huésped concreto hace falta el par exacto, así dirección actúa solo como ella misma.
--   4. core.sso_touch: alarga el pase común al refrescar la sesión (K9 de Organizers), no solo al cambiar de app.

insert into core.house_level_roles (level, app, role) values
  ('direccion', 'tasks', 'owner'), ('direccion', 'booking', 'owner'), ('direccion', 'food', 'owner'),
  ('direccion', 'invoices', 'owner'), ('direccion', 'central', 'owner'), ('direccion', 'flow', 'owner'),
  ('direccion', 'guests', 'editor'), ('direccion', 'organizers', 'editor'),
  ('staff', 'tasks', 'editor'), ('staff', 'food', 'editor'), ('staff', 'flow', 'editor'),
  ('outsider', 'flow', 'outsider')
on conflict do nothing;

-- Ámbito «todos» de un portal: una entrada {"all": true} en scopes.grants.
create or replace function core.portal_all_grant(p_scopes jsonb) returns boolean language sql immutable as $$
  select exists (select 1 from jsonb_array_elements(coalesce(p_scopes -> 'grants', '[]'::jsonb)) g where (g ->> 'all')::boolean is true)
$$;

create or replace function core.portal_in_scope(p_portal text, p_actor uuid, p_reservation uuid, p_guest uuid default null)
returns boolean language sql stable as $$
  select p_reservation is not null and exists (
    select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
     where m.app = p_portal and m.user_id = p_actor
       and (((g ->> 'all')::boolean is true and (p_portal <> 'guests' or p_guest is null))
            or (g ->> 'reservation_id' = p_reservation::text
                and (p_portal <> 'guests' or (p_guest is not null and g ->> 'guest_id' = p_guest::text)))));
$$;

create or replace function core.apply_house_level(p_user uuid, p_level text, p_actor uuid default null)
returns jsonb language plpgsql as $$
declare g core.house_grants; r core.house_level_roles; v_current text; v_changes jsonb := '[]'::jsonb; v_portal boolean; v_prev text;
begin
  if p_user is null then return v_changes; end if;
  select level into v_prev from core.house_levels where user_id = p_user;
  if p_level is not null and p_level not in ('direccion', 'staff', 'outsider') then perform core.fail('INVALID_HOUSE_LEVEL', 422, jsonb_build_object('level', p_level)); end if;
  if coalesce((select kind from core.profiles where user_id = p_user), 'human') = 'agent' then return v_changes; end if;

  for g in select * from core.house_grants where user_id = p_user for update loop
    -- Mismo nivel y misma concesión: se deja como está.
    if g.level = p_level and exists (select 1 from core.house_level_roles where level = p_level and app = g.app and role = g.role) then continue; end if;
    select role into v_current from core.memberships where app = g.app and user_id = p_user;
    if v_current = g.role and g.previous_role is distinct from g.role then
      if g.previous_role is null then
        delete from core.memberships where app = g.app and user_id = p_user;
      else
        update core.memberships set role = g.previous_role, updated_at = now(), revision = revision + 1 where app = g.app and user_id = p_user;
      end if;
      perform core.log_access(g.app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', g.previous_role, 'removed', g.previous_role is null, 'by', 'house_level'));
      v_changes := v_changes || jsonb_build_object('app', g.app, 'from', g.role, 'to', g.previous_role);
    end if;
    -- Al dejar de ser dirección, el ámbito «todos» de un portal se retira aunque la pertenencia siga por otra vía.
    if g.level = 'direccion' and exists (select 1 from core.apps where id = g.app and kind = 'portal') then
      update core.memberships set scopes = jsonb_set(coalesce(scopes, '{}'::jsonb), '{grants}',
        coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(scopes -> 'grants', '[]'::jsonb)) x where (x ->> 'all')::boolean is not true), '[]'::jsonb)),
        updated_at = now(), revision = revision + 1
      where app = g.app and user_id = p_user and core.portal_all_grant(scopes);
    end if;
    delete from core.house_grants where user_id = p_user and app = g.app;
  end loop;

  -- Quien deja de ser dirección pierde el ámbito «todos» de los portales, tuviera la pertenencia por el nivel o por otra vía.
  if v_prev = 'direccion' and p_level is distinct from 'direccion' then
    update core.memberships m set scopes = jsonb_set(coalesce(m.scopes, '{}'::jsonb), '{grants}',
      coalesce((select jsonb_agg(x) from jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) x where (x ->> 'all')::boolean is not true), '[]'::jsonb)),
      updated_at = now(), revision = revision + 1
    where m.user_id = p_user and core.portal_all_grant(m.scopes) and exists (select 1 from core.apps a where a.id = m.app and a.kind = 'portal');
  end if;
  if p_level is null then
    delete from core.house_levels where user_id = p_user;
    return v_changes;
  end if;
  insert into core.house_levels (user_id, level) values (p_user, p_level)
  on conflict (user_id) do update set level = excluded.level, updated_at = now() where core.house_levels.level is distinct from excluded.level;

  for r in select * from core.house_level_roles where level = p_level loop
    v_portal := exists (select 1 from core.apps where id = r.app and kind = 'portal');
    if exists (select 1 from core.house_grants where user_id = p_user and app = r.app) then continue; end if;
    select role into v_current from core.memberships where app = r.app and user_id = p_user;
    if v_current is null then
      insert into core.profiles (user_id, display_name) values (p_user, '') on conflict (user_id) do nothing;
      insert into core.memberships (app, user_id, role, scopes)
      values (r.app, p_user, r.role, case when v_portal and p_level = 'direccion' then '{"grants": [{"all": true}]}'::jsonb else null end);
    elsif core.role_rank(v_current) < core.role_rank(r.role) then
      update core.memberships set role = r.role, updated_at = now(), revision = revision + 1 where app = r.app and user_id = p_user;
    else
      -- Ya tenía ese rol o uno mayor: a dirección se le añade igualmente el ámbito «todos» del portal.
      if v_portal and p_level = 'direccion' and not core.portal_all_grant((select scopes from core.memberships where app = r.app and user_id = p_user)) then
        update core.memberships set scopes = jsonb_set(coalesce(scopes, '{}'::jsonb), '{grants}', coalesce(scopes -> 'grants', '[]'::jsonb) || '{"all": true}'::jsonb),
          updated_at = now(), revision = revision + 1 where app = r.app and user_id = p_user;
        v_changes := v_changes || jsonb_build_object('app', r.app, 'from', v_current, 'to', v_current, 'scope', 'all');
      end if;
      continue;
    end if;
    if v_portal and p_level = 'direccion' and not core.portal_all_grant((select scopes from core.memberships where app = r.app and user_id = p_user)) then
      update core.memberships set scopes = jsonb_set(coalesce(scopes, '{}'::jsonb), '{grants}', coalesce(scopes -> 'grants', '[]'::jsonb) || '{"all": true}'::jsonb)
      where app = r.app and user_id = p_user;
    end if;
    insert into core.house_grants (user_id, app, level, role, previous_role) values (p_user, r.app, p_level, r.role, v_current);
    perform core.log_access(r.app, p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'role', r.role, 'by', 'house_level'));
    v_changes := v_changes || jsonb_build_object('app', r.app, 'from', v_current, 'to', r.role);
  end loop;
  return v_changes;
end $$;

-- El pase común se alarga también al refrescar la sesión dentro de una app (hasta ahora solo al cambiar de app).
create or replace function core.sso_touch(p_digest text, p_days int default 30)
returns boolean language plpgsql as $$
declare v_pass core.sso_passes;
begin
  select * into v_pass from core.sso_passes where digest = p_digest;
  if v_pass.id is null or v_pass.revoked_at is not null or v_pass.expires_at < now() then return false; end if;
  update core.sso_passes set last_used_at = now(), expires_at = greatest(expires_at, now() + make_interval(days => greatest(1, least(p_days, 90)))) where id = v_pass.id;
  return true;
end $$;
create or replace function public.core_sso_touch(p_digest text, p_days int default 30) returns boolean
language sql security definer set search_path = '' as $$ select core.sso_touch(p_digest, p_days) $$;

revoke all on function core.portal_all_grant(jsonb) from public, anon, authenticated;
revoke all on function core.sso_touch(text, int) from public, anon, authenticated;
revoke all on function public.core_sso_touch(text, int) from public, anon, authenticated;
grant execute on function public.core_sso_touch(text, int) to service_role;
grant execute on function core.portal_all_grant(jsonb) to service_role;

