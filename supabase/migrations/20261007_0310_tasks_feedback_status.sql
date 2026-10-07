-- Ikisai Tasks · puente con Feedback, estado (docs/tasks/API.md §22.3; coordinacion/ampliacion/FEEDBACK.md §2.6).
-- Toca solo el schema tasks. tasks.requests_status: el estado de las peticiones de sistema (Feedback y Booking) por su referencia,
-- para que el worker de Feedback de Core copie «hecha» a sus reportes. Acción de sistema: solo la lanza la ruta de
-- worker `worker/requests/status` (clave IKISAI_WORKER_KEY), nunca una persona ni un agente. Solo lectura y solo
-- estados: ni títulos ni notas.
create or replace function tasks.requests_status(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_refs jsonb := coalesce(p->'args'->'externalRefs', '[]'::jsonb);
  v_out jsonb;
begin
  if jsonb_typeof(v_refs) <> 'array' or jsonb_array_length(v_refs) > 200
     or exists (select 1 from jsonb_array_elements(v_refs) x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^(feedback|booking):.{1,150}$') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'externalRefs: up to 200 references of source feedback or booking'));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'externalRef', ref,
      -- pending: por clasificar · open: tarea abierta · done: hecha · dismissed: descartada · deleted: en la papelera o
      -- purgada · unknown: Tasks no la conoce (aún no ha llegado o se perdió).
      'status', case
        when rq.id is null and t.id is null then 'unknown'
        when rq.status = 'pending' then 'pending'
        when rq.status = 'dismissed' then 'dismissed'
        when t.id is null or t.deleted_at is not null then 'deleted'
        when tasks.task_done(t.id) then 'done'
        else 'open' end,
      'taskId', t.id,
      'doneAt', case when t.id is not null and t.deleted_at is null and tasks.task_done(t.id) then t.done_at end,
      'updatedAt', greatest(rq.updated_at, t.updated_at)) order by ref), '[]'::jsonb)
    into v_out
    from (select distinct x #>> '{}' ref from jsonb_array_elements(v_refs) x) refs
    left join tasks.requests rq on rq.external_ref = refs.ref and rq.deleted_at is null
    left join lateral (select * from tasks.tasks tk where tk.external_ref = refs.ref order by tk.deleted_at nulls first limit 1) t on true;
  return jsonb_build_object('items', v_out);
end $$;

-- Acción sin roles de persona (`{}`) y sin confirmación de agente: solo la ejecuta el worker como sistema.
select core.allow_read('tasks', 'tasks.requests_status', 'action', '{}', false);

revoke all on function tasks.requests_status(jsonb) from public, anon, authenticated;
grant execute on function tasks.requests_status(jsonb) to service_role;
