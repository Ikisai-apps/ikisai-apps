-- Ikisai Flow · segundo flujo: llegadas y salidas del evento (encargo de VG del 27-10, paso 5).
-- - Comportamiento de columna `guest_presence` (config.stage: arrival | bed | signature | departure): las columnas
--   Llegada → Cama → Firma → Salida enseñan los huéspedes del evento de Booking (booking.flow_guests_projection, la lee
--   la app) y escriben la llegada y la salida por booking-api con el token de la persona (flow-api).
-- - «Cama» (acompañado a su cama) es una marca de Flow (`flow.presence_marks`): Booking no la necesita.
-- - Plantillas de flujo (`flow.template_columns`) y `flow.create_flow`: el check-in nace de la plantilla `checkin`; el
--   editor de flujos (paso 6) las ampliará.
-- La barra (v1 y v2) no cambia.

-- Una versión de plantilla, una vez por evento (antes, una vez en total): hay un flujo de llegadas por evento. La barra
-- no cambia (sus versiones las numera «Nueva versión» sobre todas las de la plantilla).
drop index flow.projects_template_version_uidx;
create unique index projects_template_version_uidx on flow.projects (template_key, template_version, coalesce(booking_event_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where deleted_at is null and template_key is not null;

alter table flow.columns drop constraint columns_behavior_check;
alter table flow.columns add constraint columns_behavior_check check (behavior in ('inspect_confirm','quick_steps','free_task','guest_presence'));

-- ---------------------------------------------------------------------------
-- Plantillas de columnas
-- ---------------------------------------------------------------------------
create table flow.template_columns (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  template_key text not null check (template_key ~ '^[a-z][a-z0-9_]{1,30}$'),
  version integer not null default 1 check (version >= 1),
  label_base text not null check (length(label_base) between 1 and 80),
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (length(label) between 1 and 60),
  behavior text not null check (behavior in ('inspect_confirm','quick_steps','free_task','guest_presence')),
  config jsonb not null default '{}'::jsonb,
  position integer not null default 0
);
create unique index template_columns_uidx on flow.template_columns (template_key, version, key) where deleted_at is null;
select core.register_table('flow', 'flow', 'template_columns', array['template_key','version','label_base','key','label','behavior','config','position'], '{owner}', '{owner}', true);
insert into flow.template_columns (template_key, version, label_base, key, label, behavior, config, position) values
  ('checkin', 1, 'Llegadas', 'arrival',   'Llegada', 'guest_presence', '{"stage": "arrival"}'::jsonb,   1),
  ('checkin', 1, 'Llegadas', 'bed',       'Cama',    'guest_presence', '{"stage": "bed"}'::jsonb,       2),
  ('checkin', 1, 'Llegadas', 'signature', 'Firma',   'guest_presence', '{"stage": "signature"}'::jsonb, 3),
  ('checkin', 1, 'Llegadas', 'departure', 'Salida',  'guest_presence', '{"stage": "departure"}'::jsonb, 4);

-- Nuevo flujo desde una plantilla (la última versión). Solo el owner.
-- args = { template_key, project_id (uuid del cliente), name?, booking_event_id?, starts_on?, ends_on? }
create or replace function flow.create_flow(p jsonb) returns jsonb language plpgsql as $$
declare
  v_id uuid := flow.arg_uuid(p, 'project_id'); v_key text := p->'args'->>'template_key'; v_version int; v_base text; v_name text;
  v_event uuid; v_t flow.template_columns;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a new flow is for the owner')); end if;
  select max(version) into v_version from flow.template_columns where template_key = v_key and deleted_at is null;
  if v_version is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.template_columns', 'template_key', v_key)); end if;
  select label_base into v_base from flow.template_columns where template_key = v_key and version = v_version and deleted_at is null limit 1;
  v_name := coalesce(nullif(btrim(p->'args'->>'name'), ''), v_base || ' · v' || v_version);
  if length(v_name) > 120 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'name too long')); end if;
  if coalesce(p->'args'->>'booking_event_id', '') <> '' then v_event := flow.arg_uuid(p, 'booking_event_id'); end if;
  perform flow.ins(p, 'flow.projects', jsonb_build_object('name', v_name, 'status', 'active', 'template_key', v_key, 'template_version', v_version,
    'booking_event_id', v_event, 'starts_on', nullif(p->'args'->>'starts_on', ''), 'ends_on', nullif(p->'args'->>'ends_on', '')), v_id);
  for v_t in select * from flow.template_columns where template_key = v_key and version = v_version and deleted_at is null order by position loop
    perform flow.ins(p, 'flow.columns', jsonb_build_object('project_id', v_id, 'key', v_t.key, 'label', v_t.label, 'behavior', v_t.behavior,
      'position', v_t.position, 'config', v_t.config));
  end loop;
  perform flow.proc_end();
  return jsonb_build_object('project_id', v_id, 'name', v_name, 'template_key', v_key, 'template_version', v_version);
end $$;

-- ---------------------------------------------------------------------------
-- Marcas de Flow por huésped (hoy, «Cama»: acompañado a su cama)
-- ---------------------------------------------------------------------------
create table flow.presence_marks (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  project_id uuid not null references flow.projects(id),
  guest_id uuid not null,
  step text not null check (step in ('bed')),
  done_at timestamptz not null default now(),
  done_by uuid references auth.users(id)
);
create unique index presence_marks_uidx on flow.presence_marks (project_id, guest_id, step) where deleted_at is null;
select core.register_table('flow', 'flow', 'presence_marks', array['project_id','guest_id','step','done_at','done_by'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

create or replace function flow.guard_marks() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
end $$;
create trigger flow_guard before insert or update on flow.presence_marks for each row execute function flow.guard_marks();
create trigger flow_scope before insert or update on flow.presence_marks for each row execute function flow.guard_scope();

-- Marcar (o deshacer) un paso de Flow de un huésped. args = { project_id, guest_id, step, undo? }
create or replace function flow.mark_presence(p jsonb) returns jsonb language plpgsql as $$
declare
  v_project uuid := flow.arg_uuid(p, 'project_id'); v_guest uuid := flow.arg_uuid(p, 'guest_id'); v_step text := p->'args'->>'step';
  v_undo boolean := coalesce((p->'args'->>'undo')::boolean, false); v_m flow.presence_marks;
begin
  perform flow.proc_begin();
  perform flow.check_scope(p, v_project);
  if not exists (select 1 from flow.columns where project_id = v_project and deleted_at is null and behavior = 'guest_presence' and config->>'stage' = v_step) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow has no such step', 'step', v_step));
  end if;
  select * into v_m from flow.presence_marks where project_id = v_project and guest_id = v_guest and step = v_step and deleted_at is null for update;
  if v_undo then
    if v_m.id is not null then perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.presence_marks', 'id', v_m.id, 'expectedRevision', v_m.revision)); end if;
  elsif v_m.id is null then
    perform flow.ins(p, 'flow.presence_marks', jsonb_build_object('project_id', v_project, 'guest_id', v_guest, 'step', v_step, 'done_at', now(),
      'done_by', (p->>'actor')::uuid));
  end if;
  perform flow.proc_end();
  return jsonb_build_object('guest_id', v_guest, 'step', v_step, 'done', not v_undo);
end $$;

-- Para flow-api (llegada y salida): el evento de Booking de un flujo con columnas de presencia, si está en el ámbito.
-- args = { project_id }
create or replace function flow.checkin_target(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('project_id', pr.id, 'booking_event_id', pr.booking_event_id)
    from flow.projects pr
   where pr.id = (p->'args'->>'project_id')::uuid and pr.deleted_at is null
     and flow.in_scope((p->>'actor')::uuid, pr.id)
     and exists (select 1 from flow.columns c where c.project_id = pr.id and c.deleted_at is null and c.behavior = 'guest_presence')
$$;

select core.allow_procedure('flow', 'flow.create_flow');
select core.allow_procedure('flow', 'flow.mark_presence');
select core.allow_read('flow', 'flow.checkin_target', 'function', '{editor,owner}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
