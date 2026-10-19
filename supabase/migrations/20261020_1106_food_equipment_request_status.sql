-- Food · tanda 27: «En reparación» con el estado real de la petición en Tasks (Tasks #606, docs/tasks/API.md §22.3;
-- respuesta de Core del 20-10-2026). Toca solo el schema food; lee core.
--
-- - `food.equipment_notices.request_status`: el estado de la petición del aviso en Tasks, copiado por el worker
--   `POST /api/v1/worker/equipment/tick` (food-api) con la cuenta de servicio `food`. Nadie más lo escribe: una persona no
--   puede poner «En reparación» a mano.
--   - `open` → «En reparación»; `pending` → sigue «Avisado»;
--   - `done`, `dismissed`, `deleted` → ya no hay reparación en curso; `unknown` → el aviso no llegó (los dos, «Falla»).
-- - `food.equipment_notices_to_check`: los avisos vivos que aún pueden cambiar (sin estado, `pending` u `open`) de los
--   últimos 60 días, hasta 200 (lo que admite Tasks por llamada).
-- - El tick solo se despierta con la cuenta de servicio `food` y algo que mirar: una llamada a Tasks por vuelta.

alter table food.equipment_notices
  add column request_status text check (request_status in ('pending', 'open', 'done', 'dismissed', 'deleted', 'unknown'));

-- Solo la cuenta de servicio `food` escribe el estado (quien escribe es `updated_by`, que el núcleo pone antes por orden
-- de nombre del trigger).
create or replace function food.guard_equipment_notice_status()
returns trigger language plpgsql as $$
begin
  if new.request_status is distinct from (case when tg_op = 'INSERT' then null else old.request_status end)
     and new.updated_by is distinct from core.service_actor('food') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'food.equipment_notices', 'field', 'request_status'));
  end if;
  return new;
end $$;
create trigger food_guard_equipment_notice_status before insert or update on food.equipment_notices
  for each row execute function food.guard_equipment_notice_status();

select core.register_table('food', 'food', 'equipment_notices', array['equipment_id', 'notified_on', 'equipment_status', 'task_id', 'request_status']);

create or replace function food.equipment_notices_to_check(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_limit int := least(greatest(coalesce((a->>'limit')::int, 200), 1), 200);
  v_out jsonb;
begin
  select jsonb_agg(jsonb_build_object('id', n.id, 'revision', n.revision, 'equipment_id', n.equipment_id,
           'notified_on', to_char(n.notified_on, 'YYYY-MM-DD'), 'request_status', n.request_status) order by n.notified_on desc, n.id)
    into v_out
    from (select n.* from food.equipment_notices n
            join food.equipment e on e.id = n.equipment_id and e.deleted_at is null
           where n.deleted_at is null and (n.request_status is null or n.request_status in ('pending', 'open'))
             and n.notified_on >= current_date - 60
           order by n.notified_on desc, n.id
           limit v_limit) n;
  return jsonb_build_object('items', coalesce(v_out, '[]'::jsonb));
end $$;
select core.allow_read('food', 'food.equipment_notices_to_check', 'function', '{editor,owner}');

create or replace function food.equipment_status_has_work()
returns boolean language plpgsql stable as $$
begin
  if core.service_actor('food') is null then return false; end if;
  return jsonb_array_length(food.equipment_notices_to_check('{}'::jsonb)->'items') > 0;
end $$;

select core.schedule_tick('food', 'equipment/tick', '*/15 * * * *', 'food.equipment_status_has_work');
