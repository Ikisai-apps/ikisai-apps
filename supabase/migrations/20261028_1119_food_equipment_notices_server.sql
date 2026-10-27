-- Food · los avisos de avería solo los escribe el servidor (auditoría de seguridad de Tasks del 27-10-2026, FO3;
-- MUELA/equipo/feedback/seguridad/AUDITORIA_RUTAS_27-10.md). Toca solo el schema food; lee core.
--
-- Cualquier editor de Food podía insertar en `food.equipment_notices` un aviso con cualquier `task_id`: la máquina salía
-- «Avisado» sin aviso real, y el de verdad chocaba con el índice único del día. Ahora solo la cuenta de servicio `food`
-- escribe la fila entera (antes, solo `request_status`, 1106): la Edge anota el aviso con ella al avisar a Tasks
-- (`equipment/:id/fault`) y el worker copia el estado. Quien escribe es `updated_by`, que el núcleo pone antes de los
-- triggers de la tabla. La validación de la Edge tampoco admite ya estos campos desde el cliente.
create or replace function food.guard_equipment_notice_writer()
returns trigger language plpgsql as $$
begin
  if new.updated_by is not null and new.updated_by is distinct from core.service_actor('food') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'food.equipment_notices', 'reason', 'server only'));
  end if;
  return new;
end $$;
create trigger food_guard_equipment_notice_writer before insert or update on food.equipment_notices
  for each row execute function food.guard_equipment_notice_writer();
