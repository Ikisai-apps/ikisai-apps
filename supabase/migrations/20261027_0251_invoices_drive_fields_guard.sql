-- Finance · seguridad F2 (auditoría de rutas del 27-10): `drive_file_id` y `drive_url` solo los escribe la cuenta de
-- servicio de Drive («Drive (sistema)»). Una persona que pusiera el id de un PDF de «Entrada» en otra factura haría que
-- la relectura lo diera por importado o atascaría el tick con el índice único; y `drive_url` admitía cualquier https.
-- La Edge lo rechaza antes (hook, 403 DRIVE_FIELDS); aquí, el mismo límite en la base. Corre después de
-- `core_touch_revision` (orden alfabético), que deja en `updated_by` a quien escribe.

create or replace function invoices.guard_drive_fields()
returns trigger language plpgsql as $$
begin
  if (tg_op = 'INSERT' and (new.drive_file_id is not null or new.drive_url is not null))
     or (tg_op = 'UPDATE' and (new.drive_file_id is distinct from old.drive_file_id or new.drive_url is distinct from old.drive_url)) then
    if new.updated_by is null or new.updated_by is distinct from core.service_actor('drive') then
      perform core.fail('DRIVE_FIELDS', 403, jsonb_build_object('id', new.id, 'fields', jsonb_build_array('drive_file_id', 'drive_url')));
    end if;
  end if;
  return new;
end $$;

create trigger invoices_drive_fields_guard before insert or update of drive_file_id, drive_url on invoices.invoices
  for each row execute function invoices.guard_drive_fields();

revoke all on function invoices.guard_drive_fields() from public, anon, authenticated;
