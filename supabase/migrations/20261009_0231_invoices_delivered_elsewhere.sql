-- Invoices · FB_2026_024: «Se deja en su trimestre» (9-10-2026, decisión del usuario vía Core). Toca solo el schema invoices.
--
-- Una factura atrasada que la gestoría ya tiene (se le pasó fuera de la app) se marca «ya pasada a la gestoría»:
-- `delivered_elsewhere` = true y `declared_period` = el trimestre de su fecha. No se mueve al trimestre actual, no vuelve
-- a preguntar y no entra en las entregas que se preparen en la app (ni las deja desactualizadas). Se deshace desmarcándola.
-- El resumen fiscal del trimestre la sigue contando: está declarada en él.

alter table invoices.invoices add column delivered_elsewhere boolean not null default false;

select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url',
  'invoice_kind','rectifies_invoice_id','rectifies_number','rectification_without_original',
  'declared_period','delivered_elsewhere'], '{reader,editor,owner}', '{editor,owner}', true);

-- export_manifest (de 0228) sin las ya pasadas a la gestoría (ni incluidas ni excluidas: no son de esta entrega).
create or replace function invoices.export_manifest(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with inc as (
    select i.*, s.name supplier_name, s.tax_id supplier_tax_id from invoices.invoices i join invoices.suppliers s on s.id = i.supplier_id
    where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('validada', 'archivada') and not i.delivered_elsewhere),
  exc as (select i.* from invoices.invoices i where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('pendiente_datos', 'pendiente_revision') and not i.delivered_elsewhere)
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

-- export_bundle (de 0228): una ya pasada a la gestoría no deja la entrega desactualizada.
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
      or exists (select 1 from invoices.invoices i where i.deleted_at is null and i.status in ('validada', 'archivada') and i.declaration_date between e.from_date and e.to_date and not i.delivered_elsewhere
                 and not exists (select 1 from invoices.export_items ei where ei.export_id = e.id and ei.invoice_id = i.id))
      or (e.manifest ? 'issued' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss join invoices.issued_invoices ii on ii.id = (iss->>'id')::uuid where ii.revision <> (iss->>'revision')::bigint)
        or exists (select 1 from invoices.issued_invoices ii where ii.deleted_at is null and ii.status <> 'borrador' and ii.issue_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id)))));
end $$;
