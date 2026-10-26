-- Ikisai Core · escrituras públicas sin sesión (Flow, FLOW-DIR-001 §1: el público envía su pedido sin cuenta).
-- Simétrico a las lecturas públicas (0079): la app registra las tablas que admiten escrituras públicas y la Edge
-- (service_role), tras validar lo que haga falta (la credencial anónima del cliente), aplica el lote con el actor de
-- servicio de la app («Flow (sistema)»), con lote propio, hooks de validación y core.changes como core.commit.
-- Solo filas (insert y update), nunca `call`; como mucho 50 operaciones. Lo que un lote público puede hacer lo limita la
-- app con sus hooks y disparadores, preguntando core.is_public_batch().

create table core.public_writes (
  app text not null references core.apps(id),
  table_name text not null check (table_name ~ '^[a-z]+\.[a-z_]+$'),
  primary key (app, table_name)
);
alter table core.public_writes enable row level security;
revoke all on core.public_writes from public, anon, authenticated;
grant all on core.public_writes to service_role;

create or replace function core.allow_public_write(p_app text, p_table text)
returns void language sql as $$
  insert into core.public_writes (app, table_name) values (p_app, p_table) on conflict do nothing;
$$;

-- Para los hooks y disparadores de las apps (el lint no deja leer los GUC del núcleo fuera de core).
create or replace function core.is_public_batch() returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('core.public', true), ''), 'off') = 'on'
$$;
create or replace function core.current_role() returns text language sql stable as $$
  select nullif(current_setting('core.role', true), '')
$$;

create or replace function core.apply_public_operations(p_app text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := core.service_actor(p_app);
  v_cursor bigint; v_next bigint; v_results jsonb; v_op jsonb;
  v_request text := 'public:' || p_app || ':' || gen_random_uuid();
begin
  if not exists (select 1 from core.public_writes where app = p_app) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'app has no public writes', 'app', p_app));
  end if;
  if v_actor is null then perform core.fail('SERVICE_NOT_READY', 503, jsonb_build_object('service', p_app)); end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 or jsonb_array_length(p_operations) > 50 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array of 1 to 50'));
  end if;
  for v_op in select * from jsonb_array_elements(p_operations) loop
    if coalesce(v_op->>'op', '') not in ('insert', 'update') then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'public batches take insert and update only', 'op', v_op->>'op'));
    end if;
    if not exists (select 1 from core.public_writes where app = p_app and table_name = v_op->>'table') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'table not open to public writes', 'table', v_op->>'table'));
    end if;
  end loop;
  select cursor into v_cursor from core.app_state where app = p_app for update;
  v_next := v_cursor + 1;
  perform set_config('core.public', 'on', true);
  v_results := core.apply_operations(p_app, v_actor, 'editor', v_request, v_next, p_operations);
  perform set_config('core.public', 'off', true);
  update core.app_state set cursor = v_next where app = p_app;
  return jsonb_build_object('cursor', v_next, 'results', v_results);
exception when others then
  perform set_config('core.public', 'off', true);
  raise;
end $$;

create or replace function public.core_apply_public_operations(p_app text, p_operations jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.apply_public_operations(p_app, p_operations) $$;

revoke all on function core.allow_public_write(text, text) from public, anon, authenticated;
revoke all on function core.apply_public_operations(text, jsonb) from public, anon, authenticated;
revoke all on function public.core_apply_public_operations(text, jsonb) from public, anon, authenticated;
grant execute on function public.core_apply_public_operations(text, jsonb) to service_role;
grant execute on function core.is_public_batch() to service_role;
grant execute on function core.current_role() to service_role;

-- Flow (sistema): el actor de servicio de las escrituras públicas de Flow. Editor de su propia app.
create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'organizers' then jsonb_build_object('displayName', 'Organizers (sistema)', 'memberships', '[]'::jsonb)
    when 'core' then jsonb_build_object('displayName', 'Core (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'drive' then jsonb_build_object('displayName', 'Drive (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor'), jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'lector' then jsonb_build_object('displayName', 'Lector (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'invoices', 'role', 'editor')))
    when 'food' then jsonb_build_object('displayName', 'Food (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'food', 'role', 'editor')))
    when 'flow' then jsonb_build_object('displayName', 'Flow (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'flow', 'role', 'editor')))
    else null end
$$;
