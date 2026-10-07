-- Invoices · emitir facturas desde Finance, PR 3: rectificativas (API.md §14.3). Toca solo el schema invoices.
--
-- - `invoices.rectify {id, kind, reason_code, reason}`: crea un BORRADOR de rectificativa en la serie de rectificativas
--   que apunta a una emitida desde Finance. Por diferencias (I, por defecto) lleva las líneas de la original en negativo;
--   por sustitución (S) las repite en positivo para corregirlas y guarda la base y la cuota rectificadas.
-- - `invoices.issue` (redefinido): al emitir una rectificativa, la original pasa a «rectificada» y anota en
--   `rectified_by` la rectificativa que la corrige. El resto del procedimiento es el de 0213.

create or replace function invoices.rectify(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args';
  o invoices.issued_invoices; s invoices.issued_series; l record;
  v_id uuid := gen_random_uuid(); v_kind text := coalesce(nullif(a->>'kind', ''), 'I'); v_code text; v_reason text := btrim(coalesce(a->>'reason', ''));
  v_sign numeric;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.rectify')); end if;
  begin select * into o from invoices.issued_invoices where id = (a->>'id')::uuid and deleted_at is null; exception when others then o.id := null; end;
  if o.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.issued_invoices', 'id', a->>'id')); end if;
  if o.status not in ('emitida', 'rectificada') or o.origin <> 'app' then perform core.fail('RECTIFY_NOT_ISSUED', 422, jsonb_build_object('id', o.id, 'status', o.status)); end if;
  if v_kind not in ('I', 'S') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'kind')); end if;
  v_code := case when o.invoice_type = 'F2' then 'R5' else coalesce(nullif(a->>'reason_code', ''), 'R4') end;
  if v_code not in ('R1', 'R2', 'R3', 'R4', 'R5') or (v_code = 'R5') <> (o.invoice_type = 'F2') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'reason_code')); end if;
  if v_reason = '' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'reason')); end if;
  select * into s from invoices.issued_series where mode = 'emision' and kind = 'rectificativa' and active and closed_at is null and deleted_at is null order by code limit 1;
  if s.id is null then perform core.fail('SERIES_MISSING', 422, jsonb_build_object('kind', 'rectificativa')); end if;
  perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.issued_invoices', 'id', v_id, 'fields', jsonb_build_object(
    'series_code', s.code, 'status', 'borrador', 'issue_date', (now() at time zone 'Europe/Madrid')::date, 'operation_date', o.operation_date,
    'invoice_type', v_code, 'rectification_kind', v_kind, 'rectification_reason', left(v_reason, 500),
    'rectified', jsonb_build_array(jsonb_build_object('issued_invoice_id', o.id, 'series', o.series_code, 'number', o.number, 'full_number', o.full_number, 'issue_date', o.issue_date)),
    'rectified_base', case when v_kind = 'S' then o.base_total end, 'rectified_quota', case when v_kind = 'S' then o.quota_total + o.surcharge_total end,
    'recipient_name', o.recipient_name, 'recipient_tax_id', o.recipient_tax_id, 'recipient_id_type', o.recipient_id_type, 'recipient_country', o.recipient_country,
    'recipient_address', o.recipient_address, 'recipient_kind', o.recipient_kind, 'prices_include_vat', o.prices_include_vat,
    'description', left('Rectificación de ' || o.full_number || ': ' || v_reason, 500), 'income_category', o.income_category, 'currency', o.currency)));
  v_sign := case when v_kind = 'I' then -1 else 1 end;
  for l in select * from invoices.issued_invoice_lines where issued_invoice_id = o.id and deleted_at is null order by position, created_at loop
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.issued_invoice_lines', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'issued_invoice_id', v_id, 'position', l.position, 'description', l.description, 'quantity', l.quantity, 'unit', l.unit,
      'unit_price', case when l.unit_price is null then null else v_sign * l.unit_price end, 'discount_amount', v_sign * l.discount_amount,
      'net_amount', v_sign * l.net_amount, 'tax', l.tax, 'vat_rate', l.vat_rate,
      'vat_amount', case when l.vat_amount is null then null else v_sign * l.vat_amount end,
      'surcharge_rate', l.surcharge_rate, 'surcharge_amount', case when l.surcharge_amount is null then null else v_sign * l.surcharge_amount end)));
  end loop;
  return jsonb_build_object('id', v_id, 'series_code', s.code, 'invoice_type', v_code, 'rectification_kind', v_kind);
end $$;
select core.allow_procedure('invoices', 'invoices.rectify');
revoke all on function invoices.rectify(jsonb) from public, anon, authenticated;

create or replace function invoices.issue(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args';
  v_issuer jsonb := a->'issuer';
  v invoices.issued_invoices; s invoices.issued_series; st invoices.vf_state; rec invoices.vf_records; o invoices.issued_invoices;
  v_today date := (now() at time zone 'Europe/Madrid')::date;
  v_year int; v_n int; v_number text; v_full text; v_missing text[] := '{}';
  r record; v_lines jsonb; v_breakdown jsonb; v_withholdings jsonb;
  v_quota numeric; v_amount numeric; v_date_text text; v_qr text; v_doc jsonb; v_payload jsonb; v_kind_ok boolean;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.issue')); end if;
  if v_issuer is null or jsonb_typeof(v_issuer) <> 'object' or nullif(v_issuer->>'tax_id', '') is null or nullif(v_issuer->>'legal_name', '') is null
     or nullif(v_issuer->>'address_line', '') is null or nullif(v_issuer->>'postal_code', '') is null or nullif(v_issuer->>'city', '') is null then
    perform core.fail('ENTITY_MISSING', 422, jsonb_build_object('reason', 'Faltan los datos de la entidad en Central'));
  end if;
  begin select * into v from invoices.issued_invoices where id = (a->>'id')::uuid and deleted_at is null for update; exception when others then v.id := null; end;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.issued_invoices', 'id', a->>'id')); end if;
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  if v.status <> 'borrador' then perform core.fail('ISSUED_NOT_DRAFT', 409, jsonb_build_object('id', v.id, 'status', v.status)); end if;
  select * into s from invoices.issued_series where upper(btrim(code)) = upper(btrim(v.series_code)) and deleted_at is null for update;
  if s.id is null or s.mode <> 'emision' then perform core.fail('SERIES_NOT_ISSUING', 422, jsonb_build_object('code', v.series_code)); end if;
  if not s.active or s.closed_at is not null then perform core.fail('SERIES_CLOSED', 409, jsonb_build_object('code', s.code)); end if;
  v_kind_ok := case when v.invoice_type in ('R1', 'R2', 'R3', 'R4', 'R5') then s.kind = 'rectificativa' when v.invoice_type = 'F2' then s.kind = 'simplificada' else s.kind = 'ordinaria' end;
  if not v_kind_ok then perform core.fail('SERIES_KIND_MISMATCH', 422, jsonb_build_object('code', s.code, 'kind', s.kind, 'invoice_type', v.invoice_type)); end if;

  -- Datos obligatorios (art. 6 del RD 1619/2012)
  if not exists (select 1 from invoices.issued_invoice_lines l where l.issued_invoice_id = v.id and l.deleted_at is null) then v_missing := array_append(v_missing, 'lines'); end if;
  if v.invoice_type not in ('F2', 'R5') then
    if nullif(btrim(coalesce(v.recipient_name, '')), '') is null then v_missing := array_append(v_missing, 'recipient_name'); end if;
    if nullif(btrim(coalesce(v.recipient_tax_id, '')), '') is null then v_missing := array_append(v_missing, 'recipient_tax_id'); end if;
    if coalesce(v.recipient_kind, 'empresa') <> 'particular' and (v.recipient_address is null or nullif(btrim(coalesce(v.recipient_address->>'line', '')), '') is null
        or nullif(btrim(coalesce(v.recipient_address->>'postal_code', '')), '') is null or nullif(btrim(coalesce(v.recipient_address->>'city', '')), '') is null) then
      v_missing := array_append(v_missing, 'recipient_address');
    end if;
  end if;
  if v.invoice_type in ('R1', 'R2', 'R3', 'R4', 'R5') then
    if jsonb_array_length(v.rectified) = 0 then v_missing := array_append(v_missing, 'rectified'); end if;
    if v.rectification_kind is null then v_missing := array_append(v_missing, 'rectification_kind'); end if;
    if nullif(btrim(coalesce(v.rectification_reason, '')), '') is null then v_missing := array_append(v_missing, 'rectification_reason'); end if;
  end if;
  if cardinality(v_missing) > 0 then perform core.fail('ISSUE_MISSING_DATA', 422, jsonb_build_object('id', v.id, 'missing', to_jsonb(v_missing))); end if;

  select * into r from invoices.recalculate_issued(v.id);

  -- Número: contador de la serie (fila bloqueada arriba); reinicia con el año si la serie es anual; la fecha nunca
  -- retrocede dentro de la serie
  v_year := case when s.yearly then extract(year from v_today)::int else null end;
  if s.counter_last_date is not null and s.counter_last_date > v_today then
    perform core.fail('ISSUE_DATE_ORDER', 409, jsonb_build_object('code', s.code, 'last_issue_date', s.counter_last_date));
  end if;
  v_n := case when s.yearly and s.counter_year is distinct from v_year then 1 else s.counter_last + 1 end;
  v_number := invoices.format_issued_number(s.format, s.code, extract(year from v_today)::int, v_n);
  v_full := case when upper(btrim(v_number)) like upper(btrim(v.series_code)) || '%' then btrim(v_number) else btrim(v.series_code) || '-' || btrim(v_number) end;
  if length(v_full) > 60 or v_full !~ '^[ -~]+$' then perform core.fail('INVALID_NUMBER_FORMAT', 422, jsonb_build_object('code', s.code, 'number', v_full)); end if;

  -- Documento congelado
  select coalesce(jsonb_agg(jsonb_build_object('position', l.position, 'description', l.description, 'quantity', l.quantity, 'unit', l.unit, 'unit_price', l.unit_price,
      'discount_amount', l.discount_amount, 'net_amount', l.net_amount, 'tax', l.tax, 'vat_rate', l.vat_rate, 'vat_amount', l.vat_amount,
      'surcharge_rate', l.surcharge_rate, 'surcharge_amount', l.surcharge_amount) order by l.position, l.created_at), '[]'::jsonb)
    into v_lines from invoices.issued_invoice_lines l where l.issued_invoice_id = v.id and l.deleted_at is null;
  v_breakdown := invoices.issued_breakdown(v.id);
  select coalesce(jsonb_agg(jsonb_build_object('tax', t.tax, 'rate', t.rate, 'base', t.taxable_base, 'amount', t.quota) order by t.position), '[]'::jsonb)
    into v_withholdings from invoices.issued_tax_lines t where t.issued_invoice_id = v.id and t.deleted_at is null and t.tax in ('irpf', 'otra_retencion');
  v_quota := r.quota + r.surcharge;
  v_amount := r.base + r.quota + r.surcharge;   -- ImporteTotal de Verifactu: sin restar retenciones
  v_date_text := to_char(v_today, 'DD-MM-YYYY');
  v_doc := jsonb_build_object('full_number', v_full, 'series', v.series_code, 'number', v_number, 'issue_date', v_today, 'operation_date', v.operation_date,
    'invoice_type', v.invoice_type, 'issuer', v_issuer,
    'recipient', jsonb_build_object('name', v.recipient_name, 'tax_id', v.recipient_tax_id, 'id_type', v.recipient_id_type, 'country', v.recipient_country,
      'address', v.recipient_address, 'kind', v.recipient_kind),
    'description', v.description, 'lines', v_lines, 'breakdown', v_breakdown, 'withholdings', v_withholdings, 'prices_include_vat', v.prices_include_vat,
    'totals', jsonb_build_object('base', r.base, 'quota', r.quota, 'surcharge', r.surcharge, 'withholding', r.withholding, 'total', r.total, 'vf_amount', v_amount),
    'rectification', case when v.invoice_type like 'R%' then jsonb_build_object('kind', v.rectification_kind, 'rectified', v.rectified, 'reason', v.rectification_reason,
      'base', v.rectified_base, 'quota', v.rectified_quota) end,
    'currency', v.currency, 'issued_at', now());

  -- Registro de alta (forma de RegistroAlta del XSD; la cadena, el sistema y la huella los añade vf_append)
  v_payload := jsonb_build_object('IDVersion', '1.0',
    'IDFactura', jsonb_build_object('IDEmisorFactura', v_issuer->>'tax_id', 'NumSerieFactura', v_full, 'FechaExpedicionFactura', v_date_text),
    'NombreRazonEmisor', left(v_issuer->>'legal_name', 120), 'TipoFactura', v.invoice_type, 'TipoRectificativa', v.rectification_kind,
    'FacturasRectificadas', case when v.invoice_type like 'R%' then v.rectified end,
    'ImporteRectificacion', case when v.rectification_kind = 'S' then jsonb_build_object('BaseRectificada', invoices.vf_amount(coalesce(v.rectified_base, 0)),
      'CuotaRectificada', invoices.vf_amount(coalesce(v.rectified_quota, 0))) end,
    'FechaOperacion', case when v.operation_date is not null and v.operation_date <> v_today then to_char(v.operation_date, 'DD-MM-YYYY') end,
    'DescripcionOperacion', left(v.description, 500),
    'Destinatarios', case when nullif(btrim(coalesce(v.recipient_name, '')), '') is not null then jsonb_build_array(
      case when coalesce(v.recipient_country, 'ES') = 'ES' and coalesce(v.recipient_id_type, 'NIF') = 'NIF'
           then jsonb_build_object('NombreRazon', left(v.recipient_name, 120), 'NIF', v.recipient_tax_id)
           else jsonb_build_object('NombreRazon', left(v.recipient_name, 120), 'IDOtro', jsonb_build_object('CodigoPais', v.recipient_country, 'IDType', v.recipient_id_type, 'ID', v.recipient_tax_id)) end) end,
    'Desglose', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'Impuesto', case d->>'tax' when 'iva' then '01' when 'ipsi' then '02' when 'igic' then '03' else '05' end,
        'ClaveRegimen', d->>'regime_key',
        'CalificacionOperacion', case when d->>'exemption' is null then coalesce(d->>'qualification', 'S1') end,
        'OperacionExenta', d->>'exemption',
        'TipoImpositivo', case when d->>'rate' is not null then invoices.vf_amount((d->>'rate')::numeric) end,
        'BaseImponibleOimporteNoSujeto', invoices.vf_amount((d->>'base')::numeric),
        'CuotaRepercutida', case when d->>'exemption' is null then invoices.vf_amount((d->>'quota')::numeric) end,
        'TipoRecargoEquivalencia', case when d->>'surcharge_rate' is not null then invoices.vf_amount((d->>'surcharge_rate')::numeric) end,
        'CuotaRecargoEquivalencia', case when d->>'surcharge_rate' is not null then invoices.vf_amount((d->>'surcharge_quota')::numeric) end))), '[]'::jsonb)
      from jsonb_array_elements(v_breakdown) d),
    'CuotaTotal', invoices.vf_amount(v_quota), 'ImporteTotal', invoices.vf_amount(v_amount));

  perform set_config('invoices.issuing', 'on', true);
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_series', 'id', s.id, 'expectedRevision', s.revision,
    'fields', jsonb_build_object('counter_year', v_year, 'counter_last', v_n, 'counter_last_date', v_today)));
  update invoices.vf_state set producer_name = v_issuer->>'legal_name', producer_tax_id = v_issuer->>'tax_id' where singleton and producer_tax_id is null;
  rec := invoices.vf_append('alta', v.id, v_issuer->>'tax_id', v_full, v_date_text, v.invoice_type, v_quota, v_amount, v_payload, (p->>'actor')::uuid);
  select * into st from invoices.vf_state where singleton;
  v_qr := invoices.vf_qr_url(case when st.sending = 'pruebas' then 'pruebas' else 'produccion' end, v_issuer->>'tax_id', v_full, v_date_text, v_amount);
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', v.revision,
    'fields', jsonb_build_object('status', 'emitida', 'number', v_number, 'issue_date', v_today, 'origin', 'app', 'issued_at', now(), 'issued_by', p->>'actor',
      'issuer_tax_id', v_issuer->>'tax_id', 'issuer_name', v_issuer->>'legal_name', 'issuer', v_issuer,
      'base_total', r.base, 'quota_total', r.quota, 'surcharge_total', r.surcharge, 'withholding_total', r.withholding, 'total', r.total, 'document', v_doc,
      'vf_record_kind', 'alta', 'vf_hash', rec.hash, 'vf_previous_hash', rec.previous_hash, 'vf_previous_ref', rec.previous_ref, 'vf_first_record', rec.first_record,
      'vf_generated_at', rec.generated_at, 'vf_status', rec.send_status, 'vf_qr_url', v_qr, 'vf_system', rec.payload->'SistemaInformatico')));
  -- Rectificativa: la original pasa a «rectificada» y apunta a esta (§14.3)
  if v.invoice_type in ('R1', 'R2', 'R3', 'R4', 'R5') then
    for o in select * from invoices.issued_invoices
              where id in (select (x->>'issued_invoice_id')::uuid from jsonb_array_elements(v.rectified) x where x ? 'issued_invoice_id')
                and deleted_at is null for update loop
      if o.status in ('emitida', 'rectificada') then
        perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', o.id, 'expectedRevision', o.revision,
          'fields', jsonb_build_object('status', 'rectificada', 'rectified_by', o.rectified_by || jsonb_build_array(jsonb_build_object('issued_invoice_id', v.id, 'full_number', v_full, 'issue_date', v_today)))));
      end if;
    end loop;
  end if;
  perform set_config('invoices.issuing', 'off', true);
  return jsonb_build_object('id', v.id, 'full_number', v_full, 'issue_date', v_today, 'vf_hash', rec.hash, 'vf_status', rec.send_status, 'seq', rec.seq);
end $$;

-- Una rectificativa por diferencias tiene base negativa: la regla del ingreso asignado solo aplica si hay algo asignado.
create or replace function invoices.check_issued(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p);
  v_ids uuid[]; v_id uuid; v_inv invoices.issued_invoices; r record; v_fields jsonb; v_delta numeric; v_reason text; v_alloc numeric;
begin
  select array_agg(distinct x.id) into v_ids from (
    select ch.row_id id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'issued_invoices' and ch.op <> 'call'
    union
    select (coalesce(ch.after, ch.before)->>'issued_invoice_id')::uuid from core.changes ch
    where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.op <> 'call'
      and ch.table_name in ('issued_invoice_lines', 'issued_tax_lines', 'issued_invoice_files', 'issued_allocations')
  ) x where x.id is not null;
  if v_ids is null then return; end if;
  foreach v_id in array v_ids loop
    select * into v_inv from invoices.issued_invoices where id = v_id for update;
    if v_inv.id is null then continue; end if;
    if v_inv.status <> 'anulada' then
      select * into r from invoices.recalculate_issued(v_id);
      v_delta := case when v_inv.source_total is null then null else v_inv.source_total - r.total end;
      v_reason := case when invoices.outside_tolerance(v_delta) then 'REVISAR IMPORTES' else null end;
      v_fields := '{}'::jsonb;
      if v_inv.base_total <> r.base then v_fields := v_fields || jsonb_build_object('base_total', r.base); end if;
      if v_inv.quota_total <> r.quota then v_fields := v_fields || jsonb_build_object('quota_total', r.quota); end if;
      if v_inv.surcharge_total <> r.surcharge then v_fields := v_fields || jsonb_build_object('surcharge_total', r.surcharge); end if;
      if v_inv.withholding_total <> r.withholding then v_fields := v_fields || jsonb_build_object('withholding_total', r.withholding); end if;
      if v_inv.total <> r.total then v_fields := v_fields || jsonb_build_object('total', r.total); end if;
      if v_inv.totals_delta is distinct from v_delta then v_fields := v_fields || jsonb_build_object('totals_delta', v_delta); end if;
      if v_inv.review_reason is distinct from v_reason then v_fields := v_fields || jsonb_build_object('review_reason', v_reason); end if;
      if v_fields <> '{}'::jsonb then
        perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v_id, 'expectedRevision', v_inv.revision, 'fields', v_fields));
      end if;
      -- El ingreso asignado nunca supera la base
      select coalesce(sum(allocated_amount), 0) into v_alloc from invoices.issued_allocations where issued_invoice_id = v_id and deleted_at is null;
      if v_alloc > 0 and v_alloc > r.base + 0.02 then
        perform core.fail('ALLOCATIONS_EXCEED_INVOICE', 422, jsonb_build_object('issued_invoice_id', v_id, 'allocated', v_alloc, 'base', r.base));
      end if;
    end if;
  end loop;
end $$;
