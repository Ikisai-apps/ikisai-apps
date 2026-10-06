-- Invoices · emitidas en el resumen fiscal y en la entrega a la gestoría (API.md §13.4, ronda 23). Toca solo el schema invoices.
--
-- 1. `invoices.issued_summary_for` / lectura `invoices.issued_summary`: IVA repercutido del periodo (misma forma que
--    `issuedSummary` en `_domain/invoices/issued.ts`).
-- 2. La entrega incluye las emitidas del periodo: `issued` en el manifest (registradas y anuladas, para que se vea la
--    numeración completa), sus documentos en `emitidas/` y `issued_totals`. Las entregas ya creadas conservan su manifest.

-- ---------------------------------------------------------------------------
-- Resumen de emitidas
-- ---------------------------------------------------------------------------
create or replace function invoices.issued_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.issued_invoices i where i.deleted_at is null and i.issue_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
  summed as (select * from live where status = 'registrada'),
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

create or replace function invoices.issued_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_range jsonb := invoices.range_of(coalesce(p->'args', '{}'::jsonb));
begin
  return jsonb_build_object('range', v_range) || invoices.issued_summary_for((v_range->>'from')::date, (v_range->>'to')::date);
end $$;
select core.allow_read('invoices', 'invoices.issued_summary', 'function');

-- ---------------------------------------------------------------------------
-- Entrega a la gestoría: manifest con emitidas
-- ---------------------------------------------------------------------------
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
  from invoices.issued_invoices i where i.deleted_at is null and i.issue_date between p_from and p_to;
$$;

-- El manifest de 0201 más las emitidas (`issued_count`, `issued_file_count`, `issued_totals`, `issued`).
create or replace function invoices.export_manifest_v2(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with issued as (select invoices.issued_manifest(p_from, p_to) list)
  select invoices.export_manifest(p_from, p_to, p_kind, p_year, p_quarter, p_folder)
    || jsonb_build_object(
      'issued_count', (select count(*) from issued, jsonb_array_elements(issued.list) x where x->>'status' = 'registrada'),
      'issued_file_count', (select count(*) from issued, jsonb_array_elements(issued.list) x, jsonb_array_elements(x->'files') f),
      'issued_totals', invoices.issued_summary_for(p_from, p_to),
      'issued', (select list from issued));
$$;

create or replace function invoices.create_export(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_id uuid; v_range jsonb; v_kind text; v_year int; v_quarter int; v_from date; v_to date; v_folder text; v_manifest jsonb; v_sha text; v_count int; inv jsonb; v_row jsonb;
begin
  perform set_config('invoices.procedure', 'create_export', true);
  begin v_id := (a->>'export_id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'export_id required')); end if;
  v_kind := a->>'period_kind';
  if v_kind = 'quarter' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year', 'quarter', a->'fiscal_quarter'));
  elsif v_kind = 'year' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year'));
  elsif v_kind = 'custom' then v_range := invoices.range_of(jsonb_build_object('from', a->'from_date', 'to', a->'to_date'));
  else perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'period_kind must be quarter, year or custom')); end if;
  v_year := (v_range->>'year')::int; v_quarter := (v_range->>'quarter')::int; v_from := (v_range->>'from')::date; v_to := (v_range->>'to')::date;
  v_folder := case v_kind when 'quarter' then format('IKISAI_COMPRAS_%s_T%s', v_year, v_quarter) when 'year' then format('IKISAI_COMPRAS_%s', v_year)
    else format('IKISAI_COMPRAS_%s_%s', to_char(v_from, 'YYYY_MM_DD'), to_char(v_to, 'YYYY_MM_DD')) end;
  v_manifest := invoices.export_manifest_v2(v_from, v_to, v_kind, v_year, v_quarter, v_folder);
  v_count := (v_manifest->>'invoice_count')::int;
  -- Una entrega vacía de recibidas vale si hay emitidas registradas en el periodo.
  if v_count = 0 and coalesce((v_manifest->>'issued_count')::int, 0) = 0 then perform core.fail('EXPORT_EMPTY', 422, jsonb_build_object('from', v_from, 'to', v_to)); end if;
  v_sha := encode(sha256(convert_to(v_manifest::text, 'UTF8')), 'hex');
  perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.exports', 'id', v_id, 'fields', jsonb_build_object(
    'period_kind', v_kind, 'fiscal_year', v_year, 'fiscal_quarter', v_quarter, 'from_date', v_from, 'to_date', v_to, 'folder_name', v_folder,
    'invoice_count', v_count, 'totals', v_manifest->'totals', 'manifest', v_manifest, 'manifest_sha256', v_sha, 'status', 'generada')));
  for inv in select * from jsonb_array_elements(v_manifest->'invoices') loop
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.export_items', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'export_id', v_id, 'invoice_id', inv->>'id', 'invoice_code', inv->>'code', 'invoice_revision', (inv->>'revision')::bigint,
      'files', (select coalesce(jsonb_agg(jsonb_build_object('file_id', f->>'file_id', 'normalized_filename', substr(f->>'name', 10), 'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint)), '[]'::jsonb) from jsonb_array_elements(inv->'files') f))));
  end loop;
  select to_jsonb(e) into v_row from invoices.exports e where e.id = v_id;
  return jsonb_build_object('export_id', v_id, 'code', v_row->>'code', 'folder_name', v_folder, 'invoice_count', v_count, 'issued_count', coalesce((v_manifest->>'issued_count')::int, 0), 'manifest_sha256', v_sha,
    'warnings', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v_manifest->'excluded') x));
end $$;

-- Vista previa (POST exports/accountant) con las emitidas.
create or replace function invoices.export_preview(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); v_range jsonb; v_kind text := coalesce(a->>'period_kind', 'quarter'); v_folder text; v_manifest jsonb;
begin
  if v_kind = 'quarter' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year', 'quarter', a->'fiscal_quarter'));
  elsif v_kind = 'year' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year'));
  else v_range := invoices.range_of(jsonb_build_object('from', a->'from_date', 'to', a->'to_date')); end if;
  v_folder := case v_kind when 'quarter' then format('IKISAI_COMPRAS_%s_T%s', v_range->>'year', v_range->>'quarter') when 'year' then format('IKISAI_COMPRAS_%s', v_range->>'year')
    else format('IKISAI_COMPRAS_%s_%s', replace(v_range->>'from', '-', '_'), replace(v_range->>'to', '-', '_')) end;
  v_manifest := invoices.export_manifest_v2((v_range->>'from')::date, (v_range->>'to')::date, v_kind, (v_range->>'year')::int, (v_range->>'quarter')::int, v_folder);
  return jsonb_build_object('folder_name', v_folder, 'range', v_range, 'invoice_count', v_manifest->'invoice_count', 'file_count', v_manifest->'file_count',
    'excluded', v_manifest->'excluded', 'totals', v_manifest->'totals',
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', x->'id', 'code', x->'code', 'invoice_date', x->'invoice_date', 'supplier', x->'supplier'->'name', 'total', x->'total', 'missing_file', x->'missing_file')), '[]'::jsonb)
      from jsonb_array_elements(v_manifest->'invoices') x),
    'issued_count', v_manifest->'issued_count', 'issued_file_count', v_manifest->'issued_file_count', 'issued_totals', v_manifest->'issued_totals',
    'issued', (select coalesce(jsonb_agg(jsonb_build_object('id', x->'id', 'full_number', x->'full_number', 'issue_date', x->'issue_date', 'recipient', x->'recipient'->'name', 'total', x->'total', 'status', x->'status')), '[]'::jsonb)
      from jsonb_array_elements(v_manifest->'issued') x));
end $$;
select core.allow_read('invoices', 'invoices.export_preview', 'function', '{editor,owner}');

-- Lectura para el ZIP: documentos de recibidas en `facturas/` y de emitidas en `emitidas/` (`folder`). Desfasada también si
-- cambió una emitida incluida o hay emitidas nuevas del periodo.
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
        or exists (select 1 from invoices.issued_invoices ii where ii.deleted_at is null and ii.issue_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id)))));
end $$;
select core.allow_read('invoices', 'invoices.export_bundle', 'function');

revoke all on function invoices.issued_summary_for(date, date, uuid[]), invoices.issued_summary(jsonb), invoices.issued_manifest(date, date),
  invoices.export_manifest_v2(date, date, text, int, int, text), invoices.create_export(jsonb), invoices.export_preview(jsonb), invoices.export_bundle(jsonb)
  from public, anon, authenticated;
