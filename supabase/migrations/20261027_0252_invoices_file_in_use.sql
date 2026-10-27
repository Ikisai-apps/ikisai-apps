-- Finance · seguridad F4 (auditoría de rutas del 27-10): adjuntar un archivo de Finance solo si lo subió quien lo adjunta
-- o si ya está enlazado a algo vivo de Finance (que cualquier miembro ve). Esta lectura dice lo segundo; lo primero lo
-- mira la Edge con `core.files.created_by`. Solo un sí o un no: no dice qué hay detrás.

create or replace function invoices.file_in_use(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_file uuid;
begin
  begin v_file := (p->'args'->>'file_id')::uuid; exception when others then v_file := null; end;
  return jsonb_build_object('in_use', v_file is not null and (
    exists (select 1 from invoices.invoice_files where file_id = v_file and deleted_at is null)
    or exists (select 1 from invoices.issued_invoice_files where file_id = v_file and deleted_at is null)
    or exists (select 1 from invoices.app_entries where receipt_file_id = v_file and deleted_at is null)));
end $$;
select core.allow_read('invoices', 'invoices.file_in_use', 'function', '{editor,owner}', false);

revoke all on function invoices.file_in_use(jsonb) from public, anon, authenticated;
