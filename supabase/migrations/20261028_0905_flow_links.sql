-- Ikisai Flow · enlaces con Booking y Tasks (encargo de VG del 26-10; contratos de Booking #716 y de Tasks §39).
-- - Booking: el owner elige el evento del flujo (booking.event_projection, abierta a Flow); se guardan booking_event_id
--   (0902) y sus fechas. Con él, Booking lee el resumen del servicio (0903).
-- - Tasks: el owner elige una vez el proyecto de Tasks del flujo (projects.tasks_project_id). «Pedir a Tasks» convierte una
--   tarea de Flow en una tarea o una compra de Tasks, con la sesión de la persona (flow-api); el enlace queda en la unidad.

alter table flow.projects add column tasks_project_id uuid;
select core.register_table('flow', 'flow', 'projects', array['name','status','notes','booking_event_id','starts_on','ends_on','cover_image','test_mode','food_menu_id','tasks_project_id'], '{reader,editor,owner,outsider}', '{owner}', false);

/** Para flow-api: la tarea y su proyecto, solo si quien llama trabaja en él. args = { id } */
create or replace function flow.unit_for_tasks(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('unit', jsonb_build_object('id', u.id, 'kind', u.kind, 'label', u.label, 'priority', u.priority, 'status', u.status,
           'column_key', u.column_key, 'payload', u.payload),
         'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'tasks_project_id', pr.tasks_project_id))
    from flow.units u join flow.projects pr on pr.id = u.project_id
   where u.id = (p->'args'->>'id')::uuid and u.deleted_at is null and flow.in_scope((p->>'actor')::uuid, u.project_id)
$$;
select core.allow_read('flow', 'flow.unit_for_tasks', 'function', '{editor,owner}');

/** Anotar en una tarea el enlace con otra app. args = { unit_id, link: { app, kind, id, status? } } */
create or replace function flow.unit_link_external(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_link jsonb := p->'args'->'link';
begin
  perform flow.proc_begin();
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units')); end if;
  perform flow.check_scope(p, v.project_id);
  if v.kind <> 'task' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'only tasks link to other apps')); end if;
  if jsonb_typeof(v_link) <> 'object' or coalesce(v_link->>'app', '') !~ '^[a-z]+$' or coalesce(v_link->>'id', '') = '' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'link {app, kind, id} required'));
  end if;
  perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('payload', v.payload || jsonb_build_object('external',
    jsonb_build_object('app', v_link->>'app', 'kind', v_link->>'kind', 'id', v_link->>'id', 'status', v_link->>'status', 'at', now()))));
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'link', v_link);
end $$;
select core.allow_procedure('flow', 'flow.unit_link_external');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
