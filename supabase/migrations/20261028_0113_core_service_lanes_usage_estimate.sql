-- 0113 · Dos piezas del 27-10 (tarde):
--   A. Avance en Flow (AVANCE_EN_FLOW.md; VG: «lo lanzas ya»): cada cuenta de servicio tiene pertenencia en Flow como editor con
--      `scopes.lanes` = su carril del tablero «Avance por aplicaciones», y aparecen las cuentas que faltaban (guests, tasks,
--      central, uikit, core_ops). Core y Core Ops escriben en todos los carriles (coordinan y pasan pr ↔ hecho).
--      `register_service_actor` guarda los `scopes` de cada pertenencia y `core.sync_service_grants()` repasa las ya registradas.
--   B. Estimado de utilidad por app (decisión de VG, vg-39): Dirección decide en Central, pero cada app da primero su estimado.
--      `core.usage_estimate(app, items)` guarda `frequency` y `audience` de cada funcionalidad mientras Dirección no haya
--      decidido (`decided_at` nulo), y lo recuerda en `core.usage_estimates` para aplicarlo cuando la funcionalidad entre por el
--      catálogo de una publicación posterior.

-- A --------------------------------------------------------------------------------------------------------------------------
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  with lanes as (select jsonb_build_array('victor', 'core', 'core_ops', 'ui_kit', 'central', 'flow', 'food', 'finance', 'tasks', 'booking', 'guests', 'organizers') as all_lanes)
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'tasks', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('booking')))))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('organizers')))))
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'tasks', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', (select all_lanes from lanes)))))
    when 'core_ops' then jsonb_build_object('displayName', 'Core Ops (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', (select all_lanes from lanes)))))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'invoices' then jsonb_build_object('displayName', 'Finance (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'invoices', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('finance')))))
    when 'food' then jsonb_build_object('displayName', 'Food (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'food', 'role', 'editor'),
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('food')))))
    when 'flow' then jsonb_build_object('displayName', 'Flow (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('flow')))))
    when 'guests' then jsonb_build_object('displayName', 'Guests (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('guests')))))
    when 'tasks' then jsonb_build_object('displayName', 'Tasks (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('tasks')))))
    when 'central' then jsonb_build_object('displayName', 'Central (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('central')))))
    when 'uikit' then jsonb_build_object('displayName', 'UI-kit (sistema)', 'memberships', jsonb_build_array(
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('ui_kit')))))
    else null end
$$;

create or replace function core.register_service_actor(p_user uuid, p_name text)
returns uuid language plpgsql as $$
declare v_grants jsonb := core.service_grants(p_name); v_existing uuid := core.service_actor(p_name); v_m jsonb;
begin
  if v_grants is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown service', 'service', p_name)); end if;
  if v_existing is not null then return v_existing; end if;
  if exists (select 1 from core.profiles where user_id = p_user and kind <> 'service') or exists (select 1 from core.memberships where user_id = p_user) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'user already in use'));
  end if;
  insert into core.profiles (user_id, display_name, kind, service_name) values (p_user, v_grants->>'displayName', 'service', p_name)
  on conflict (user_id) do update set display_name = excluded.display_name, kind = 'service', service_name = excluded.service_name;
  for v_m in select * from jsonb_array_elements(v_grants->'memberships') loop
    insert into core.memberships (app, user_id, role, scopes) values (v_m->>'app', p_user, v_m->>'role', v_m->'scopes')
    on conflict (app, user_id) do update set scopes = coalesce(excluded.scopes, core.memberships.scopes), updated_at = now();
  end loop;
  perform core.log_access('central', null, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', 'service_registered', 'service', p_name));
  return p_user;
end $$;

-- Repasa las cuentas de servicio ya registradas: añade las pertenencias que falten y pone al día sus scopes. Nunca baja un owner.
create or replace function core.sync_service_grants() returns int language plpgsql as $$
declare r record; v_m jsonb; n int := 0;
begin
  for r in select p.user_id, p.service_name from core.profiles p where p.kind = 'service' and p.service_name is not null loop
    for v_m in select * from jsonb_array_elements(coalesce(core.service_grants(r.service_name)->'memberships', '[]'::jsonb)) loop
      insert into core.memberships (app, user_id, role, scopes) values (v_m->>'app', r.user_id, v_m->>'role', v_m->'scopes')
      on conflict (app, user_id) do update set
        role = case when core.memberships.role = 'owner' then 'owner' else excluded.role end,
        scopes = coalesce(excluded.scopes, core.memberships.scopes), updated_at = now();
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
select core.sync_service_grants();

-- B --------------------------------------------------------------------------------------------------------------------------
create table if not exists core.usage_estimates (
  app text not null references core.apps(id),
  feature_id text not null,
  frequency text check (frequency in ('frequent', 'normal', 'occasional', 'rare_critical', 'do_not_evaluate')),
  audience jsonb,
  updated_at timestamptz not null default now(),
  primary key (app, feature_id)
);
alter table core.usage_estimates enable row level security;
revoke all on core.usage_estimates from public, anon, authenticated;
grant all on core.usage_estimates to service_role;

-- Aplica un estimado a una funcionalidad si Dirección no ha decidido. `audience` se funde con la que haya (admite claves nuevas,
-- p. ej. {"kinds": ["guests", "visitors"]} para apps cuyo público no son equipos de Central).
create or replace function core.apply_usage_estimate(p_app text, p_feature_id text) returns boolean language plpgsql as $$
declare e core.usage_estimates;
begin
  select * into e from core.usage_estimates where app = p_app and feature_id = p_feature_id;
  if not found then return false; end if;
  update core.usage_features set
    frequency = coalesce(e.frequency, frequency),
    audience = case when e.audience is not null then coalesce(audience, '{}'::jsonb) || e.audience else audience end,
    updated_at = now()
  where app = p_app and feature_id = p_feature_id and decided_at is null;
  return found;
end $$;

-- Desde la migración de la app: core.usage_estimate('guests', '[{"id": "guests.alojate.firmar", "frequency": "frequent", "audience": {"kinds": ["guests"]}}]').
create or replace function core.usage_estimate(p_app text, p_items jsonb) returns int language plpgsql as $$
declare v jsonb; n int := 0;
begin
  if p_app is null or jsonb_typeof(p_items) <> 'array' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'usage_estimate needs app and an array of items'));
  end if;
  for v in select * from jsonb_array_elements(p_items) loop
    if v->>'id' is null or split_part(v->>'id', '.', 1) <> p_app then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'feature id must start with its app', 'id', v->>'id'));
    end if;
    insert into core.usage_estimates (app, feature_id, frequency, audience)
    values (p_app, v->>'id', nullif(v->>'frequency', ''), v->'audience')
    on conflict (app, feature_id) do update set frequency = coalesce(excluded.frequency, core.usage_estimates.frequency),
      audience = coalesce(excluded.audience, core.usage_estimates.audience), updated_at = now();
    if core.apply_usage_estimate(p_app, v->>'id') then n := n + 1; end if;
  end loop;
  return n;
end $$;

-- Cuando una funcionalidad entra por el catálogo de una publicación posterior, recibe el estimado guardado.
create or replace function core.usage_features_estimate_trg() returns trigger language plpgsql as $$
begin
  perform core.apply_usage_estimate(new.app, new.feature_id);
  return null;
end $$;
drop trigger if exists usage_features_estimate on core.usage_features;
create trigger usage_features_estimate after insert on core.usage_features for each row execute function core.usage_features_estimate_trg();

do $$
declare f text;
begin
  foreach f in array array['core.service_grants(text)', 'core.register_service_actor(uuid, text)', 'core.sync_service_grants()',
                           'core.apply_usage_estimate(text, text)', 'core.usage_estimate(text, jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
