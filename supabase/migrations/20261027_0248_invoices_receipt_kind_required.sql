-- Finance · el tipo de justificante, explícito (Core, 27-10, para la caja de Flow del sábado).
--
-- Desde la 0247, una app que manda un justificante (`receipt_number` o `receipt_file_id`) sin decir `receipt_kind`
-- quedaba como factura sin avisar: un cobro de la caja con su número se habría impreso como «Factura simplificada».
-- Ahora, si la llamada trae un justificante nuevo sin `receipt_kind` y el apunte no tenía ya uno, se rechaza con
-- `422 RECEIPT_KIND_REQUIRED`. Sin justificante, todo sigue igual (el cierre del día, de proceso; un cobro sin número).
-- Lo de 0247 se mantiene tal cual: la comprobación va delante y le pasa la llamada.

alter function invoices.record_app_entry(jsonb) rename to record_app_entry_0247;

create function invoices.record_app_entry(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_brings boolean := nullif(btrim(coalesce(a->>'receipt_number', '')), '') is not null or a->>'receipt_file_id' is not null;
begin
  if v_brings and nullif(a->>'receipt_kind', '') is null and not exists (
    select 1 from invoices.app_entries
    where source_app = btrim(coalesce(a->>'source_app', '')) and source_ref = btrim(coalesce(a->>'source_ref', ''))
      and deleted_at is null and receipt_kind is not null) then
    perform core.fail('RECEIPT_KIND_REQUIRED', 422, jsonb_build_object('field', 'receipt_kind', 'reason', 'with receipt_number or receipt_file_id, say invoice or ticket'));
  end if;
  return invoices.record_app_entry_0247(p);
end $$;

revoke all on function invoices.record_app_entry(jsonb), invoices.record_app_entry_0247(jsonb) from public, anon, authenticated;
