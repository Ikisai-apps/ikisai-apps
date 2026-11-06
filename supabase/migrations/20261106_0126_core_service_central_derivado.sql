-- 0126 · Corrige la 0125: la pertenencia a un módulo (resources) no se concede a mano, se deriva de las apps fuente (0091,
-- trigger memberships_reject_module). El servicio «Central (sistema)» pasa a ser editor de Central y hereda Recursos porque
-- Central es fuente del módulo. register_service_actor y sync_service_grants ignoran concesiones directas a módulos.

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
      jsonb_build_object('app', 'flow', 'role', 'editor', 'scopes', jsonb_build_object('lanes', jsonb_build_array('central'))),
      -- 0126: editor en Central; el acceso a Recursos se DERIVA (0091: central es fuente del módulo), nunca se da a mano.
      jsonb_build_object('app', 'central', 'role', 'editor')))
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
    -- 0126: la pertenencia a un módulo (resources) se deriva de las apps fuente; una concesión directa se ignora.
    if exists (select 1 from core.apps where id = v_m->>'app' and kind = 'module') then continue; end if;
    insert into core.memberships (app, user_id, role, scopes) values (v_m->>'app', p_user, v_m->>'role', v_m->'scopes')
    on conflict (app, user_id) do update set scopes = coalesce(excluded.scopes, core.memberships.scopes), updated_at = now();
  end loop;
  perform core.log_access('central', null, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', 'service_registered', 'service', p_name));
  return p_user;
end $$;

create or replace function core.sync_service_grants() returns int language plpgsql as $$
declare r record; v_m jsonb; n int := 0;
begin
  for r in select p.user_id, p.service_name from core.profiles p where p.kind = 'service' and p.service_name is not null loop
    for v_m in select * from jsonb_array_elements(coalesce(core.service_grants(r.service_name)->'memberships', '[]'::jsonb)) loop
      if exists (select 1 from core.apps where id = v_m->>'app' and kind = 'module') then continue; end if;
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
