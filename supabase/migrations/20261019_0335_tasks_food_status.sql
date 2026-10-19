-- Ikisai Tasks · estado de los avisos de máquina de Food (docs/tasks/API.md §22.3; petición de Food por Core, 19-10-2026).
-- Toca solo el schema tasks. Food quiere que su recorrido de Maquinaria diga «En reparación» solo si la petición sigue en
-- curso en Tasks. Se copia tasks.requests_status de 0316 con un caso más: admite las referencias de los avisos de máquina
-- de Food, `food:equipment_fault:<id de la máquina>:<AAAA-MM-DD>`, y ninguna otra de `food:`. Sigue siendo solo estados,
-- sin títulos ni notas, y solo para la ruta de worker.

create or replace function tasks.requests_status(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_refs jsonb := coalesce(p->'args'->'externalRefs', '[]'::jsonb);
  v_out jsonb;
begin
  if jsonb_typeof(v_refs) <> 'array' or jsonb_array_length(v_refs) > 200
     or exists (select 1 from jsonb_array_elements(v_refs) x where jsonb_typeof(x) <> 'string'
                or (x #>> '{}') !~ '^((feedback|booking|core|invoices):.{1,150}|food:equipment_fault:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}:[0-9]{4}-[0-9]{2}-[0-9]{2})$') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'externalRefs: up to 200 references of source feedback, booking, core or invoices, or food:equipment_fault:<id>:<day>'));
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

revoke all on function tasks.requests_status(jsonb) from public, anon, authenticated;
grant execute on function tasks.requests_status(jsonb) to service_role;
