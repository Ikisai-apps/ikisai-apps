-- Invoices · periodo de declaración de las facturas recibidas (aprobado por Core el 9-10-2026). Toca solo el schema invoices.
--
-- La fecha de la factura no cambia; el trimestre en que se declara puede ser otro:
-- - `declared_period` (`AAAATn`, nulo = el trimestre de su fecha) y `declaration_date` (generada: el primer día del
--   periodo declarado, o la fecha de la factura). Resumen fiscal, entrega a la gestoría y sus avisos van por
--   `declaration_date`; Compras y los indicadores de Central siguen por la fecha real.
-- - Si el trimestre de su fecha YA tiene una entrega preparada, el hook la pasa sola al siguiente trimestre sin entrega
--   («Atrasada (2T)», editable en la ficha). Si aún no la tiene pero ya terminó, la ficha pregunta («Es del 2T: ¿la
--   declaras en el 3T?»); eso es de la app, aquí no se decide.
-- - En el manifest y el CSV, cada factura lleva su periodo de declaración y si va atrasada.

create or replace function invoices.period_start(p text)
returns date language sql immutable as $$
  select case when p ~ '^[0-9]{4}T[1-4]$' then make_date(left(p, 4)::int, (right(p, 1)::int - 1) * 3 + 1, 1) end
$$;

alter table invoices.invoices
  add column declared_period text check (declared_period is null or declared_period ~ '^[0-9]{4}T[1-4]$'),
  add column declaration_date date generated always as (coalesce(invoices.period_start(declared_period), invoice_date)) stored;
create index invoices_declaration_idx on invoices.invoices (declaration_date);

-- Las columnas generadas llegan nulas a los triggers before: la guarda de anuladas y archivadas no las compara.
create or replace function invoices.comparable(p_row jsonb)
returns jsonb language sql immutable as $$
  select p_row - 'revision' - 'updated_at' - 'updated_by' - 'fiscal_year' - 'fiscal_quarter' - 'fiscal_period' - 'declaration_date';
$$;

select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url',
  'invoice_kind','rectifies_invoice_id','rectifies_number','rectification_without_original',
  'declared_period'], '{reader,editor,owner}', '{editor,owner}', true);

-- ¿Hay ya una entrega a la gestoría que cubra esa fecha?
create or replace function invoices.period_delivered(p_date date)
returns boolean language sql stable as $$
  select exists (select 1 from invoices.exports e where e.deleted_at is null and p_date between e.from_date and e.to_date)
$$;

-- Siguiente trimestre (desde el de la fecha) sin entrega preparada, como `AAAATn`.
create or replace function invoices.next_open_period(p_date date)
returns text language plpgsql stable as $$
declare v date := date_trunc('quarter', p_date)::date;
begin
  for i in 1..12 loop
    v := (v + interval '3 months')::date;
    if not invoices.period_delivered(v) then return extract(year from v)::int || 'T' || extract(quarter from v)::int; end if;
  end loop;
  return extract(year from v)::int || 'T' || extract(quarter from v)::int;
end $$;

-- Hook: una factura pendiente cuya fecha cae en un trimestre ya entregado pasa sola al siguiente abierto.
create or replace function invoices.assign_declared_period(p jsonb)
returns void language plpgsql as $$
declare v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p); v invoices.invoices;
begin
  for v in select i.* from invoices.invoices i
           where i.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'invoices'
                            and ch.op <> 'call' and (ch.op = 'insert' or ch.before->>'invoice_date' is distinct from ch.after->>'invoice_date'))
             and i.deleted_at is null and i.declared_period is null and i.invoice_date is not null and i.status in ('pendiente_datos', 'pendiente_revision')
             and invoices.period_delivered(i.invoice_date) loop
    perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v.id, 'expectedRevision', v.revision,
      'fields', jsonb_build_object('declared_period', invoices.next_open_period(v.invoice_date))));
  end loop;
end $$;
select core.add_validate_hook('invoices', 'invoices.assign_declared_period');

-- Resumen fiscal (de 0201) por periodo de declaración.
create or replace function invoices.fiscal_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.invoices i where i.deleted_at is null and i.declaration_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
  summed as (select * from live where status in ('validada', 'archivada')),
  with_file as (select distinct invoice_id from invoices.invoice_files where deleted_at is null and kind = 'original')
  select jsonb_build_object(
    'invoices', jsonb_build_object(
      'pendiente_datos', (select count(*) from live where status = 'pendiente_datos'),
      'pendiente_revision', (select count(*) from live where status = 'pendiente_revision'),
      'validada', (select count(*) from live where status = 'validada'),
      'archivada', (select count(*) from live where status = 'archivada'),
      'anulada', (select count(*) from live where status = 'anulada')),
    'base', (select coalesce(sum(calculated_base), 0) from summed),
    'vat', (select coalesce(sum(calculated_vat), 0) from summed),
    'other', (select coalesce(sum(calculated_other), 0) from summed),
    'withholding', (select coalesce(sum(calculated_withholding), 0) from summed),
    'total', (select coalesce(sum(calculated_total), 0) from summed),
    'vat_by_rate', (select coalesce(jsonb_agg(jsonb_build_object('rate', g.rate, 'base', g.base, 'amount', g.amount) order by g.rate), '[]'::jsonb) from (
        select coalesce(t.rate, 0) rate, sum(coalesce(t.taxable_base, 0)) base, sum(t.amount) amount
        from invoices.tax_lines t join summed s on s.id = t.invoice_id where t.deleted_at is null and t.tax_type = 'iva' group by coalesce(t.rate, 0)) g),
    'withholdings_by_type', (select coalesce(jsonb_agg(jsonb_build_object('tax_type', g.tax_type, 'rate', g.rate, 'base', g.base, 'amount', g.amount) order by g.tax_type, g.rate), '[]'::jsonb) from (
        select t.tax_type, t.rate, sum(coalesce(t.taxable_base, 0)) base, sum(t.amount) amount
        from invoices.tax_lines t join summed s on s.id = t.invoice_id where t.deleted_at is null and t.tax_type in ('irpf', 'otra_retencion') group by t.tax_type, t.rate) g),
    'by_category', (select coalesce(jsonb_agg(jsonb_build_object('expense_category', g.expense_category, 'is_investment', g.is_investment, 'base', g.base, 'vat', g.vat, 'total', g.total, 'count', g.count) order by g.base desc), '[]'::jsonb) from (
        select expense_category, is_investment, sum(calculated_base) base, sum(calculated_vat) vat, sum(calculated_total) total, count(*) count from summed group by expense_category, is_investment) g),
    'investment', (select jsonb_build_object('base', coalesce(sum(calculated_base), 0), 'total', coalesce(sum(calculated_total), 0), 'count', count(*)) from summed where is_investment),
    'operating', (select jsonb_build_object('base', coalesce(sum(calculated_base), 0), 'total', coalesce(sum(calculated_total), 0), 'count', count(*)) from summed where not is_investment),
    'deductibility', (select jsonb_build_object(
        'si', coalesce(sum(calculated_base) filter (where deductibility = 'si'), 0), 'no', coalesce(sum(calculated_base) filter (where deductibility = 'no'), 0),
        'parcial', coalesce(sum(calculated_base) filter (where deductibility = 'parcial'), 0), 'pendiente_revision', coalesce(sum(calculated_base) filter (where deductibility = 'pendiente_revision'), 0)) from summed),
    'alerts', jsonb_build_object(
      'pending_invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'status', status, 'review_reason', review_reason) order by invoice_date, code), '[]'::jsonb) from live where status in ('pendiente_datos', 'pendiente_revision')),
      'discrepancies', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'code', code, 'totals_delta', totals_delta) order by invoice_date, code), '[]'::jsonb) from live where status <> 'anulada' and invoices.outside_tolerance(totals_delta)),
      'deductibility_unreviewed', (select count(*) from summed where deductibility = 'pendiente_revision'),
      'missing_file', (select count(*) from live l where l.status <> 'anulada' and not exists (select 1 from with_file w where w.invoice_id = l.id)),
      'unpaid_overdue', (select count(*) from live where status <> 'anulada' and payment_status = 'pendiente' and due_date is not null and due_date < current_date)));
$$;

-- Manifest de la entrega (de 0227) por periodo de declaración, con el periodo y la marca de atrasada.
create or replace function invoices.export_manifest(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with inc as (
    select i.*, s.name supplier_name, s.tax_id supplier_tax_id from invoices.invoices i join invoices.suppliers s on s.id = i.supplier_id
    where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('validada', 'archivada')),
  exc as (select i.* from invoices.invoices i where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('pendiente_datos', 'pendiente_revision'))
  select jsonb_build_object(
    'schema', 'ikisai.invoices.export.v1',
    'export', jsonb_build_object('folder', p_folder, 'range', jsonb_build_object('kind', p_kind, 'year', p_year, 'quarter', p_quarter, 'from', p_from, 'to', p_to), 'created_at', now()),
    'invoice_count', (select count(*) from inc),
    'file_count', (select count(*) from invoices.invoice_files f join inc on inc.id = f.invoice_id where f.deleted_at is null),
    'totals', invoices.fiscal_summary_for(p_from, p_to, (select array_agg(id) from inc)),
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', inc.id, 'code', inc.code, 'revision', inc.revision, 'supplier', jsonb_build_object('name', inc.supplier_name, 'tax_id', inc.supplier_tax_id),
        'invoice_number', inc.invoice_number, 'invoice_date', inc.invoice_date, 'object', inc.object, 'expense_category', inc.expense_category, 'is_investment', inc.is_investment,
        'deductibility', inc.deductibility, 'base', inc.calculated_base, 'vat', inc.calculated_vat, 'other', inc.calculated_other, 'withholding', inc.calculated_withholding,
        'total', inc.calculated_total, 'source_total', inc.source_total, 'totals_delta', inc.totals_delta, 'status', inc.status,
        'payment', jsonb_build_object('status', inc.payment_status, 'method', inc.payment_method, 'paid_at', inc.paid_at),
        'taxes', (select coalesce(jsonb_agg(jsonb_build_object('tax_type', t.tax_type, 'rate', t.rate, 'taxable_base', t.taxable_base, 'amount', t.amount) order by t.position), '[]'::jsonb) from invoices.tax_lines t where t.invoice_id = inc.id and t.deleted_at is null),
        'lines', (select coalesce(jsonb_agg(jsonb_build_object('position', l.position, 'description', l.description, 'item_type', l.item_type, 'quantity', l.quantity, 'unit', l.unit, 'unit_price', l.unit_price,
            'discount_amount', l.discount_amount, 'net_amount', l.net_amount, 'vat_rate', l.vat_rate, 'vat_amount', l.vat_amount, 'gross_amount', l.gross_amount,
            'expense_category', coalesce(l.expense_category, inc.expense_category), 'is_investment', coalesce(l.is_investment, inc.is_investment),
            'allocations', (select coalesce(jsonb_agg(jsonb_build_object('target_app', al.target_app, 'target_kind', al.target_kind, 'target_label', al.target_label, 'allocated_amount', al.allocated_amount) order by al.created_at), '[]'::jsonb)
                            from invoices.allocations al where al.invoice_line_id = l.id and al.deleted_at is null)) order by l.position), '[]'::jsonb)
                  from invoices.invoice_lines l where l.invoice_id = inc.id and l.deleted_at is null),
        'files', (select coalesce(jsonb_agg(jsonb_build_object('name', 'facturas/' || f.normalized_filename, 'file_id', f.file_id, 'kind', f.kind, 'page_order', f.page_order,
            'sha256', f.sha256, 'size_bytes', f.size_bytes, 'mime_type', f.mime_type) order by f.kind, f.page_order), '[]'::jsonb) from invoices.invoice_files f where f.invoice_id = inc.id and f.deleted_at is null),
        'missing_file', not exists (select 1 from invoices.invoice_files f where f.invoice_id = inc.id and f.deleted_at is null and f.kind = 'original'),
        -- Rectificativa (0227): tipo y referencia a la original (que puede ser de otro periodo o faltar).
        'kind', inc.invoice_kind,
        -- Periodo de declaración (0228): el trimestre en que se declara y si es de un trimestre anterior a su fecha.
        'declared_period', coalesce(inc.declared_period, inc.fiscal_period), 'late', inc.declared_period is not null and inc.declared_period <> inc.fiscal_period,
        'rectifies', case when inc.invoice_kind = 'rectificativa' then (select jsonb_build_object('code', o.code, 'invoice_number', coalesce(o.invoice_number, inc.rectifies_number),
            'invoice_date', o.invoice_date, 'other_period', o.invoice_date is not null and o.invoice_date not between p_from and p_to, 'without_original', o.id is null)
          from (select 1) one left join invoices.invoices o on o.id = inc.rectifies_invoice_id) end
      ) order by inc.invoice_date, inc.code), '[]'::jsonb) from inc),
    'excluded', (select coalesce(jsonb_agg(jsonb_build_object('id', exc.id, 'code', exc.code, 'status', exc.status, 'reason', exc.review_reason) order by exc.invoice_date, exc.code), '[]'::jsonb) from exc),
    'integrity', jsonb_build_object('algorithm', 'sha256', 'files', 'SHA-256 de cada archivo incluido, verificado por el servidor al subirlo'));
$$;

-- Entrega (de 0215): «desactualizada» si aparece una validada declarada en su periodo.
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
          'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint, 'bucket', cf.bucket, 'path', cf.path, 'status', cf.status, 'storage_provider', cf.storage_provider) x
        from invoices.export_items ei, jsonb_array_elements(ei.files) f left join core.files cf on cf.id = (f->>'file_id')::uuid where ei.export_id = e.id
        union all
        select jsonb_build_object('folder', 'emitidas', 'invoice_code', iss->>'full_number', 'file_id', f->>'file_id', 'normalized_filename', substr(f->>'name', 10),
          'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint, 'bucket', cf.bucket, 'path', cf.path, 'status', cf.status, 'storage_provider', cf.storage_provider)
        from jsonb_array_elements(coalesce(e.manifest->'issued', '[]'::jsonb)) iss, jsonb_array_elements(iss->'files') f left join core.files cf on cf.id = (f->>'file_id')::uuid
      ) files),
    'stale', exists (select 1 from invoices.export_items ei join invoices.invoices i on i.id = ei.invoice_id where ei.export_id = e.id and (i.revision <> ei.invoice_revision or i.status = 'anulada'))
      or exists (select 1 from invoices.invoices i where i.deleted_at is null and i.status in ('validada', 'archivada') and i.declaration_date between e.from_date and e.to_date
                 and not exists (select 1 from invoices.export_items ei where ei.export_id = e.id and ei.invoice_id = i.id))
      or (e.manifest ? 'issued' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss join invoices.issued_invoices ii on ii.id = (iss->>'id')::uuid where ii.revision <> (iss->>'revision')::bigint)
        or exists (select 1 from invoices.issued_invoices ii where ii.deleted_at is null and ii.status <> 'borrador' and ii.issue_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id)))));
end $$;
