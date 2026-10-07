-- Invoices · emitir facturas desde Finance, PR 1: registro VERI*FACTU y procedimiento de emisión (API.md §14.3, §14.6).
-- Toca solo el schema invoices.
--
-- - Registros de alta y de anulación con huella SHA-256 encadenada, calculados en la misma transacción que la emisión
--   (especificación de la huella v0.1.2 de la AEAT). Se guardan aunque el envío esté apagado (`send_status = no_enviar`).
-- - `invoices.issue {id, expectedRevision}`: asigna número y fecha, congela, copia el emisor (lo pone la Edge en
--   `args.issuer` desde Central) y genera el registro de alta con la URL del QR.
-- - `invoices.annul_issued`: en una emitida, solo el owner, y genera el registro de anulación.
-- - Tablas internas, no sincronizadas: solo las escriben estos procedimientos; no se editan ni se borran.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
-- Estado único del registro: cabeza de la cadena, interruptor del envío e identificación del sistema informático
-- (SistemaInformaticoType del XSD; el productor es el propio autónomo, que se toma de Central en la primera emisión).
create table invoices.vf_state (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  singleton boolean not null default true unique check (singleton),
  last_seq bigint not null default 0,
  last_hash text,
  last_ref jsonb,
  sending text not null default 'apagado' check (sending in ('apagado', 'pruebas', 'produccion')),
  enabled_at timestamptz,
  enabled_by uuid,
  locked_until date,
  producer_name text,
  producer_tax_id text,
  system_name text not null default 'Ikisai Finance',
  system_id text not null default 'IF' check (length(system_id) <= 2),
  version text not null default '1.0',
  installation_number text not null default gen_random_uuid()::text,
  only_verifactu text not null default 'S',
  multi_ot text not null default 'N',
  multiple_ot text not null default 'N'
);
insert into invoices.vf_state default values;

create table invoices.vf_records (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  seq bigint not null unique,
  record_kind text not null check (record_kind in ('alta', 'anulacion')),
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  issuer_tax_id text not null,
  num_serie text not null,
  issue_date_text text not null check (issue_date_text ~ '^\d{2}-\d{2}-\d{4}$'),
  invoice_type text,
  quota_total numeric(14,2),
  amount_total numeric(14,2),
  first_record boolean not null,
  previous_hash text,
  previous_ref jsonb,
  generated_at timestamptz not null,
  generated_at_text text not null,
  hash text not null check (hash ~ '^[0-9A-F]{64}$'),
  payload jsonb not null,
  send_status text not null check (send_status in ('no_enviar', 'pendiente', 'enviado', 'aceptado', 'aceptado_con_errores', 'rechazado')),
  sent_at timestamptz,
  csv text,
  errors jsonb,
  created_by uuid
);
create index vf_records_invoice_idx on invoices.vf_records (issued_invoice_id);

-- Registro de eventos con su propia cadena (HuellaEvento). Lo escribirá el interruptor del envío (PR 2).
create table invoices.vf_events (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  seq bigint not null unique,
  event_type text not null check (event_type ~ '^\d{2}$'),
  detail jsonb,
  first_event boolean not null,
  previous_hash text,
  generated_at timestamptz not null,
  generated_at_text text not null,
  hash text not null check (hash ~ '^[0-9A-F]{64}$'),
  created_by uuid
);

-- Registradas en el núcleo sin roles de lectura ni escritura: no se sincronizan al dispositivo ni se escriben con
-- operaciones de fila. Las escriben solo los procedimientos de este archivo; la app las ve con invoices.vf_records_of.
select core.register_table('invoices', 'invoices', 'vf_state', array[]::text[], '{}', '{}', true);
select core.register_table('invoices', 'invoices', 'vf_records', array[]::text[], '{}', '{}', true);
select core.register_table('invoices', 'invoices', 'vf_events', array[]::text[], '{}', '{}', true);

-- Solo los procedimientos escriben; nada se borra; un registro solo cambia en sus campos de envío.
create or replace function invoices.guard_vf_immutable()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then perform core.fail('VF_IMMUTABLE', 409, jsonb_build_object('table', tg_table_name)); end if;
  if not invoices.issuing() then perform core.fail('VF_IMMUTABLE', 409, jsonb_build_object('table', tg_table_name)); end if;
  if tg_op = 'UPDATE' and tg_table_name = 'vf_records'
     and (to_jsonb(new) - array['send_status', 'sent_at', 'csv', 'errors', 'revision', 'updated_at', 'updated_by']) <> (to_jsonb(old) - array['send_status', 'sent_at', 'csv', 'errors', 'revision', 'updated_at', 'updated_by']) then
    perform core.fail('VF_IMMUTABLE', 409, jsonb_build_object('table', tg_table_name, 'id', old.id));
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'vf_events' then perform core.fail('VF_IMMUTABLE', 409, jsonb_build_object('table', tg_table_name)); end if;
  return coalesce(new, old);
end $$;
create trigger vf_records_guard before insert or update or delete on invoices.vf_records for each row execute function invoices.guard_vf_immutable();
create trigger vf_events_guard before insert or update or delete on invoices.vf_events for each row execute function invoices.guard_vf_immutable();
create trigger vf_state_guard before update or delete on invoices.vf_state for each row execute function invoices.guard_vf_immutable();

-- ---------------------------------------------------------------------------
-- Huella, fechas y QR (mismas reglas que _domain/invoices/verifactu.ts)
-- ---------------------------------------------------------------------------
create or replace function invoices.vf_hash(p text) returns text language sql immutable as $$
  select upper(encode(sha256(convert_to(p, 'UTF8')), 'hex'));
$$;

create or replace function invoices.vf_amount(p numeric) returns text language sql immutable as $$
  select to_char(round(p, 2), 'FM999999999990.00');
$$;

create or replace function invoices.vf_alta_input(p_nif text, p_num text, p_date text, p_type text, p_quota numeric, p_amount numeric, p_prev text, p_gen text)
returns text language sql immutable as $$
  select 'IDEmisorFactura=' || btrim(coalesce(p_nif, '')) || '&NumSerieFactura=' || btrim(coalesce(p_num, '')) || '&FechaExpedicionFactura=' || btrim(coalesce(p_date, ''))
    || '&TipoFactura=' || btrim(coalesce(p_type, '')) || '&CuotaTotal=' || coalesce(invoices.vf_amount(p_quota), '') || '&ImporteTotal=' || coalesce(invoices.vf_amount(p_amount), '')
    || '&Huella=' || btrim(coalesce(p_prev, '')) || '&FechaHoraHusoGenRegistro=' || btrim(coalesce(p_gen, ''));
$$;

create or replace function invoices.vf_anulacion_input(p_nif text, p_num text, p_date text, p_prev text, p_gen text)
returns text language sql immutable as $$
  select 'IDEmisorFacturaAnulada=' || btrim(coalesce(p_nif, '')) || '&NumSerieFacturaAnulada=' || btrim(coalesce(p_num, '')) || '&FechaExpedicionFacturaAnulada=' || btrim(coalesce(p_date, ''))
    || '&Huella=' || btrim(coalesce(p_prev, '')) || '&FechaHoraHusoGenRegistro=' || btrim(coalesce(p_gen, ''));
$$;

-- FechaHoraHusoGenRegistro en hora de Madrid con su huso: 2026-10-07T12:30:00+02:00
create or replace function invoices.vf_time_text(p timestamptz) returns text language sql stable as $$
  select to_char(p at time zone 'Europe/Madrid', 'YYYY-MM-DD"T"HH24:MI:SS')
    || case when o.s >= 0 then '+' else '-' end || lpad((abs(o.s) / 3600)::text, 2, '0') || ':' || lpad(((abs(o.s) % 3600) / 60)::text, 2, '0')
  from (select extract(epoch from ((p at time zone 'Europe/Madrid') - (p at time zone 'UTC')))::int as s) o;
$$;

create or replace function invoices.url_encode(p text) returns text language plpgsql immutable as $$
declare b bytea := convert_to(coalesce(p, ''), 'UTF8'); i int; c int; v text := '';
begin
  for i in 0 .. length(b) - 1 loop
    c := get_byte(b, i);
    if (c between 48 and 57) or (c between 65 and 90) or (c between 97 and 122) or c in (45, 46, 95, 126) then v := v || chr(c);
    else v := v || '%' || upper(lpad(to_hex(c), 2, '0')); end if;
  end loop;
  return v;
end $$;

-- URL de cotejo del QR (especificación del QR v0.5.0, §5.1): sistema que emite facturas verificables.
create or replace function invoices.vf_qr_url(p_env text, p_nif text, p_num text, p_date text, p_amount numeric) returns text language sql immutable as $$
  select case when p_env = 'pruebas' then 'https://prewww2.aeat.es' else 'https://www2.agenciatributaria.gob.es' end
    || '/wlpl/TIKE-CONT/ValidarQR?nif=' || invoices.url_encode(p_nif) || '&numserie=' || invoices.url_encode(p_num)
    || '&fecha=' || invoices.url_encode(p_date) || '&importe=' || invoices.vf_amount(p_amount);
$$;

create or replace function invoices.vf_system_json(s invoices.vf_state) returns jsonb language sql immutable as $$
  select jsonb_build_object('NombreRazon', s.producer_name, 'NIF', s.producer_tax_id, 'NombreSistemaInformatico', s.system_name, 'IdSistemaInformatico', s.system_id,
    'Version', s.version, 'NumeroInstalacion', s.installation_number, 'TipoUsoPosibleSoloVerifactu', s.only_verifactu, 'TipoUsoPosibleMultiOT', s.multi_ot,
    'IndicadorMultiplesOT', s.multiple_ot);
$$;

-- Desglose de una emitida (con desglose manda el desglose; sin él, las líneas por impuesto y tipo, como recalculate_issued).
create or replace function invoices.issued_breakdown(p_id uuid) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x order by x->>'tax', (x->>'rate')::numeric nulls first), '[]'::jsonb) from (
    select jsonb_build_object('tax', t.tax, 'regime_key', t.regime_key, 'qualification', t.qualification, 'exemption', t.exemption, 'rate', t.rate,
      'base', coalesce(t.taxable_base, 0), 'quota', t.quota, 'surcharge_rate', t.surcharge_rate, 'surcharge_quota', coalesce(t.surcharge_quota, 0)) x
      from invoices.issued_tax_lines t where t.issued_invoice_id = p_id and t.deleted_at is null and t.tax not in ('irpf', 'otra_retencion')
    union all
    select jsonb_build_object('tax', g.tax, 'regime_key', '01', 'qualification', 'S1', 'exemption', null, 'rate', g.vat_rate, 'base', g.net,
      'quota', case when g.all_amounts then g.amounts else round(g.net * coalesce(g.vat_rate, 0) / 100, 2) end,
      'surcharge_rate', g.surcharge_rate, 'surcharge_quota', case when g.all_surcharge then g.surcharges else round(g.net * coalesce(g.surcharge_rate, 0) / 100, 2) end)
      from (select l.tax, l.vat_rate, l.surcharge_rate, sum(l.net_amount) net, bool_and(l.vat_amount is not null) all_amounts, sum(coalesce(l.vat_amount, 0)) amounts,
                   bool_and(l.surcharge_amount is not null) all_surcharge, sum(coalesce(l.surcharge_amount, 0)) surcharges
              from invoices.issued_invoice_lines l
             where l.issued_invoice_id = p_id and l.deleted_at is null
               and not exists (select 1 from invoices.issued_tax_lines t where t.issued_invoice_id = p_id and t.deleted_at is null and t.tax not in ('irpf', 'otra_retencion'))
             group by l.tax, l.vat_rate, l.surcharge_rate) g) y;
$$;

-- Añade un registro a la cadena (bloquea la cabeza). Devuelve el registro.
create or replace function invoices.vf_append(p_kind text, p_invoice uuid, p_nif text, p_num text, p_date text, p_type text, p_quota numeric, p_amount numeric,
  p_payload jsonb, p_actor uuid) returns invoices.vf_records language plpgsql as $$
declare ch invoices.vf_state; v_gen timestamptz := now(); v_gen_text text; v_hash text; v_payload jsonb; rec invoices.vf_records;
begin
  select * into ch from invoices.vf_state where singleton for update;
  v_gen_text := invoices.vf_time_text(v_gen);
  v_hash := invoices.vf_hash(case when p_kind = 'alta' then invoices.vf_alta_input(p_nif, p_num, p_date, p_type, p_quota, p_amount, ch.last_hash, v_gen_text)
                                  else invoices.vf_anulacion_input(p_nif, p_num, p_date, ch.last_hash, v_gen_text) end);
  v_payload := jsonb_strip_nulls(p_payload || jsonb_build_object(
    'Encadenamiento', case when ch.last_hash is null then jsonb_build_object('PrimerRegistro', 'S')
                           else jsonb_build_object('RegistroAnterior', ch.last_ref || jsonb_build_object('Huella', ch.last_hash)) end,
    'SistemaInformatico', invoices.vf_system_json(ch),
    'FechaHoraHusoGenRegistro', v_gen_text, 'TipoHuella', '01', 'Huella', v_hash));
  insert into invoices.vf_records (seq, record_kind, issued_invoice_id, issuer_tax_id, num_serie, issue_date_text, invoice_type, quota_total, amount_total,
      first_record, previous_hash, previous_ref, generated_at, generated_at_text, hash, payload, send_status, created_by)
    values (ch.last_seq + 1, p_kind, p_invoice, p_nif, p_num, p_date, p_type, p_quota, p_amount,
      ch.last_hash is null, ch.last_hash, ch.last_ref, v_gen, v_gen_text, v_hash, v_payload,
      case when ch.sending = 'apagado' then 'no_enviar' else 'pendiente' end, p_actor)
    returning * into rec;
  update invoices.vf_state set last_seq = rec.seq, last_hash = v_hash,
    last_ref = jsonb_build_object('IDEmisorFactura', p_nif, 'NumSerieFactura', p_num, 'FechaExpedicionFactura', p_date) where id = ch.id;
  return rec;
end $$;

-- ---------------------------------------------------------------------------
-- Emitir
-- ---------------------------------------------------------------------------
create or replace function invoices.issue(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args';
  v_issuer jsonb := a->'issuer';
  v invoices.issued_invoices; s invoices.issued_series; st invoices.vf_state; rec invoices.vf_records;
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
  perform set_config('invoices.issuing', 'off', true);
  return jsonb_build_object('id', v.id, 'full_number', v_full, 'issue_date', v_today, 'vf_hash', rec.hash, 'vf_status', rec.send_status, 'seq', rec.seq);
end $$;
select core.allow_procedure('invoices', 'invoices.issue');

-- ---------------------------------------------------------------------------
-- Anular: en una registrada, como hasta ahora; en una emitida, solo el owner y con registro de anulación.
-- Un borrador no se anula: se borra.
-- ---------------------------------------------------------------------------
create or replace function invoices.annul_issued(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v invoices.issued_invoices; al record; rec invoices.vf_records; v_date_text text;
begin
  begin select * into v from invoices.issued_invoices where id = (a->>'issued_invoice_id')::uuid for update; exception when others then v.id := null; end;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.issued_invoices', 'id', a->>'issued_invoice_id')); end if;
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  if v.status = 'anulada' then perform core.fail('ISSUED_ANNULLED', 409, jsonb_build_object('id', v.id)); end if;
  if v.status = 'borrador' then perform core.fail('ISSUED_IS_DRAFT', 422, jsonb_build_object('id', v.id)); end if;
  if nullif(btrim(coalesce(a->>'reason', '')), '') is null then perform core.fail('ANNUL_REASON_REQUIRED', 422, jsonb_build_object('issued_invoice_id', v.id)); end if;
  perform set_config('invoices.issuing', 'on', true);
  if v.status in ('emitida', 'rectificada') then
    if coalesce(p->>'role', '') <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.annul_issued', 'reason', 'only owners annul issued invoices')); end if;
    v_date_text := to_char(v.issue_date, 'DD-MM-YYYY');
    rec := invoices.vf_append('anulacion', v.id, v.issuer_tax_id, v.full_number, v_date_text, null, null, null,
      jsonb_build_object('IDVersion', '1.0', 'IDFactura', jsonb_build_object('IDEmisorFacturaAnulada', v.issuer_tax_id, 'NumSerieFacturaAnulada', v.full_number,
        'FechaExpedicionFacturaAnulada', v_date_text)), (p->>'actor')::uuid);
  end if;
  for al in select * from invoices.issued_allocations where issued_invoice_id = v.id and deleted_at is null loop
    perform invoices.row_op(p, jsonb_build_object('op', 'delete', 'table', 'invoices.issued_allocations', 'id', al.id, 'expectedRevision', al.revision));
  end loop;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', v.revision,
    'fields', jsonb_build_object('status', 'anulada', 'annulled_reason', btrim(a->>'reason'))));
  perform set_config('invoices.issuing', 'off', true);
  select * into v from invoices.issued_invoices where id = v.id;
  return to_jsonb(v) || case when rec.id is not null then jsonb_build_object('vf_annulment_hash', rec.hash) else '{}'::jsonb end;
end $$;

-- Lectura del registro de una emitida (para la ficha y la gestoría): sus registros de alta y anulación, sin el payload.
create or replace function invoices.vf_records_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('records', coalesce(jsonb_agg(jsonb_build_object('seq', r.seq, 'record_kind', r.record_kind, 'hash', r.hash, 'previous_hash', r.previous_hash,
      'generated_at_text', r.generated_at_text, 'send_status', r.send_status, 'csv', r.csv) order by r.seq), '[]'::jsonb),
    'settings', (select jsonb_build_object('sending', s.sending, 'locked_until', s.locked_until) from invoices.vf_state s where s.singleton))
  from invoices.vf_records r where r.issued_invoice_id = (p->'args'->>'issued_invoice_id')::uuid;
$$;
select core.allow_read('invoices', 'invoices.vf_records_of', 'function');

revoke all on function invoices.issue(jsonb), invoices.annul_issued(jsonb), invoices.vf_append(text, uuid, text, text, text, text, numeric, numeric, jsonb, uuid),
  invoices.vf_records_of(jsonb), invoices.guard_vf_immutable() from public, anon, authenticated;
