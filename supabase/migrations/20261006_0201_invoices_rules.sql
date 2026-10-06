-- Ikisai Invoices · recálculo, hook de invariantes, procedimientos y lecturas (docs/invoices/API.md §3, §4.3, §6). Toca solo el schema invoices.
-- Lee core.changes (el lote), core.memberships (rol) y core.files (documentos). Toda escritura va por core.apply_row_op.

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
-- Aplica una operación de fila con el contexto de un procedimiento ({app, actor, role, requestId, cursor}) o del hook.
create or replace function invoices.row_op(p jsonb, p_op jsonb)
returns jsonb language sql as $$
  select core.apply_row_op(p->>'app', (p->>'actor')::uuid,
    coalesce(p->>'role', nullif(current_setting('core' || '.role', true), '')),
    coalesce(p->>'requestId', nullif(current_setting('core' || '.request_id', true), '')),
    (p->>'cursor')::bigint, p_op);
$$;

create or replace function invoices.hook_ctx(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('app', p->>'app', 'actor', p->>'actor', 'cursor', p->>'cursor',
    'role', nullif(current_setting('core' || '.role', true), ''), 'requestId', nullif(current_setting('core' || '.request_id', true), ''));
$$;

create or replace function invoices.outside_tolerance(p_delta numeric)
returns boolean language sql immutable as $$ select p_delta is not null and abs(p_delta) > 0.02 $$;

-- ---------------------------------------------------------------------------
-- Recálculo (misma regla que _domain/invoices/recalculate.ts)
-- ---------------------------------------------------------------------------
create or replace function invoices.recalculate(p_invoice_id uuid,
  out base numeric, out vat numeric, out other numeric, out withholding numeric, out total numeric)
language plpgsql stable as $$
declare v_has_taxes boolean; v_iva_base numeric; v_otro_base numeric; v_lines numeric;
begin
  select coalesce(sum(net_amount), 0) into v_lines from invoices.invoice_lines where invoice_id = p_invoice_id and deleted_at is null;
  select exists (select 1 from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null) into v_has_taxes;
  if v_has_taxes then
    select sum(taxable_base) into v_iva_base from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null and tax_type = 'iva' and taxable_base is not null;
    select sum(taxable_base) into v_otro_base from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null and tax_type = 'otro' and taxable_base is not null;
    base := coalesce(v_iva_base, v_otro_base, v_lines);
    select coalesce(sum(amount), 0) into vat from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null and tax_type = 'iva';
    select coalesce(sum(amount), 0) into other from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null and tax_type = 'otro';
    select coalesce(sum(amount), 0) into withholding from invoices.tax_lines where invoice_id = p_invoice_id and deleted_at is null and tax_type in ('irpf', 'otra_retencion');
  else
    -- Sin desglose: IVA derivado de las líneas agrupando por tipo (todas con importe → suma; si no, base × tipo).
    base := v_lines;
    select coalesce(sum(case when g.all_amounts then g.amounts else round(g.net * g.vat_rate / 100, 2) end), 0) into vat
    from (select vat_rate, sum(net_amount) net, bool_and(vat_amount is not null) all_amounts, sum(coalesce(vat_amount, 0)) amounts
          from invoices.invoice_lines where invoice_id = p_invoice_id and deleted_at is null and vat_rate is not null group by vat_rate) g;
    other := 0; withholding := 0;
  end if;
  total := base + vat + other - withholding;
end $$;

-- ---------------------------------------------------------------------------
-- Hook de invariantes: se ejecuta al final de cada lote sobre las facturas tocadas.
-- ---------------------------------------------------------------------------
create or replace function invoices.check_invariants(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p);
  v_ids uuid[]; v_id uuid; v_inv invoices.invoices; r record; f record; l record; v_fields jsonb; v_delta numeric;
  v_status text; v_reason text; v_has_content boolean; v_proc_call boolean; v_sensitive boolean; v_children boolean; v_expected text; v_dup int;
begin
  select array_agg(distinct x.id) into v_ids from (
    select ch.row_id id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'invoices' and ch.op <> 'call'
    union
    select (coalesce(ch.after, ch.before)->>'invoice_id')::uuid from core.changes ch
    where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.op <> 'call' and ch.table_name in ('invoice_lines', 'tax_lines', 'invoice_files', 'allocations')
  ) x where x.id is not null;
  if v_ids is null then return; end if;
  v_proc_call := exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.op = 'call' and ch.table_name in ('validate', 'import_v1', 'annul', 'archive_period'));

  foreach v_id in array v_ids loop
    select * into v_inv from invoices.invoices where id = v_id for update;
    if v_inv.id is null or v_inv.status = 'anulada' then continue; end if;

    -- 1. Recálculo y delta
    select * into r from invoices.recalculate(v_id);
    v_delta := case when v_inv.source_total is null then null else v_inv.source_total - r.total end;
    v_fields := '{}'::jsonb;
    if v_inv.calculated_base <> r.base then v_fields := v_fields || jsonb_build_object('calculated_base', r.base); end if;
    if v_inv.calculated_vat <> r.vat then v_fields := v_fields || jsonb_build_object('calculated_vat', r.vat); end if;
    if v_inv.calculated_other <> r.other then v_fields := v_fields || jsonb_build_object('calculated_other', r.other); end if;
    if v_inv.calculated_withholding <> r.withholding then v_fields := v_fields || jsonb_build_object('calculated_withholding', r.withholding); end if;
    if v_inv.calculated_total <> r.total then v_fields := v_fields || jsonb_build_object('calculated_total', r.total); end if;
    if v_inv.totals_delta is distinct from v_delta then v_fields := v_fields || jsonb_build_object('totals_delta', v_delta); end if;

    -- 2. Estado automático
    v_status := v_inv.status; v_reason := v_inv.review_reason;
    select exists (select 1 from invoices.invoice_lines where invoice_id = v_id and deleted_at is null)
        or exists (select 1 from invoices.tax_lines where invoice_id = v_id and deleted_at is null) into v_has_content;
    if v_status = 'pendiente_datos' and v_has_content then
      v_status := 'pendiente_revision';
      v_reason := coalesce(v_reason, 'DATOS_INTRODUCIDOS');
    end if;
    if v_status = 'validada' and not v_proc_call then
      select exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'invoices' and ch.row_id = v_id and ch.op = 'update'
        and (ch.before->>'invoice_date' is distinct from ch.after->>'invoice_date' or ch.before->>'object' is distinct from ch.after->>'object'
          or ch.before->>'supplier_id' is distinct from ch.after->>'supplier_id' or ch.before->>'invoice_number' is distinct from ch.after->>'invoice_number'
          or ch.before->>'source_total' is distinct from ch.after->>'source_total' or ch.before->>'expense_category' is distinct from ch.after->>'expense_category'
          or ch.before->>'is_investment' is distinct from ch.after->>'is_investment')) into v_sensitive;
      select exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.op <> 'call'
        and (coalesce(ch.after, ch.before)->>'invoice_id')::uuid = v_id
        and (ch.table_name in ('invoice_lines', 'tax_lines') or (ch.table_name = 'invoice_files' and coalesce(ch.after, ch.before)->>'kind' = 'original'))) into v_children;
      if v_sensitive or v_children then v_status := 'pendiente_revision'; v_reason := 'EDITADA_TRAS_VALIDAR'; end if;
    end if;
    if v_status = 'pendiente_revision' then
      if invoices.outside_tolerance(v_delta) then
        if v_reason is null or v_reason in ('IMPORTADA', 'DATOS_INTRODUCIDOS', 'IMPORTES_CORREGIDOS') then v_reason := 'REVISAR IMPORTES'; end if;
      elsif v_reason = 'REVISAR IMPORTES' then
        v_reason := 'IMPORTES_CORREGIDOS';
      end if;
    end if;
    if v_status <> v_inv.status then v_fields := v_fields || jsonb_build_object('status', v_status); end if;
    if v_reason is distinct from v_inv.review_reason then v_fields := v_fields || jsonb_build_object('review_reason', v_reason); end if;
    if v_fields <> '{}'::jsonb then
      perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v_id, 'expectedRevision', v_inv.revision, 'fields', v_fields));
    end if;

    -- 3. Una factura validada o archivada cuadra y tiene categoría (y documento cuando se valida)
    if v_status in ('validada', 'archivada') then
      if invoices.outside_tolerance(v_delta) then perform core.fail('INVOICE_INVALID_STATE', 422, jsonb_build_object('invoice_id', v_id, 'reason', 'REVISAR IMPORTES', 'delta', v_delta)); end if;
      if v_inv.expense_category is null then perform core.fail('INVOICE_INVALID_STATE', 422, jsonb_build_object('invoice_id', v_id, 'reason', 'expense_category')); end if;
      if v_proc_call and not exists (select 1 from invoices.invoice_files where invoice_id = v_id and deleted_at is null and kind = 'original') then
        perform core.fail('INVOICE_INVALID_STATE', 422, jsonb_build_object('invoice_id', v_id, 'reason', 'original_file'));
      end if;
    end if;

    -- 4. Nombres canónicos de los documentos (renombrado solo mientras no esté validada ni archivada)
    if v_status in ('pendiente_datos', 'pendiente_revision') then
      perform set_config('invoices.renaming', '1', true);
      for f in select * from invoices.invoice_files where invoice_id = v_id and deleted_at is null order by kind, page_order, id loop
        v_expected := invoices.expected_filename(v_id, f.id, f.kind, f.page_order, f.mime_type);
        if v_expected <> f.normalized_filename then
          perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.invoice_files', 'id', f.id, 'expectedRevision', f.revision, 'fields', jsonb_build_object('normalized_filename', v_expected)));
        end if;
      end loop;
      perform set_config('invoices.renaming', '', true);
    end if;

    -- 5. Asignaciones: nunca por encima de la línea
    for l in select li.id, li.net_amount, li.quantity, coalesce(sum(a.allocated_amount), 0) amount, sum(a.allocated_quantity) qty
             from invoices.invoice_lines li left join invoices.allocations a on a.invoice_line_id = li.id and a.deleted_at is null
             where li.invoice_id = v_id and li.deleted_at is null group by li.id, li.net_amount, li.quantity loop
      if l.amount > l.net_amount + 0.02 then
        perform core.fail('ALLOCATIONS_EXCEED_LINE', 422, jsonb_build_object('line_id', l.id, 'allocated', l.amount, 'net_amount', l.net_amount));
      end if;
      if l.qty is not null and l.quantity is not null and l.qty > l.quantity + 0.001 then
        perform core.fail('ALLOCATIONS_EXCEED_QUANTITY', 422, jsonb_build_object('line_id', l.id, 'allocated', l.qty, 'quantity', l.quantity));
      end if;
    end loop;

    -- 6. Impuestos sin duplicar (tipo, tasa)
    select count(*) into v_dup from (select tax_type, rate from invoices.tax_lines where invoice_id = v_id and deleted_at is null group by tax_type, rate having count(*) > 1) d;
    if v_dup > 0 then perform core.fail('TAX_LINE_DUPLICATE', 422, jsonb_build_object('invoice_id', v_id)); end if;
  end loop;
end $$;
select core.add_validate_hook('invoices', 'invoices.check_invariants');

-- ---------------------------------------------------------------------------
-- Procedimientos
-- ---------------------------------------------------------------------------
create or replace function invoices.invoice_for_update(p_id text)
returns invoices.invoices language plpgsql as $$
declare v invoices.invoices;
begin
  begin select * into v from invoices.invoices where id = p_id::uuid for update; exception when others then v.id := null; end;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.invoices', 'id', p_id)); end if;
  return v;
end $$;

-- Datos verificados de un archivo de core.files para una fila de invoice_files.
create or replace function invoices.file_fields(p_file_id uuid)
returns jsonb language plpgsql stable as $$
declare f core.files;
begin
  select * into f from core.files where id = p_file_id;
  if f.id is null or f.app <> 'invoices' then perform core.fail('FILE_NOT_FOUND', 404, jsonb_build_object('file_id', p_file_id)); end if;
  if f.status <> 'verified' then perform core.fail('FILE_NOT_VERIFIED', 422, jsonb_build_object('file_id', p_file_id, 'status', f.status)); end if;
  if f.mime not in ('application/pdf', 'image/webp', 'image/jpeg', 'image/png') then perform core.fail('UNSUPPORTED_MEDIA', 422, jsonb_build_object('file_id', p_file_id, 'mime', f.mime)); end if;
  return jsonb_build_object('file_id', f.id, 'mime_type', f.mime, 'size_bytes', f.size, 'sha256', f.sha256);
end $$;

-- import_v1: importación transaccional del JSON ikisai.invoice.v1 (API.md §3.1).
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
      'unit_price', v_line->'unit_price', 'discount_amount', coalesce(v_line->'discount_amount', '0'::jsonb), 'net_amount', v_line->'net_amount',
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

-- validate: revisión humana explícita → validada.
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

-- annul: anula con motivo y retira sus asignaciones; informa de las entregas que la incluían.
create or replace function invoices.annul(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_inv invoices.invoices; al record; v_exports jsonb;
begin
  perform set_config('invoices.procedure', 'annul', true);
  v_inv := invoices.invoice_for_update(a->>'invoice_id');
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> v_inv.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.invoices', 'id', v_inv.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', v_inv.revision, 'current', to_jsonb(v_inv)));
  end if;
  if v_inv.status = 'anulada' then perform core.fail('INVOICE_ANNULLED', 409, jsonb_build_object('invoice_id', v_inv.id)); end if;
  if nullif(btrim(coalesce(a->>'reason', '')), '') is null then perform core.fail('ANNUL_REASON_REQUIRED', 422, jsonb_build_object('invoice_id', v_inv.id)); end if;
  for al in select * from invoices.allocations where invoice_id = v_inv.id and deleted_at is null loop
    perform invoices.row_op(p, jsonb_build_object('op', 'delete', 'table', 'invoices.allocations', 'id', al.id, 'expectedRevision', al.revision));
  end loop;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', v_inv.id, 'expectedRevision', v_inv.revision, 'fields', jsonb_build_object('status', 'anulada', 'annulled_reason', btrim(a->>'reason'))));
  select coalesce(jsonb_agg(jsonb_build_object('export_id', e.id, 'code', e.code, 'status', e.status)), '[]'::jsonb) into v_exports
    from invoices.export_items ei join invoices.exports e on e.id = ei.export_id where ei.invoice_id = v_inv.id;
  select * into v_inv from invoices.invoices where id = v_inv.id;
  return jsonb_build_object('invoice', to_jsonb(v_inv), 'exports', v_exports);
end $$;

-- ---------------------------------------------------------------------------
-- Resumen fiscal (misma forma que _domain/invoices/summary.ts)
-- ---------------------------------------------------------------------------
create or replace function invoices.fiscal_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.invoices i where i.deleted_at is null and i.invoice_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
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

-- Rango a partir de los args: {year, quarter} | {year, month} | {year} | {from, to}
create or replace function invoices.range_of(a jsonb)
returns jsonb language plpgsql immutable as $$
declare v_year int; v_quarter int; v_month int; v_from date; v_to date; v_kind text;
begin
  if a->>'from' is not null and a->>'to' is not null then
    v_from := (a->>'from')::date; v_to := (a->>'to')::date; v_kind := 'custom'; v_year := extract(year from v_from)::int;
  elsif a->>'year' is not null then
    v_year := (a->>'year')::int;
    if a->>'quarter' is not null then
      v_quarter := (a->>'quarter')::int; v_kind := 'quarter';
      v_from := make_date(v_year, (v_quarter - 1) * 3 + 1, 1); v_to := (v_from + interval '3 months' - interval '1 day')::date;
    elsif a->>'month' is not null then
      v_month := (a->>'month')::int; v_kind := 'month'; v_quarter := ceil(v_month / 3.0)::int;
      v_from := make_date(v_year, v_month, 1); v_to := (v_from + interval '1 month' - interval '1 day')::date;
    else
      v_kind := 'year'; v_from := make_date(v_year, 1, 1); v_to := make_date(v_year, 12, 31);
    end if;
  else
    perform core.fail('INVALID_FILTER', 422, jsonb_build_object('reason', 'year or from/to required'));
  end if;
  if v_from > v_to then perform core.fail('INVALID_FILTER', 422, jsonb_build_object('reason', 'from after to')); end if;
  return jsonb_build_object('kind', v_kind, 'year', v_year, 'quarter', v_quarter, 'month', v_month, 'from', v_from, 'to', v_to);
end $$;

create or replace function invoices.fiscal_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_range jsonb := invoices.range_of(coalesce(p->'args', '{}'::jsonb));
begin
  return jsonb_build_object('range', v_range) || invoices.fiscal_summary_for((v_range->>'from')::date, (v_range->>'to')::date);
end $$;
select core.allow_read('invoices', 'invoices.fiscal_summary', 'function');

-- Compras: líneas como artículos comprados, con factura, proveedor y asignaciones.
create or replace function invoices.items(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); v_from date; v_to date; v_validated boolean := coalesce((a->>'validated_only')::boolean, true);
  v_limit int := greatest(1, least(coalesce((a->>'limit')::int, 500), 2000)); v_offset int := greatest(0, coalesce((a->>'offset')::int, 0)); v_rows jsonb; v_total bigint;
begin
  if a->>'from' is not null or a->>'year' is not null then
    v_from := (invoices.range_of(a)->>'from')::date; v_to := (invoices.range_of(a)->>'to')::date;
  end if;
  with base as (
    select l.*, i.code invoice_code, i.invoice_date, i.status invoice_status, i.supplier_id, i.object, s.name supplier_name,
           coalesce(l.expense_category, i.expense_category) effective_category, coalesce(l.is_investment, i.is_investment) effective_investment,
           coalesce((select sum(al.allocated_amount) from invoices.allocations al where al.invoice_line_id = l.id and al.deleted_at is null), 0) allocated_amount,
           (select coalesce(jsonb_agg(jsonb_build_object('id', al.id, 'target_app', al.target_app, 'target_kind', al.target_kind, 'target_id', al.target_id, 'target_code', al.target_code,
                    'target_label', al.target_label, 'target_revision', al.target_revision, 'allocated_quantity', al.allocated_quantity, 'allocated_amount', al.allocated_amount) order by al.created_at), '[]'::jsonb)
              from invoices.allocations al where al.invoice_line_id = l.id and al.deleted_at is null) allocations
    from invoices.invoice_lines l join invoices.invoices i on i.id = l.invoice_id join invoices.suppliers s on s.id = i.supplier_id
    where l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada'
      and (not v_validated or i.status in ('validada', 'archivada'))
      and (v_from is null or i.invoice_date between v_from and v_to)
      and (a->>'supplier_id' is null or i.supplier_id = (a->>'supplier_id')::uuid)
      and (a->>'expense_category' is null or coalesce(l.expense_category, i.expense_category) = a->>'expense_category')
      and (a->>'is_investment' is null or coalesce(l.is_investment, i.is_investment) = (a->>'is_investment')::boolean)
      and (a->>'item_type' is null or l.item_type = a->>'item_type')
      and (a->>'target_app' is null or exists (select 1 from invoices.allocations al where al.invoice_line_id = l.id and al.deleted_at is null and al.target_app = a->>'target_app'
            and (a->>'target_kind' is null or al.target_kind = a->>'target_kind') and (a->>'target_id' is null or al.target_id = a->>'target_id')))
      and (not coalesce((a->>'unassigned')::boolean, false) or l.net_amount - coalesce((select sum(al.allocated_amount) from invoices.allocations al where al.invoice_line_id = l.id and al.deleted_at is null), 0) > 0)
  )
  select coalesce(jsonb_agg(to_jsonb(b) || jsonb_build_object('unallocated_amount', greatest(0, b.net_amount - b.allocated_amount)) order by b.invoice_date desc, b.invoice_code, b.position), '[]'::jsonb), count(*) over ()
    into v_rows, v_total
  from (select * from base order by invoice_date desc, invoice_code, position limit v_limit offset v_offset) b
  group by ();
  if v_total is null then
    select count(*) into v_total from invoices.invoice_lines l join invoices.invoices i on i.id = l.invoice_id where l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and (not v_validated or i.status in ('validada', 'archivada')) and (v_from is null or i.invoice_date between v_from and v_to);
  end if;
  return jsonb_build_object('rows', coalesce(v_rows, '[]'::jsonb), 'total', coalesce(v_total, 0), 'limit', v_limit, 'offset', v_offset);
end $$;
select core.allow_read('invoices', 'invoices.items', 'function');

-- ---------------------------------------------------------------------------
-- Entregas a gestoría
-- ---------------------------------------------------------------------------
create or replace function invoices.export_manifest(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with inc as (
    select i.*, s.name supplier_name, s.tax_id supplier_tax_id from invoices.invoices i join invoices.suppliers s on s.id = i.supplier_id
    where i.deleted_at is null and i.invoice_date between p_from and p_to and i.status in ('validada', 'archivada')),
  exc as (select i.* from invoices.invoices i where i.deleted_at is null and i.invoice_date between p_from and p_to and i.status in ('pendiente_datos', 'pendiente_revision'))
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
        'missing_file', not exists (select 1 from invoices.invoice_files f where f.invoice_id = inc.id and f.deleted_at is null and f.kind = 'original')
      ) order by inc.invoice_date, inc.code), '[]'::jsonb) from inc),
    'excluded', (select coalesce(jsonb_agg(jsonb_build_object('id', exc.id, 'code', exc.code, 'status', exc.status, 'reason', exc.review_reason) order by exc.invoice_date, exc.code), '[]'::jsonb) from exc),
    'integrity', jsonb_build_object('algorithm', 'sha256', 'files', 'SHA-256 de cada archivo incluido, verificado por el servidor al subirlo'));
$$;

-- create_export: congela manifest y totales. No cambia el estado de ninguna factura.
create or replace function invoices.create_export(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_id uuid; v_range jsonb; v_kind text; v_year int; v_quarter int; v_from date; v_to date; v_folder text; v_manifest jsonb; v_sha text; v_count int; inv jsonb; v_item uuid; v_row jsonb;
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
  v_manifest := invoices.export_manifest(v_from, v_to, v_kind, v_year, v_quarter, v_folder);
  v_count := (v_manifest->>'invoice_count')::int;
  if v_count = 0 then perform core.fail('EXPORT_EMPTY', 422, jsonb_build_object('from', v_from, 'to', v_to)); end if;
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
  return jsonb_build_object('export_id', v_id, 'code', v_row->>'code', 'folder_name', v_folder, 'invoice_count', v_count, 'manifest_sha256', v_sha,
    'warnings', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v_manifest->'excluded') x));
end $$;

-- mark_delivered: la entrega se envió a la gestoría.
create or replace function invoices.mark_delivered(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; e invoices.exports;
begin
  perform set_config('invoices.procedure', 'mark_delivered', true);
  begin select * into e from invoices.exports where id = (a->>'export_id')::uuid for update; exception when others then e.id := null; end;
  if e.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.exports', 'id', a->>'export_id')); end if;
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> e.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.exports', 'id', e.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', e.revision, 'current', to_jsonb(e)));
  end if;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.exports', 'id', e.id, 'expectedRevision', e.revision, 'fields', jsonb_build_object(
    'status', 'entregada', 'delivered_at', now(), 'delivered_to', a->>'delivered_to')));
  select * into e from invoices.exports where id = e.id;
  return to_jsonb(e);
end $$;

-- archive_period: solo owner; archiva las validadas incluidas en una entrega ya entregada.
create or replace function invoices.archive_period(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; e invoices.exports; i record; v_n int := 0;
begin
  perform set_config('invoices.procedure', 'archive_period', true);
  if p->>'role' is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners archive a period')); end if;
  begin select * into e from invoices.exports where id = (a->>'export_id')::uuid; exception when others then e.id := null; end;
  if e.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.exports', 'id', a->>'export_id')); end if;
  if e.status <> 'entregada' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'export not delivered', 'export_id', e.id)); end if;
  for i in select inv.* from invoices.invoices inv join invoices.export_items ei on ei.invoice_id = inv.id where ei.export_id = e.id and inv.status = 'validada' and inv.deleted_at is null order by inv.invoice_date, inv.code loop
    perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', i.id, 'expectedRevision', i.revision, 'fields', jsonb_build_object('status', 'archivada')));
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('export_id', e.id, 'archived', v_n);
end $$;

select core.allow_procedure('invoices', 'invoices.import_v1');
select core.allow_procedure('invoices', 'invoices.validate');
select core.allow_procedure('invoices', 'invoices.annul');
select core.allow_procedure('invoices', 'invoices.create_export');
select core.allow_procedure('invoices', 'invoices.mark_delivered');
select core.allow_procedure('invoices', 'invoices.archive_period');

-- Lectura para la Edge al generar el ZIP: manifest tal cual se hasheó y rutas de Storage de cada documento.
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
    'files', (select coalesce(jsonb_agg(jsonb_build_object('invoice_code', ei.invoice_code, 'file_id', f->>'file_id', 'normalized_filename', f->>'normalized_filename',
        'sha256', f->>'sha256', 'size_bytes', (f->>'size_bytes')::bigint, 'bucket', cf.bucket, 'path', cf.path, 'status', cf.status) order by ei.invoice_code, f->>'normalized_filename'), '[]'::jsonb)
      from invoices.export_items ei, jsonb_array_elements(ei.files) f left join core.files cf on cf.id = (f->>'file_id')::uuid where ei.export_id = e.id),
    'stale', exists (select 1 from invoices.export_items ei join invoices.invoices i on i.id = ei.invoice_id where ei.export_id = e.id and (i.revision <> ei.invoice_revision or i.status = 'anulada'))
      or exists (select 1 from invoices.invoices i where i.deleted_at is null and i.status in ('validada', 'archivada') and i.invoice_date between e.from_date and e.to_date
                 and not exists (select 1 from invoices.export_items ei where ei.export_id = e.id and ei.invoice_id = i.id)));
end $$;
select core.allow_read('invoices', 'invoices.export_bundle', 'function');

-- Vista previa de una entrega sin crearla (POST exports/accountant).
create or replace function invoices.export_preview(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); v_range jsonb; v_kind text := coalesce(a->>'period_kind', 'quarter'); v_folder text; v_manifest jsonb;
begin
  if v_kind = 'quarter' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year', 'quarter', a->'fiscal_quarter'));
  elsif v_kind = 'year' then v_range := invoices.range_of(jsonb_build_object('year', a->'fiscal_year'));
  else v_range := invoices.range_of(jsonb_build_object('from', a->'from_date', 'to', a->'to_date')); end if;
  v_folder := case v_kind when 'quarter' then format('IKISAI_COMPRAS_%s_T%s', v_range->>'year', v_range->>'quarter') when 'year' then format('IKISAI_COMPRAS_%s', v_range->>'year')
    else format('IKISAI_COMPRAS_%s_%s', replace(v_range->>'from', '-', '_'), replace(v_range->>'to', '-', '_')) end;
  v_manifest := invoices.export_manifest((v_range->>'from')::date, (v_range->>'to')::date, v_kind, (v_range->>'year')::int, (v_range->>'quarter')::int, v_folder);
  return jsonb_build_object('folder_name', v_folder, 'range', v_range, 'invoice_count', v_manifest->'invoice_count', 'file_count', v_manifest->'file_count',
    'excluded', v_manifest->'excluded', 'totals', v_manifest->'totals',
    'invoices', (select coalesce(jsonb_agg(jsonb_build_object('id', x->'id', 'code', x->'code', 'invoice_date', x->'invoice_date', 'supplier', x->'supplier'->'name', 'total', x->'total', 'missing_file', x->'missing_file')), '[]'::jsonb) from jsonb_array_elements(v_manifest->'invoices') x));
end $$;
select core.allow_read('invoices', 'invoices.export_preview', 'function', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  for f in select 'invoices.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'invoices' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
