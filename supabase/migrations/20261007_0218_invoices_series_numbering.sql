-- Invoices · numeración como dato de la serie (ronda 47). Toca solo el schema invoices.
--
-- El usuario continúa en 2026 la numeración de su hoja (último emitido `F_02_26`, la siguiente `F_03_26`) y en 2027 pasa a
-- `F2027-0001`. Nada de eso está en el código: es el formato de la serie, su contador inicial y su año.
-- - `{aa}` en el formato: año en dos cifras. `{n:K}` rellena con ceros hasta K cifras sin recortar (`F_100_26`).
-- - `issued_series.valid_year`: la serie solo emite en ese año (la de 2027 es otra serie, creada en su año).
-- - `invoices.series_start {code, last_number, year}`: fija el último número ya emitido fuera de Finance, solo mientras la
--   serie no tenga emitidas. El contador sigue siendo el de 0212: sin huecos ni duplicados.
-- - `invoices.issue` (redefinido desde 0214) rechaza emitir en una serie de otro año (`SERIES_YEAR_MISMATCH`).

alter table invoices.issued_series add column valid_year int check (valid_year is null or valid_year between 2000 and 2100);

select core.register_table('invoices', 'invoices', 'issued_series', array['code', 'description', 'kind', 'yearly', 'format', 'active', 'mode', 'closed_at', 'closed_last_number',
  'counter_year', 'counter_last', 'counter_last_date', 'valid_year'], '{reader,editor,owner}', '{editor,owner}', true);

create or replace function invoices.format_issued_number(p_format text, p_code text, p_year int, p_n int)
returns text language plpgsql immutable as $$
declare v text := p_format; m text[]; k int; digits text := p_n::text;
begin
  v := replace(replace(replace(v, '{serie}', btrim(p_code)), '{año}', p_year::text), '{aa}', lpad((p_year % 100)::text, 2, '0'));
  m := regexp_match(v, '\{n:(\d)\}');
  if m is not null then
    k := m[1]::int;
    v := regexp_replace(v, '\{n:\d\}', case when length(digits) >= k then digits else lpad(digits, k, '0') end);
  else
    v := replace(v, '{n}', digits);
  end if;
  return v;
end $$;

create or replace function invoices.series_start(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; s invoices.issued_series; v_last int; v_year int;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.series_start')); end if;
  select * into s from invoices.issued_series where upper(btrim(code)) = upper(btrim(coalesce(a->>'code', ''))) and deleted_at is null for update;
  if s.id is null or s.mode <> 'emision' then perform core.fail('SERIES_NOT_ISSUING', 422, jsonb_build_object('code', a->>'code')); end if;
  begin
    v_last := (a->>'last_number')::int;
    v_year := coalesce((a->>'year')::int, s.valid_year, extract(year from (now() at time zone 'Europe/Madrid'))::int);
  exception when others then v_last := null; end;
  if v_last is null or v_last < 0 or v_last > 999999 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'last_number')); end if;
  if exists (select 1 from invoices.issued_invoices i where upper(btrim(i.series_code)) = upper(btrim(s.code)) and i.deleted_at is null and i.status <> 'borrador') then
    perform core.fail('SERIES_IN_USE', 409, jsonb_build_object('code', s.code));
  end if;
  perform set_config('invoices.issuing', 'on', true);
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_series', 'id', s.id, 'expectedRevision', s.revision,
    'fields', jsonb_build_object('counter_year', case when s.yearly then v_year end, 'counter_last', v_last, 'counter_last_date', null)));
  perform set_config('invoices.issuing', 'off', true);
  return jsonb_build_object('code', s.code, 'last_number', v_last, 'next', invoices.format_issued_number(s.format, s.code, v_year, v_last + 1));
end $$;
select core.allow_procedure('invoices', 'invoices.series_start');
revoke all on function invoices.series_start(jsonb) from public, anon, authenticated;

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
  -- Serie de un año concreto (F_03_26 en 2026, F2027-0001 en 2027): solo emite en su año.
  if s.valid_year is not null and s.valid_year <> extract(year from v_today)::int then
    perform core.fail('SERIES_YEAR_MISMATCH', 422, jsonb_build_object('code', s.code, 'valid_year', s.valid_year));
  end if;
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
