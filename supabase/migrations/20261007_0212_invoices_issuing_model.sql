-- Invoices · emitir facturas desde Finance, PR 1: modelo de emisión (API.md §14, aprobada por Core en la ronda 41).
-- Toca solo el schema invoices.
--
-- - Series de emisión (`mode = 'emision'`) frente a las de registro de otra herramienta; cierre de una serie.
-- - Borradores sin número; el número lo asigna `invoices.issue` en el servidor (migración 0213), con el contador de la
--   serie, que se bloquea en la transacción: sin huecos ni duplicados.
-- - Una emitida no se edita (solo cobro, notas y categoría); sus líneas y su desglose quedan congelados.
-- - Los borradores se pueden borrar; las emitidas, no.
-- - Resúmenes y entregas a la gestoría cuentan las emitidas y rectificadas como las registradas, y nunca los borradores.
--
-- Los procedimientos de emisión marcan la transacción con `invoices.issuing = on` mientras escriben lo que el cliente
-- no puede escribir (número, estado emitida, campos de emisión y de Verifactu), y la desmarcan al terminar.

-- ---------------------------------------------------------------------------
-- Series
-- ---------------------------------------------------------------------------
alter table invoices.issued_series
  add column mode text not null default 'registro' check (mode in ('registro', 'emision')),
  add column closed_at timestamptz,
  add column closed_last_number text check (closed_last_number is null or length(btrim(closed_last_number)) between 1 and 40),
  -- Contador de numeración: año en curso (null si la serie no reinicia), último número y su fecha. Solo lo escribe
  -- invoices.issue, que bloquea la fila de la serie: sin huecos ni duplicados.
  add column counter_year int,
  add column counter_last int not null default 0 check (counter_last >= 0),
  add column counter_last_date date;

select core.register_table('invoices', 'invoices', 'issued_series', array['code', 'description', 'kind', 'yearly', 'format', 'active', 'mode', 'closed_at', 'closed_last_number',
  'counter_year', 'counter_last', 'counter_last_date'], '{reader,editor,owner}', '{editor,owner}', true);

create or replace function invoices.issuing() returns boolean language sql stable as $$
  select coalesce(current_setting('invoices.issuing', true), '') = 'on';
$$;

-- Una serie de emisión no cambia de modo, formato ni reinicio cuando ya ha emitido; el cierre solo por procedimiento.
create or replace function invoices.guard_issued_series()
returns trigger language plpgsql as $$
begin
  if (new.closed_at is distinct from old.closed_at or new.closed_last_number is distinct from old.closed_last_number or new.counter_year is distinct from old.counter_year
      or new.counter_last is distinct from old.counter_last or new.counter_last_date is distinct from old.counter_last_date) and not invoices.issuing() then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('reason', 'use invoices.close_series'));
  end if;
  if (new.mode is distinct from old.mode or new.format is distinct from old.format or new.yearly is distinct from old.yearly or upper(btrim(new.code)) <> upper(btrim(old.code)))
     and (old.counter_last > 0
          or exists (select 1 from invoices.issued_invoices i where upper(btrim(i.series_code)) = upper(btrim(old.code)) and i.deleted_at is null and i.status <> 'borrador')) then
    perform core.fail('SERIES_IN_USE', 409, jsonb_build_object('code', old.code));
  end if;
  return new;
end $$;
create trigger issued_series_guard before update on invoices.issued_series for each row execute function invoices.guard_issued_series();

-- Formato del número: {serie}, {año} y {n} o {n:K} (relleno con ceros a K cifras).
create or replace function invoices.format_issued_number(p_format text, p_code text, p_year int, p_n int)
returns text language plpgsql immutable as $$
declare v text := p_format; m text[];
begin
  v := replace(replace(v, '{serie}', btrim(p_code)), '{año}', p_year::text);
  m := regexp_match(v, '\{n:(\d)\}');
  if m is not null then v := regexp_replace(v, '\{n:\d\}', lpad(p_n::text, m[1]::int, '0'));
  else v := replace(v, '{n}', p_n::text); end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Emitidas: borradores, emitidas y rectificadas
-- ---------------------------------------------------------------------------
alter table invoices.issued_invoices drop constraint issued_invoices_status_check;
alter table invoices.issued_invoices add constraint issued_invoices_status_check check (status in ('registrada', 'anulada', 'borrador', 'emitida', 'rectificada'));
alter table invoices.issued_invoices alter column number drop not null;
alter table invoices.issued_invoices add constraint issued_number_ck check (number is not null or status = 'borrador');
alter table invoices.issued_invoices drop constraint issued_recipient_ck;
alter table invoices.issued_invoices add constraint issued_recipient_ck check (
  status = 'borrador' or invoice_type in ('F2', 'R5') or (nullif(btrim(coalesce(recipient_name, '')), '') is not null and nullif(btrim(coalesce(recipient_tax_id, '')), '') is not null));
alter table invoices.issued_invoices drop constraint issued_invoices_vf_status_check;
alter table invoices.issued_invoices add constraint issued_invoices_vf_status_check check (vf_status in ('no_enviar', 'pendiente', 'enviado', 'aceptado', 'aceptado_con_errores', 'rechazado'));
alter table invoices.issued_invoices
  add column recipient_address jsonb check (recipient_address is null or jsonb_typeof(recipient_address) = 'object'),
  add column recipient_kind text check (recipient_kind in ('empresa', 'profesional', 'particular')),
  add column prices_include_vat boolean not null default false,
  add column issued_at timestamptz,
  add column issued_by uuid,
  add column document jsonb check (document is null or jsonb_typeof(document) = 'object'),
  add column rectified_by jsonb not null default '[]'::jsonb check (jsonb_typeof(rectified_by) = 'array');

-- Columnas que escribe el cliente y, además, las que solo escriben los procedimientos de emisión (la Edge rechaza
-- que el cliente las mande y los disparadores exigen invoices.issuing).
select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
  'issuer_tax_id', 'issuer_name', 'issuer',
  'recipient_address', 'recipient_kind', 'prices_include_vat',
  'issued_at', 'issued_by', 'document', 'rectified_by',
  'vf_record_kind', 'vf_hash', 'vf_previous_hash', 'vf_previous_ref', 'vf_first_record', 'vf_generated_at', 'vf_status', 'vf_csv', 'vf_errors', 'vf_qr_url', 'vf_system'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- Reglas por modo de serie y congelación de la emitida.
create or replace function invoices.guard_issued_invoice()
returns trigger language plpgsql as $$
declare
  s invoices.issued_series;
  v_old jsonb; v_new jsonb;
  -- Lo único que cambia en una emitida fuera de los procedimientos (full_number, fiscal_year y fiscal_quarter son generadas y en BEFORE llegan vacías;
  -- el borrado lo rechaza issued_invoices_no_delete con su propio código)
  v_free text[] := array['payment_status', 'paid_at', 'notes', 'income_category', 'review_reason', 'totals_delta', 'revision', 'updated_at', 'updated_by', 'deleted_at', 'full_number', 'fiscal_year', 'fiscal_quarter'];
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
create trigger issued_invoices_guard before insert or update on invoices.issued_invoices for each row execute function invoices.guard_issued_invoice();

-- Líneas y desglose de una emitida: congelados. Documentos y destino del ingreso siguen abiertos.
create or replace function invoices.guard_issued_children_frozen()
returns trigger language plpgsql as $$
declare v_status text;
begin
  if invoices.issuing() then return new; end if;
  select status into v_status from invoices.issued_invoices where id = new.issued_invoice_id;
  if v_status in ('emitida', 'rectificada') then perform core.fail('ISSUED_FROZEN', 409, jsonb_build_object('id', new.issued_invoice_id)); end if;
  if tg_op = 'UPDATE' and old.issued_invoice_id <> new.issued_invoice_id then
    select status into v_status from invoices.issued_invoices where id = old.issued_invoice_id;
    if v_status in ('emitida', 'rectificada') then perform core.fail('ISSUED_FROZEN', 409, jsonb_build_object('id', old.issued_invoice_id)); end if;
  end if;
  return new;
end $$;
create trigger issued_lines_frozen before insert or update on invoices.issued_invoice_lines for each row execute function invoices.guard_issued_children_frozen();
create trigger issued_taxes_frozen before insert or update on invoices.issued_tax_lines for each row execute function invoices.guard_issued_children_frozen();

-- Sin papelera, salvo para los borradores (y lo que cuelga de ellos).
create or replace function invoices.guard_issued_delete()
returns trigger language plpgsql as $$
declare v_status text;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    if tg_table_name = 'issued_invoices' then v_status := old.status;
    else select status into v_status from invoices.issued_invoices where id = old.issued_invoice_id; end if;
    if v_status is distinct from 'borrador' then
      perform core.fail('ISSUED_NOT_DELETABLE', 422, jsonb_build_object('table', tg_table_schema || '.' || tg_table_name, 'id', old.id));
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Cerrar una serie (p. ej. la de la hoja de Google) en su último número. Solo el owner.
-- ---------------------------------------------------------------------------
create or replace function invoices.close_series(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; s invoices.issued_series;
begin
  if coalesce(p->>'role', '') <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.close_series')); end if;
  select * into s from invoices.issued_series where upper(btrim(code)) = upper(btrim(coalesce(a->>'code', ''))) and deleted_at is null for update;
  if s.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.issued_series', 'code', a->>'code')); end if;
  if s.closed_at is not null then perform core.fail('SERIES_CLOSED', 409, jsonb_build_object('code', s.code, 'last_number', s.closed_last_number)); end if;
  if nullif(btrim(coalesce(a->>'last_number', '')), '') is null then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'last_number')); end if;
  perform set_config('invoices.issuing', 'on', true);
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_series', 'id', s.id, 'expectedRevision', s.revision,
    'fields', jsonb_build_object('closed_at', now(), 'closed_last_number', btrim(a->>'last_number'), 'active', false)));
  perform set_config('invoices.issuing', 'off', true);
  select * into s from invoices.issued_series where id = s.id;
  return to_jsonb(s);
end $$;
select core.allow_procedure('invoices', 'invoices.close_series');

-- ---------------------------------------------------------------------------
-- Resúmenes y entregas (de 0206): las emitidas y rectificadas cuentan como las registradas; los borradores, nunca.
-- ---------------------------------------------------------------------------
create or replace function invoices.issued_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.issued_invoices i where i.deleted_at is null and i.status <> 'borrador' and i.issue_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
  summed as (select * from live where status in ('registrada', 'emitida', 'rectificada')),
  with_breakdown as (
    select distinct t.issued_invoice_id from invoices.issued_tax_lines t join summed s on s.id = t.issued_invoice_id
    where t.deleted_at is null and t.tax not in ('irpf', 'otra_retencion')),
  rates as (
    select t.tax, t.rate, coalesce(t.taxable_base, 0) base, t.quota, coalesce(t.surcharge_quota, 0) surcharge
    from invoices.issued_tax_lines t join summed s on s.id = t.issued_invoice_id
    where t.deleted_at is null and t.tax not in ('irpf', 'otra_retencion')
    union all
    select l.tax, l.vat_rate, l.net_amount, coalesce(l.vat_amount, round(l.net_amount * coalesce(l.vat_rate, 0) / 100, 2)), coalesce(l.surcharge_amount, 0)
    from invoices.issued_invoice_lines l join summed s on s.id = l.issued_invoice_id
    where l.deleted_at is null and l.issued_invoice_id not in (select issued_invoice_id from with_breakdown))
  select jsonb_build_object(
    'invoices', jsonb_build_object('registrada', (select count(*) from summed), 'anulada', (select count(*) from live where status = 'anulada')),
    'base', (select coalesce(sum(base_total), 0) from summed),
    'quota', (select coalesce(sum(quota_total), 0) from summed),
    'surcharge', (select coalesce(sum(surcharge_total), 0) from summed),
    'withholding', (select coalesce(sum(withholding_total), 0) from summed),
    'total', (select coalesce(sum(total), 0) from summed),
    'quota_by_rate', (select coalesce(jsonb_agg(jsonb_build_object('tax', g.tax, 'rate', g.rate, 'base', g.base, 'quota', g.quota, 'surcharge', g.surcharge) order by g.tax, g.rate nulls first), '[]'::jsonb)
      from (select tax, rate, sum(base) base, sum(quota) quota, sum(surcharge) surcharge from rates group by tax, rate) g),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('income_category', c.income_category, 'base', c.base, 'total', c.total, 'count', c.n) order by c.income_category nulls last), '[]'::jsonb)
      from (select income_category, sum(base_total) base, sum(total) total, count(*) n from summed group by income_category) c),
    'alerts', jsonb_build_object(
      'unpaid', (select count(*) from summed where payment_status <> 'cobrada'),
      'discrepancies', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'full_number', full_number, 'totals_delta', totals_delta) order by issue_date, full_number), '[]'::jsonb)
        from summed where review_reason = 'REVISAR IMPORTES'),
      'missing_file', (select count(*) from summed s where not exists (select 1 from invoices.issued_invoice_files f where f.issued_invoice_id = s.id and f.deleted_at is null))));
$$;

create or replace function invoices.issued_manifest(p_from date, p_to date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', i.id, 'full_number', i.full_number, 'revision', i.revision, 'series', i.series_code, 'number', i.number,
      'issue_date', i.issue_date, 'operation_date', i.operation_date, 'invoice_type', i.invoice_type,
      'rectification', case when i.invoice_type like 'R%' then jsonb_build_object('kind', i.rectification_kind, 'rectified', i.rectified, 'reason', i.rectification_reason) else null end,
      'recipient', jsonb_build_object('name', i.recipient_name, 'tax_id', i.recipient_tax_id, 'id_type', i.recipient_id_type, 'country', i.recipient_country),
      'description', i.description, 'income_category', i.income_category, 'origin', i.origin, 'external_tool', i.external_tool,
      'base', i.base_total, 'quota', i.quota_total, 'surcharge', i.surcharge_total, 'withholding', i.withholding_total, 'total', i.total,
      'source_total', i.source_total, 'totals_delta', i.totals_delta, 'status', i.status, 'annulled_reason', i.annulled_reason,
      'payment', jsonb_build_object('status', i.payment_status, 'paid_at', i.paid_at),
      'taxes', (select coalesce(jsonb_agg(jsonb_build_object('tax', t.tax, 'regime_key', t.regime_key, 'qualification', t.qualification, 'exemption', t.exemption,
          'rate', t.rate, 'taxable_base', t.taxable_base, 'quota', t.quota, 'surcharge_rate', t.surcharge_rate, 'surcharge_quota', t.surcharge_quota) order by t.position), '[]'::jsonb)
        from invoices.issued_tax_lines t where t.issued_invoice_id = i.id and t.deleted_at is null),
      'lines', (select coalesce(jsonb_agg(jsonb_build_object('position', l.position, 'description', l.description, 'quantity', l.quantity, 'unit', l.unit, 'unit_price', l.unit_price,
          'discount_amount', l.discount_amount, 'net_amount', l.net_amount, 'tax', l.tax, 'vat_rate', l.vat_rate, 'vat_amount', l.vat_amount) order by l.position), '[]'::jsonb)
        from invoices.issued_invoice_lines l where l.issued_invoice_id = i.id and l.deleted_at is null),
      'allocations', (select coalesce(jsonb_agg(jsonb_build_object('target_app', a.target_app, 'target_kind', a.target_kind, 'target_label', a.target_label, 'allocated_amount', a.allocated_amount) order by a.created_at), '[]'::jsonb)
        from invoices.issued_allocations a where a.issued_invoice_id = i.id and a.deleted_at is null),
      'files', (select coalesce(jsonb_agg(jsonb_build_object('name', 'emitidas/' || f.normalized_filename, 'file_id', f.file_id, 'page_order', f.page_order,
          'sha256', f.sha256, 'size_bytes', f.size_bytes, 'mime_type', f.mime_type) order by f.page_order), '[]'::jsonb)
        from invoices.issued_invoice_files f where f.issued_invoice_id = i.id and f.deleted_at is null)
    ) order by i.issue_date, i.full_number), '[]'::jsonb)
  from invoices.issued_invoices i where i.deleted_at is null and i.status <> 'borrador' and i.issue_date between p_from and p_to;
$$;

create or replace function invoices.export_manifest_v2(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with issued as (select invoices.issued_manifest(p_from, p_to) list)
  select invoices.export_manifest(p_from, p_to, p_kind, p_year, p_quarter, p_folder)
    || jsonb_build_object(
      'issued_count', (select count(*) from issued, jsonb_array_elements(issued.list) x where x->>'status' in ('registrada', 'emitida', 'rectificada')),
      'issued_file_count', (select count(*) from issued, jsonb_array_elements(issued.list) x, jsonb_array_elements(x->'files') f),
      'issued_totals', invoices.issued_summary_for(p_from, p_to),
      'issued', (select list from issued));
$$;

create or replace function invoices.export_bundle(p jsonb)
returns jsonb language plpgsql stable as $$
declare e invoices.exports;
begin
  begin select * into e from invoices.exports where id = (p->'args'->>'export_id')::uuid; exception when others then e.id := null; end;
  if e.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.exports', 'id', p->'args'->>'export_id')); end if;
  return jsonb_build_object(
    'export', to_jsonb(e) - 'manifest',
    'manifest_text', e.manifest::text,
    'manifest', e.manifest,
    'files', (select coalesce(jsonb_agg(x order by x->>'folder', x->>'invoice_code', x->>'normalized_filename'), '[]'::jsonb) from (
        select jsonb_build_object('folder', 'facturas', 'invoice_code', ei.invoice_code, 'file_id', f->>'file_id', 'normalized_filename', f->>'normalized_filename',
          'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint, 'bucket', cf.bucket, 'path', cf.path, 'status', cf.status) x
        from invoices.export_items ei, jsonb_array_elements(ei.files) f left join core.files cf on cf.id = (f->>'file_id')::uuid where ei.export_id = e.id
        union all
        select jsonb_build_object('folder', 'emitidas', 'invoice_code', iss->>'full_number', 'file_id', f->>'file_id', 'normalized_filename', substr(f->>'name', 10),
          'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint, 'bucket', cf.bucket, 'path', cf.path, 'status', cf.status)
        from jsonb_array_elements(coalesce(e.manifest->'issued', '[]'::jsonb)) iss, jsonb_array_elements(iss->'files') f left join core.files cf on cf.id = (f->>'file_id')::uuid
      ) files),
    'stale', exists (select 1 from invoices.export_items ei join invoices.invoices i on i.id = ei.invoice_id where ei.export_id = e.id and (i.revision <> ei.invoice_revision or i.status = 'anulada'))
      or exists (select 1 from invoices.invoices i where i.deleted_at is null and i.status in ('validada', 'archivada') and i.invoice_date between e.from_date and e.to_date
                 and not exists (select 1 from invoices.export_items ei where ei.export_id = e.id and ei.invoice_id = i.id))
      or (e.manifest ? 'issued' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss join invoices.issued_invoices ii on ii.id = (iss->>'id')::uuid where ii.revision <> (iss->>'revision')::bigint)
        or exists (select 1 from invoices.issued_invoices ii where ii.deleted_at is null and ii.status <> 'borrador' and ii.issue_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id)))));
end $$;
