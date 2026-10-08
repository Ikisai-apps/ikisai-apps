-- Invoices · import_v1 acepta líneas con `"discount_amount": null` (fallo encontrado el 8-10-2026). Toca solo el schema invoices.
--
-- `coalesce(v_line->'discount_amount', '0'::jsonb)` no sustituía el null de JSON (no es un NULL de SQL) y la columna
-- `not null` rechazaba la línea con CONSTRAINT_VIOLATION. «Leer PDF» genera siempre ese null, así que su importación
-- fallaba en el servidor (la API simulada de Playwright no lo veía). Mismo procedimiento que 0201 con `nullif(..., 'null')`.

create or replace function invoices.import_v1(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; doc jsonb := a->'document'; inv jsonb := a->'document'->'invoice'; ov jsonb := coalesce(a->'invoice', '{}'::jsonb);
  v_invoice_id uuid; v_inv invoices.invoices; v_existing boolean; v_supplier invoices.suppliers; v_supplier_id uuid; v_mode text; v_tax text; v_name text;
  v_number text; v_dup invoices.invoices; v_sha text; v_fields jsonb; v_line jsonb; v_tax_line jsonb; v_file jsonb; v_taxes jsonb; v_i int; v_id uuid;
  r record; v_delta numeric; v_reason text; v_names text[] := '{}'; v_warnings jsonb := '[]'::jsonb; v_result jsonb;
begin
  perform set_config('invoices.procedure', 'import_v1', true);
  -- 1. Esquema (la Edge ya validó al detalle; aquí lo imprescindible)
  if doc is null or doc->>'schema_version' <> 'ikisai.invoice.v1' then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', '$.schema_version')); end if;
  if jsonb_typeof(doc->'lines') <> 'array' or jsonb_array_length(doc->'lines') = 0 then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', '$.lines')); end if;
  if jsonb_typeof(doc->'taxes') <> 'array' then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', '$.taxes')); end if;
  if jsonb_typeof(doc->'document_totals') <> 'object' or doc->'document_totals'->>'total' is null then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', '$.document_totals')); end if;
  if inv->>'invoice_date' is null or inv->>'supplier_name' is null or inv->>'object' is null then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', '$.invoice')); end if;
  if coalesce(inv->>'currency', 'EUR') <> 'EUR' then perform core.fail('UNSUPPORTED_IN_V1', 422, jsonb_build_object('path', '$.invoice.currency')); end if;
  begin v_invoice_id := (a->>'invoice_id')::uuid; exception when others then v_invoice_id := null; end;
  if v_invoice_id is null then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.invoice_id')); end if;
  v_sha := a->>'document_sha256';
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.document_sha256')); end if;

  -- 2. Factura destino
  select * into v_inv from invoices.invoices where id = v_invoice_id for update;
  v_existing := v_inv.id is not null;
  if v_existing and (v_inv.status <> 'pendiente_datos' or v_inv.source <> 'manual'
      or exists (select 1 from invoices.invoice_lines where invoice_id = v_invoice_id and deleted_at is null)
      or exists (select 1 from invoices.tax_lines where invoice_id = v_invoice_id and deleted_at is null)) then
    perform core.fail('INVOICE_NOT_IMPORTABLE', 409, jsonb_build_object('invoice_id', v_invoice_id, 'status', v_inv.status));
  end if;

  -- 3. Proveedor
  v_mode := a->'supplier'->>'mode';
  v_tax := nullif(upper(regexp_replace(coalesce(inv->>'supplier_tax_id', ''), '[\s.\-]', '', 'g')), '');
  v_name := inv->>'supplier_name';
  if v_mode = 'create' then
    begin v_supplier_id := (a->'ids'->>'supplier')::uuid; exception when others then v_supplier_id := null; end;
    if v_supplier_id is null then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.ids.supplier')); end if;
    if v_tax is not null then
      select * into v_supplier from invoices.suppliers where deleted_at is null and upper(regexp_replace(coalesce(tax_id, ''), '[\s.\-]', '', 'g')) = v_tax limit 1;
      if v_supplier.id is not null then perform core.fail('SUPPLIER_TAX_ID_EXISTS', 409, jsonb_build_object('supplier_id', v_supplier.id, 'name', v_supplier.name)); end if;
    end if;
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.suppliers', 'id', v_supplier_id, 'fields', jsonb_build_object(
      'name', v_name, 'tax_id', inv->>'supplier_tax_id', 'slug', coalesce(nullif(a->'supplier'->>'slug', ''), nullif(invoices.slugify(v_name), ''), 'proveedor'), 'aliases', '[]'::jsonb)));
    select * into v_supplier from invoices.suppliers where id = v_supplier_id;
  elsif v_mode = 'existing' then
    begin v_supplier_id := (a->'supplier'->>'id')::uuid; exception when others then v_supplier_id := null; end;
    select * into v_supplier from invoices.suppliers where id = v_supplier_id and deleted_at is null for update;
    if v_supplier.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.suppliers', 'id', a->'supplier'->>'id')); end if;
    if invoices.slugify(v_name, 200) <> invoices.slugify(v_supplier.name, 200) and not exists (select 1 from unnest(v_supplier.aliases) al where invoices.slugify(al, 200) = invoices.slugify(v_name, 200)) then
      if cardinality(v_supplier.aliases) < 20 then
        perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.suppliers', 'id', v_supplier.id, 'expectedRevision', v_supplier.revision,
          'fields', jsonb_build_object('aliases', to_jsonb(v_supplier.aliases || v_name))));
      end if;
    end if;
  else
    perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.supplier.mode'));
  end if;

  -- 4. Duplicados
  v_number := nullif(btrim(coalesce(inv->>'invoice_number', '')), '');
  if v_number is not null then
    select * into v_dup from invoices.invoices where deleted_at is null and status <> 'anulada' and supplier_id = v_supplier_id and lower(invoice_number) = lower(v_number) and id <> v_invoice_id limit 1;
    if v_dup.id is not null then perform core.fail('DUPLICATE_INVOICE', 409, jsonb_build_object('invoice_id', v_dup.id, 'code', v_dup.code)); end if;
  end if;
  select * into v_dup from invoices.invoices where deleted_at is null and status <> 'anulada' and import_sha256 = v_sha and id <> v_invoice_id limit 1;
  if v_dup.id is not null then perform core.fail('DUPLICATE_IMPORT', 409, jsonb_build_object('invoice_id', v_dup.id, 'code', v_dup.code)); end if;

  -- 5. Factura (insert o update de la pendiente_datos)
  v_fields := jsonb_build_object(
    'supplier_id', v_supplier_id,
    'invoice_date', coalesce(ov->>'invoice_date', inv->>'invoice_date'),
    'object', btrim(coalesce(nullif(ov->>'object', ''), inv->>'object')),
    'invoice_number', v_number,
    'currency', 'EUR',
    'expense_category', coalesce(ov->>'expense_category', v_supplier.default_category),
    'is_investment', coalesce((ov->>'is_investment')::boolean, v_supplier.default_is_investment, false),
    'deductibility', coalesce(ov->>'deductibility', inv->>'deductibility_suggestion', 'pendiente_revision'),
    'status', 'pendiente_revision',
    'review_reason', 'IMPORTADA',
    'source_total', (doc->'document_totals'->>'total')::numeric,
    'source', 'import_v1',
    'import_sha256', v_sha,
    'import_meta', jsonb_build_object('overall_confidence', doc->'overall_confidence', 'extraction_notes', doc->'extraction_notes',
      'deductibility_suggestion', inv->'deductibility_suggestion', 'document_totals', doc->'document_totals', 'supplier_name', v_name, 'supplier_tax_id', inv->'supplier_tax_id'),
    'notes', coalesce(ov->>'notes', inv->>'notes'));
  if v_existing then
    perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v_invoice_id, 'expectedRevision', v_inv.revision, 'fields', v_fields));
  else
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.invoices', 'id', v_invoice_id, 'fields', v_fields));
  end if;

  -- 6. Líneas
  v_i := 0;
  for v_line in select * from jsonb_array_elements(doc->'lines') loop
    begin v_id := (a->'ids'->'lines'->>v_i)::uuid; exception when others then v_id := null; end;
    v_id := coalesce(v_id, gen_random_uuid());
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.invoice_lines', 'id', v_id, 'fields', jsonb_build_object(
      'invoice_id', v_invoice_id, 'position', v_i, 'description', v_line->>'description', 'quantity', v_line->'quantity', 'unit', v_line->'unit',
      'unit_price', v_line->'unit_price', 'discount_amount', coalesce(nullif(v_line->'discount_amount', 'null'::jsonb), '0'::jsonb), 'net_amount', v_line->'net_amount',
      'vat_rate', v_line->'vat_rate', 'vat_amount', v_line->'vat_amount', 'gross_amount', v_line->'gross_amount',
      'item_type', v_line->'suggested_item_type', 'match_name', v_line->'suggested_match_name', 'confidence', v_line->'confidence', 'notes', v_line->'notes')));
    v_i := v_i + 1;
  end loop;

  -- 7. Impuestos: los del documento o, si no trae, derivados de las líneas por tipo de IVA
  v_taxes := doc->'taxes';
  if jsonb_array_length(v_taxes) = 0 then
    select coalesce(jsonb_agg(jsonb_build_object('tax_type', 'iva', 'rate', g.rate, 'taxable_base', g.net,
      'amount', case when g.all_amounts then g.amounts else round(g.net * g.rate / 100, 2) end) order by g.rate), '[]'::jsonb) into v_taxes
    from (select (l->>'vat_rate')::numeric rate, sum((l->>'net_amount')::numeric) net, bool_and(l->>'vat_amount' is not null) all_amounts, sum(coalesce((l->>'vat_amount')::numeric, 0)) amounts
          from jsonb_array_elements(doc->'lines') l where l->>'vat_rate' is not null group by (l->>'vat_rate')::numeric) g;
    v_warnings := v_warnings || '"TAXES_DERIVED_FROM_LINES"'::jsonb;
  end if;
  v_i := 0;
  for v_tax_line in select * from jsonb_array_elements(v_taxes) loop
    begin v_id := (a->'ids'->'tax_lines'->>v_i)::uuid; exception when others then v_id := null; end;
    v_id := coalesce(v_id, gen_random_uuid());
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.tax_lines', 'id', v_id, 'fields', jsonb_build_object(
      'invoice_id', v_invoice_id, 'position', v_i, 'tax_type', v_tax_line->>'tax_type', 'rate', v_tax_line->'rate', 'taxable_base', v_tax_line->'taxable_base',
      'amount', v_tax_line->'amount', 'notes', v_tax_line->'notes')));
    v_i := v_i + 1;
  end loop;

  -- 8. Documentos
  v_i := 0;
  for v_file in select * from jsonb_array_elements(coalesce(a->'files', '[]'::jsonb)) loop
    begin v_id := (a->'ids'->'files'->>v_i)::uuid; exception when others then v_id := null; end;
    v_id := coalesce(v_id, gen_random_uuid());
    v_result := invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.invoice_files', 'id', v_id, 'fields',
      invoices.file_fields((v_file->>'file_id')::uuid) || jsonb_build_object('invoice_id', v_invoice_id, 'original_filename', coalesce(v_file->>'original_filename', 'documento'),
        'page_order', coalesce((v_file->>'page_order')::int, v_i + 1), 'kind', 'original')));
    v_names := v_names || (v_result->'after'->>'normalized_filename');
    v_i := v_i + 1;
  end loop;

  -- 9. Recálculo, delta y estado (el hook volverá a comprobarlo; aquí se deja la fila ya coherente)
  select * into r from invoices.recalculate(v_invoice_id);
  v_delta := (doc->'document_totals'->>'total')::numeric - r.total;
  v_reason := case when invoices.outside_tolerance(v_delta) then 'REVISAR IMPORTES' else 'IMPORTADA' end;
  if abs(coalesce((doc->'document_totals'->>'base')::numeric, r.base) - r.base) > 0.02 then v_warnings := v_warnings || '"BASE_MISMATCH"'::jsonb; end if;
  if abs(coalesce((doc->'document_totals'->>'vat')::numeric, r.vat + r.other) - (r.vat + r.other)) > 0.02 then v_warnings := v_warnings || '"VAT_MISMATCH"'::jsonb; end if;
  if abs(coalesce((doc->'document_totals'->>'withholding')::numeric, r.withholding) - r.withholding) > 0.02 then v_warnings := v_warnings || '"WITHHOLDING_MISMATCH"'::jsonb; end if;
  if v_reason = 'REVISAR IMPORTES' then v_warnings := v_warnings || '"TOTALS_MISMATCH"'::jsonb; end if;
  select * into v_inv from invoices.invoices where id = v_invoice_id;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v_invoice_id, 'expectedRevision', v_inv.revision, 'fields', jsonb_build_object(
    'calculated_base', r.base, 'calculated_vat', r.vat, 'calculated_other', r.other, 'calculated_withholding', r.withholding, 'calculated_total', r.total,
    'totals_delta', v_delta, 'review_reason', v_reason,
    'import_meta', v_inv.import_meta || jsonb_build_object('warnings', v_warnings, 'recalculation', jsonb_build_object(
      'calculated_base', r.base, 'calculated_vat', r.vat, 'calculated_other', r.other, 'calculated_withholding', r.withholding, 'calculated_total', r.total,
      'source_total', (doc->'document_totals'->>'total')::numeric, 'delta', v_delta, 'within_tolerance', not invoices.outside_tolerance(v_delta))))));
  select * into v_inv from invoices.invoices where id = v_invoice_id;

  return jsonb_build_object('invoice_id', v_invoice_id, 'code', v_inv.code, 'status', v_inv.status, 'review_reason', v_inv.review_reason, 'supplier_id', v_supplier_id,
    'normalized_filenames', to_jsonb(v_names), 'warnings', v_warnings,
    'recalculation', jsonb_build_object('calculated_base', r.base, 'calculated_vat', r.vat, 'calculated_other', r.other, 'calculated_withholding', r.withholding,
      'calculated_total', r.total, 'source_total', (doc->'document_totals'->>'total')::numeric, 'delta', v_delta, 'within_tolerance', not invoices.outside_tolerance(v_delta)));
end $$;
