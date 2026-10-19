-- Invoices · tanda 27 (rediseño de Finance de una pasada, aprobado por VG el 19-10-2026): datos de las emitidas.
-- Toca solo el schema invoices.
--
-- - `sent_at` (fecha): cuándo se envió la emitida al cliente. Da la etapa «Enviada» del recorrido y la antigüedad
--   desde el envío. La pone una persona («Marcar enviada») o la app al descargar o compartir el PDF; nunca un borrador.
-- - `payment_method`: el medio del cobro, como en las recibidas (transferencia, tarjeta, efectivo, bizum,
--   domiciliación u otro). «Cobrada» pide la fecha real y el medio (la regla de FB_2026_027 en las recibidas).
-- - Las dos se pueden cambiar en una emitida congelada, como el cobro y el concepto.
-- - «Por cobrar» sale en Finance de la misma cifra que usa Booking: `invoices.reservation_collected` (0222) queda
--   abierta también a Finance. Sin red, Finance aplica la misma regla en local (`reservationCollected` del dominio).

alter table invoices.issued_invoices
  add column sent_at date,
  add column payment_method text check (payment_method is null or payment_method in ('transferencia','tarjeta','efectivo','bizum','domiciliacion','otro')),
  add constraint issued_sent_not_draft check (sent_at is null or status <> 'borrador');

select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
  'issuer_tax_id', 'issuer_name', 'issuer',
  'recipient_address', 'recipient_kind', 'prices_include_vat',
  'issued_at', 'issued_by', 'document', 'rectified_by',
  'vf_record_kind', 'vf_hash', 'vf_previous_hash', 'vf_previous_ref', 'vf_first_record', 'vf_generated_at', 'vf_status', 'vf_csv', 'vf_errors', 'vf_qr_url', 'vf_system',
  'purpose', 'sent_at', 'payment_method'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- De 0221, con `sent_at` y `payment_method` entre lo que queda libre en una emitida, y sin fecha de envío en un borrador.
create or replace function invoices.guard_issued_invoice()
returns trigger language plpgsql as $$
declare
  s invoices.issued_series;
  v_old jsonb; v_new jsonb;
  -- Lo único que cambia en una emitida fuera de los procedimientos (full_number, fiscal_year y fiscal_quarter son generadas y en BEFORE llegan vacías;
  -- el borrado lo rechaza issued_invoices_no_delete con su propio código)
  v_free text[] := array['payment_status', 'paid_at', 'payment_method', 'sent_at', 'notes', 'income_category', 'review_reason', 'totals_delta', 'revision', 'updated_at', 'updated_by', 'deleted_at', 'full_number', 'fiscal_year', 'fiscal_quarter', 'purpose'];
begin
  select * into s from invoices.issued_series where upper(btrim(code)) = upper(btrim(new.series_code)) and deleted_at is null;
  -- Un borrador no se ha enviado (también lo dice issued_sent_not_draft; aquí con su código)
  if new.status = 'borrador' and new.sent_at is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'sent_at', 'reason', 'draft not sent')); end if;
  if tg_op = 'INSERT' then
    if s.id is not null and s.closed_at is not null then perform core.fail('SERIES_CLOSED', 409, jsonb_build_object('code', s.code, 'last_number', s.closed_last_number)); end if;
    if coalesce(s.mode, 'registro') = 'emision' then
      if new.status <> 'borrador' or new.number is not null then perform core.fail('ISSUE_REQUIRES_PROCEDURE', 422, jsonb_build_object('reason', 'draft without number; use invoices.issue')); end if;
      new.origin := 'app';
    elsif new.status in ('borrador', 'emitida', 'rectificada') then
      perform core.fail('SERIES_NOT_ISSUING', 422, jsonb_build_object('code', new.series_code));
    end if;
    return new;
  end if;
  -- UPDATE (el borrado lo decide issued_invoices_no_delete con ISSUED_NOT_DELETABLE)
  if invoices.issuing() or (new.deleted_at is not null and old.deleted_at is null) then return new; end if;
  if old.status in ('emitida', 'rectificada') then
    v_old := to_jsonb(old) - v_free; v_new := to_jsonb(new) - v_free;
    if v_old <> v_new then perform core.fail('ISSUED_FROZEN', 409, jsonb_build_object('id', old.id)); end if;
    return new;
  end if;
  if old.status = 'borrador' then
    if new.status <> 'borrador' or new.number is not null then perform core.fail('ISSUE_REQUIRES_PROCEDURE', 422, jsonb_build_object('id', old.id)); end if;
    if upper(btrim(new.series_code)) <> upper(btrim(old.series_code)) and coalesce(s.mode, 'registro') <> 'emision' then
      perform core.fail('SERIES_NOT_ISSUING', 422, jsonb_build_object('code', new.series_code));
    end if;
  elsif new.status in ('borrador', 'emitida', 'rectificada') then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  return new;
end $$;

-- «Por cobrar» en Finance, de la misma lectura que Booking (0222).
select core.allow_read('invoices', 'invoices.reservation_collected', 'function');
