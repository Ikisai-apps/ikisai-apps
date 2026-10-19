-- Food · tanda 27 (rediseño de La Muela, MUELA-068 §4, «Recorrido con la etapa marcada»; decisión de VG del 19-10-2026):
-- el recorrido Falla · Avisado · En reparación · Funciona con datos reales. Toca solo el schema food.
--
-- - `food.equipment.status_since`: desde cuándo la máquina tiene su estado. Lo pone el servidor cuando cambia el estado
--   (no se escribe a mano). Las máquinas de antes toman su última modificación.
-- - `food.equipment_notices`: los avisos a Tasks que han salido de verdad. Lo escribe la Edge de Food al avisar
--   (`POST equipment/:id/fault`), con la tarea que devuelve Tasks: una fila por máquina y día, como la petición.
--   «Avisado» = hay un aviso desde que la máquina tiene su estado actual. Antes se proponía deducirlo de la palabra
--   «avisado» en las notas o de una fecha guardada en un solo dispositivo; ninguna de las dos es fiable.
-- - «En reparación» solo con el estado real de la petición en Tasks, que todavía no llega a Food (pedido a Core). Hasta
--   entonces el recorrido se queda en «Avisado».

alter table food.equipment add column status_since timestamptz;
update food.equipment set status_since = updated_at where status_since is null;
alter table food.equipment alter column status_since set not null;
alter table food.equipment alter column status_since set default now();

create or replace function food.equipment_status_since()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.status_since := now();
  elsif new.status is distinct from old.status then
    new.status_since := now();
  else
    new.status_since := old.status_since;
  end if;
  return new;
end $$;
create trigger food_equipment_status_since before insert or update on food.equipment
  for each row execute function food.equipment_status_since();

create table food.equipment_notices (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  equipment_id uuid not null references food.equipment(id) on delete cascade,
  notified_on date not null,
  equipment_status text not null check (equipment_status in ('limitado', 'averiado', 'fuera_de_servicio')),
  task_id text not null check (length(task_id) between 1 and 100)
);
create unique index equipment_notices_day_key on food.equipment_notices (equipment_id, notified_on) where deleted_at is null;

-- La máquina existe y está viva; el aviso no cambia de máquina ni de día.
create or replace function food.guard_equipment_notice()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (new.equipment_id <> old.equipment_id or new.notified_on <> old.notified_on) then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', case when new.equipment_id <> old.equipment_id then 'equipment_id' else 'notified_on' end));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and not exists (select 1 from food.equipment e where e.id = new.equipment_id and e.deleted_at is null) then
    perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'equipment', 'id', new.equipment_id));
  end if;
  return new;
end $$;
create trigger food_guard_equipment_notice before insert or update on food.equipment_notices
  for each row execute function food.guard_equipment_notice();

select core.register_table('food', 'food', 'equipment_notices', array['equipment_id', 'notified_on', 'equipment_status', 'task_id']);
