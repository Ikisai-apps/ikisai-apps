-- Ikisai Tasks · tareas de Core para el usuario (docs/tasks/API.md §25; decisión del usuario del 8-10-2026).
-- Toca solo el schema tasks. `worker/requests/task` acepta `source: 'core'` (`core.user_task`); si Core reenvía la misma
-- referencia con otro título o nota, tasks.refresh_request_task actualiza la tarea mientras siga abierta.
-- Solo la identidad de servicio que la pidió (la referencia empieza por su nombre) y solo título y nota. Sin cambios, no
-- escribe nada (ni historial). Una petición aún pendiente en «Por clasificar» no se toca: se queda con el texto inicial.
-- tasks.requests_status y tasks.service_actor (copiadas de 0310 y 0311) admiten también `core`. Su identidad de servicio
-- (`core.service_grants`) la registra una migración de Core.

create or replace function tasks.refresh_request_task(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_actor uuid := (p->>'actor')::uuid;
  v_ref text := v_args->>'externalRef';
  v_title text := btrim(coalesce(v_args->>'title', ''));
  v_note text := v_args->>'note';
  v_service text;
  t record;
begin
  select pr.service_name into v_service from core.profiles pr where pr.user_id = v_actor and pr.kind = 'service';
  if v_service is null or v_ref is null or left(v_ref, length(v_service) + 1) <> v_service || ':' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only the service that asked for it'));
  end if;
  if length(v_title) < 1 or length(v_title) > 1000 or (v_note is not null and length(v_note) > 1000) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'title 1-1000, note up to 1000'));
  end if;
  select * into t from tasks.tasks where external_ref = v_ref and deleted_at is null limit 1;
  if not found or tasks.task_done(t.id) then return jsonb_build_object('updated', false, 'reason', 'not_open'); end if;
  v_note := coalesce(v_note, t.note);
  if t.title = v_title and t.note = v_note then return jsonb_build_object('updated', false, 'reason', 'unchanged'); end if;
  perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', t.id,
    'expectedRevision', t.revision, 'fields', jsonb_build_object('title', v_title, 'note', v_note)));
  return jsonb_build_object('updated', true, 'taskId', t.id);
end $$;

select core.allow_procedure('tasks', 'tasks.refresh_request_task');

create or replace function tasks.requests_status(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_refs jsonb := coalesce(p->'args'->'externalRefs', '[]'::jsonb);
  v_out jsonb;
begin
  if jsonb_typeof(v_refs) <> 'array' or jsonb_array_length(v_refs) > 200
     or exists (select 1 from jsonb_array_elements(v_refs) x where jsonb_typeof(x) <> 'string' or (x #>> '{}') !~ '^(feedback|booking|core):.{1,150}$') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'externalRefs: up to 200 references of source feedback, booking or core'));
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

create or replace function tasks.service_actor(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_name text := p->'args'->>'name';
  v_actor uuid;
begin
  if v_name is null or v_name not in ('feedback', 'booking', 'core') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown service'));
  end if;
  execute 'select pr.user_id from core.profiles pr join core.memberships m on m.user_id = pr.user_id and m.app = ''tasks''
           where pr.kind = ''service'' and pr.service_name = $1 limit 1' into v_actor using v_name;
  return jsonb_build_object('actor', v_actor);
exception when undefined_column then
  return jsonb_build_object('actor', null);
end $$;

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
