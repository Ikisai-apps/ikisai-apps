-- Invoices · concepto del cobro de una emitida (ronda 52, para el portal de organizadores). Toca solo el schema invoices.
--
-- `purpose`: `senal` (señal o anticipo), `saldo` (resto del retiro), `extras` (servicios contratados aparte) o `general`.
-- Es una etiqueta para rotular la factura (el portal la muestra como «Señal», «Saldo»…); no cambia importes ni se imprime,
-- así que también se puede poner en una emitida ya congelada. F1 (`invoices.portal_reservation_money`) la devuelve.
-- Lo pagado que ve el organizador sale solo de Finance (facturas cobradas); lo contratado, de Booking (decisión de Core).

alter table invoices.issued_invoices add column purpose text check (purpose is null or purpose in ('senal', 'saldo', 'extras', 'general'));

select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
  'issuer_tax_id', 'issuer_name', 'issuer',
  'recipient_address', 'recipient_kind', 'prices_include_vat',
  'issued_at', 'issued_by', 'document', 'rectified_by',
  'vf_record_kind', 'vf_hash', 'vf_previous_hash', 'vf_previous_ref', 'vf_first_record', 'vf_generated_at', 'vf_status', 'vf_csv', 'vf_errors', 'vf_qr_url', 'vf_system',
  'purpose'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- El concepto del cobro se puede cambiar en una emitida (de 0212, con `purpose` entre lo que queda libre).
create or replace function invoices.guard_issued_invoice()
returns trigger language plpgsql as $$
declare
  s invoices.issued_series;
  v_old jsonb; v_new jsonb;
  -- Lo único que cambia en una emitida fuera de los procedimientos (full_number, fiscal_year y fiscal_quarter son generadas y en BEFORE llegan vacías;
  -- el borrado lo rechaza issued_invoices_no_delete con su propio código)
  v_free text[] := array['payment_status', 'paid_at', 'notes', 'income_category', 'review_reason', 'totals_delta', 'revision', 'updated_at', 'updated_by', 'deleted_at', 'full_number', 'fiscal_year', 'fiscal_quarter', 'purpose'];
begin
  select * into s from invoices.issued_series where upper(btrim(code)) = upper(btrim(new.series_code)) and deleted_at is null;
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

-- F1 devuelve el concepto del cobro (de 0220).
create or replace function invoices.portal_reservation_money(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not core.portal_in_scope('organizers', (p->>'actor')::uuid, v_res) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return (
    with inv as (
      select i.* from invoices.issued_invoices i where i.id in (select invoices.portal_reservation_invoice_ids(v_res))
    )
    select jsonb_build_object(
      'reservation_id', v_res,
      'currency', 'EUR',
      'invoices', coalesce((select jsonb_agg(jsonb_build_object(
          'id', i.id, 'number', i.full_number, 'issue_date', i.issue_date, 'type', i.invoice_type, 'purpose', i.purpose,
          'rectifies', case when i.invoice_type like 'R%' then (select coalesce(jsonb_agg(x->>'full_number'), '[]'::jsonb) from jsonb_array_elements(i.rectified) x) end,
          'base', i.base_total, 'tax', i.quota_total + i.surcharge_total, 'withholding', i.withholding_total, 'total', i.total,
          'status', i.status, 'collected', i.payment_status = 'cobrada', 'collected_at', i.paid_at,
          'has_document', i.document is not null or exists (select 1 from invoices.issued_invoice_files f where f.issued_invoice_id = i.id and f.deleted_at is null))
        order by i.issue_date, i.full_number) from inv i), '[]'::jsonb),
      'totals', jsonb_build_object(
        'invoiced', coalesce((select sum(total) from inv where status <> 'anulada'), 0),
        'collected', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status = 'cobrada'), 0),
        'pending', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status <> 'cobrada'), 0)))
  );
end $$;
