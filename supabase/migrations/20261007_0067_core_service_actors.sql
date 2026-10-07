-- Ikisai Core · identidades de servicio (petición de Tasks para el puente del feedback, FEEDBACK.md §2.4).
-- Un servicio interno (hoy solo `feedback`) escribe en otra app con core.commit, para que quede en core.changes, los espejos
-- y el historial, con una cuenta propia y visible («Feedback (sistema)»), nunca suplantando a una persona.
-- La cuenta de Auth la crea el kit bajo demanda (sin contraseña utilizable); aquí solo se registra y se le dan sus accesos.

alter table core.profiles drop constraint if exists profiles_kind_check;
alter table core.profiles add constraint profiles_kind_check check (kind in ('human','agent','service'));
alter table core.profiles add column if not exists service_name text unique check (service_name is null or service_name ~ '^[a-z][a-z0-9_]{1,30}$');

-- Servicios permitidos y sus accesos. Añadir uno es una migración core nueva.
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    else null end
$$;

create or replace function core.service_actor(p_name text)
returns uuid language sql stable as $$
  select user_id from core.profiles where service_name = p_name and kind = 'service'
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
    insert into core.memberships (app, user_id, role) values (v_m->>'app', p_user, v_m->>'role') on conflict (app, user_id) do nothing;
  end loop;
  perform core.log_access('central', null, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', 'service_registered', 'service', p_name));
  return p_user;
end $$;

create or replace function public.core_service_actor(p_name text) returns uuid
language sql security definer set search_path = '' as $$ select core.service_actor(p_name) $$;
create or replace function public.core_register_service_actor(p_user uuid, p_name text) returns uuid
language sql security definer set search_path = '' as $$ select core.register_service_actor(p_user, p_name) $$;

do $$
declare f text;
begin
  foreach f in array array['core.service_grants(text)', 'core.service_actor(text)', 'core.register_service_actor(uuid, text)',
                           'public.core_service_actor(text)', 'public.core_register_service_actor(uuid, text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

-- El worker del feedback (central-api) solo se despierta si hay algo que enrutar o tareas abiertas que seguir.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-feedback-tick', '*/5 * * * *', $c$select core.worker_tick('central', 'feedback/tick')
      where exists (select 1 from core.feedback_reports where routing_status in ('pending','error') and status = 'open')
         or exists (select 1 from core.feedback_task_links l join core.feedback_reports r on r.id = l.report_id
                     where r.status = 'open' and l.task_id is not null and l.task_status is distinct from 'done')$c$)$q$;
  end if;
end $$;
