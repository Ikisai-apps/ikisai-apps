-- Invoices · la fecha de una factura recibida puede quedar vacía al crearla (QA FB_2026_016, aprobado por el usuario).
-- Toca solo el schema invoices.
--
-- Al dar de alta una factura a mano, la fecha ya no se rellena con la de hoy ni es obligatoria: se lee después del PDF
-- (la importación ya usa la del documento si no hay otra escrita) o se escribe a mano. Sin fecha:
-- - el código FVR toma el año en curso (Madrid), el nombre normalizado empieza por `sin_fecha` y el periodo fiscal queda vacío;
-- - no entra en resúmenes ni entregas por periodo (filtran por fecha) y sigue contando como pendiente;
-- - no se puede validar: `invoices.validate` añade `invoice_date` a los datos que faltan (INVOICE_INCOMPLETE).

alter table invoices.invoices alter column invoice_date drop not null;

create or replace function invoices.normalized_base(p_date date, p_supplier_slug text, p_object text)
returns text language sql immutable as $$
  select coalesce(to_char(p_date, 'YYYY_MM_DD'), 'sin_fecha') || '_(' || coalesce(nullif(invoices.slugify(p_supplier_slug), ''), 'sin_proveedor') || ')_' || coalesce(nullif(invoices.slugify(p_object), ''), 'sin_objeto');
$$;

create or replace function invoices.assign_invoice_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then new.code := core.next_code('FVR', coalesce(extract(year from new.invoice_date), extract(year from (now() at time zone 'Europe/Madrid')))::int); end if;
  return new;
end $$;

-- validate (de 0201) con la fecha entre los datos obligatorios.
create or replace function invoices.validate(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_inv invoices.invoices; r record; v_delta numeric; v_missing text[] := '{}'; v_has_content boolean;
begin
  perform set_config('invoices.procedure', 'validate', true);
  v_inv := invoices.invoice_for_update(a->>'invoice_id');
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> v_inv.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.invoices', 'id', v_inv.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', v_inv.revision, 'current', to_jsonb(v_inv)));
  end if;
  if v_inv.status not in ('pendiente_datos', 'pendiente_revision') then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', v_inv.status, 'to', 'validada')); end if;
  select * into r from invoices.recalculate(v_inv.id);
  v_delta := case when v_inv.source_total is null then null else v_inv.source_total - r.total end;
  if invoices.outside_tolerance(v_delta) then perform core.fail('INVOICE_TOTALS_MISMATCH', 422, jsonb_build_object('invoice_id', v_inv.id, 'delta', v_delta, 'calculated_total', r.total, 'source_total', v_inv.source_total)); end if;
  if v_inv.invoice_date is null then v_missing := array_append(v_missing, 'invoice_date'); end if;
  if v_inv.expense_category is null then v_missing := array_append(v_missing, 'expense_category'); end if;
  if not exists (select 1 from invoices.invoice_files where invoice_id = v_inv.id and deleted_at is null and kind = 'original') then v_missing := array_append(v_missing, 'original_file'); end if;
  select exists (select 1 from invoices.invoice_lines where invoice_id = v_inv.id and deleted_at is null) or exists (select 1 from invoices.tax_lines where invoice_id = v_inv.id and deleted_at is null) into v_has_content;
  if not v_has_content then v_missing := array_append(v_missing, 'lines_or_taxes'); end if;
  if cardinality(v_missing) > 0 then perform core.fail('INVOICE_INCOMPLETE', 422, jsonb_build_object('invoice_id', v_inv.id, 'missing', to_jsonb(v_missing))); end if;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v_inv.id, 'expectedRevision', v_inv.revision, 'fields', jsonb_build_object(
    'status', 'validada', 'review_reason', null, 'calculated_base', r.base, 'calculated_vat', r.vat, 'calculated_other', r.other, 'calculated_withholding', r.withholding, 'calculated_total', r.total, 'totals_delta', v_delta)));
  select * into v_inv from invoices.invoices where id = v_inv.id;
  return to_jsonb(v_inv);
end $$;
