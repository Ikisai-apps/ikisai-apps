-- Invoices · facturas rectificativas RECIBIDAS (abonos y devoluciones de proveedores), aprobado por Core el 8-10-2026.
-- Toca solo el schema invoices.
--
-- Una rectificativa es una factura recibida con `invoice_kind = 'rectificativa'` e importes negativos (resta de la original).
-- - Enlace con la original por proveedor y número normalizado (`rectifies_number`): al llegar la rectificativa, o al llegar
--   la original después (hook de invariantes, en los dos sentidos). A mano, `rectifies_invoice_id` desde la ficha.
-- - Líneas devueltas: `invoice_lines.rectifies_line_id`, emparejadas por descripción normalizada al enlazar (editable).
-- - Signo: los impuestos y las asignaciones de una rectificativa son negativos; una ordinaria se comporta como siempre.
-- - Validar exige la original enlazada (o `rectification_without_original`, que queda como aviso) y total ≤ 0.
-- - Cuenta en el periodo de SU fecha con importes negativos: el resumen fiscal y la entrega ya suman con signo.

alter table invoices.invoices
  add column invoice_kind text not null default 'ordinaria' check (invoice_kind in ('ordinaria', 'rectificativa')),
  add column rectifies_invoice_id uuid references invoices.invoices(id),
  add column rectifies_number text check (rectifies_number is null or length(btrim(rectifies_number)) between 1 and 64),
  add column rectification_without_original boolean not null default false,
  add constraint invoices_rectifies_not_self check (rectifies_invoice_id is null or rectifies_invoice_id <> id);
create index invoices_rectifies_idx on invoices.invoices (rectifies_invoice_id) where rectifies_invoice_id is not null;

alter table invoices.invoice_lines add column rectifies_line_id uuid references invoices.invoice_lines(id);

-- Signo: el check de cada fila deja pasar negativos; el hook exige que una ordinaria no los tenga (paso 7) y que las
-- asignaciones lleven el signo de su línea sin pasar de su valor absoluto (paso 5).
alter table invoices.tax_lines drop constraint if exists tax_lines_amount_check;
alter table invoices.allocations drop constraint if exists allocations_allocated_amount_check;
alter table invoices.allocations add constraint allocations_allocated_amount_check check (allocated_amount <> 0);

select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url',
  'invoice_kind','rectifies_invoice_id','rectifies_number','rectification_without_original'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'invoice_lines', array[
  'invoice_id','position','description','quantity','unit','unit_price','discount_amount','net_amount','vat_rate','vat_amount','gross_amount',
  'item_type','match_name','expense_category','is_investment','confidence','notes','rectifies_line_id'], '{reader,editor,owner}', '{editor,owner}', true);

-- Número de factura comparable: sin espacios, puntos, guiones, barras ni mayúsculas («A-2026/0457» = «a 2026 0457»).
create or replace function invoices.normalized_number(p text)
returns text language sql immutable as $$ select nullif(lower(regexp_replace(coalesce(p, ''), '[\s.\-/_ºª°#]', '', 'g')), '') $$;

-- Enlaza una rectificativa con su original (si se encontró) dentro del lote del hook.
create or replace function invoices.link_rectification(p_ctx jsonb, p_rect uuid, p_original uuid)
returns void language plpgsql as $$
declare v invoices.invoices;
begin
  if p_original is null then return; end if;
  select * into v from invoices.invoices where id = p_rect;
  if v.id is null or v.rectifies_invoice_id is not null or v.status in ('validada', 'archivada', 'anulada') then return; end if;
  perform invoices.row_op(p_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', p_rect, 'expectedRevision', v.revision,
    'fields', jsonb_build_object('rectifies_invoice_id', p_original)));
  perform invoices.match_returned_lines(p_ctx, p_rect, p_original);
end $$;

-- Empareja las líneas de la rectificativa sin pareja con las de la original de igual descripción normalizada.
create or replace function invoices.match_returned_lines(p_ctx jsonb, p_rect uuid, p_original uuid)
returns void language plpgsql as $$
declare l record; v_match uuid;
begin
  for l in select * from invoices.invoice_lines where invoice_id = p_rect and deleted_at is null and rectifies_line_id is null loop
    select o.id into v_match from invoices.invoice_lines o
     where o.invoice_id = p_original and o.deleted_at is null and invoices.slugify(o.description, 200) = invoices.slugify(l.description, 200)
     order by o.position limit 1;
    if v_match is not null then
      perform invoices.row_op(p_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.invoice_lines', 'id', l.id, 'expectedRevision', l.revision,
        'fields', jsonb_build_object('rectifies_line_id', v_match)));
    end if;
  end loop;
end $$;

-- Hook de invariantes (de 0201) con asignaciones con signo, impuestos negativos solo en rectificativas y enlace.
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
      -- Con signo (0227): en una línea negativa (rectificativa) las asignaciones son negativas y no pasan de su valor absoluto.
      if abs(l.amount) > abs(l.net_amount) + 0.02 or (l.amount <> 0 and sign(l.amount) <> sign(l.net_amount)) then
        perform core.fail('ALLOCATIONS_EXCEED_LINE', 422, jsonb_build_object('line_id', l.id, 'allocated', l.amount, 'net_amount', l.net_amount));
      end if;
      if l.qty is not null and l.quantity is not null and l.qty > l.quantity + 0.001 then
        perform core.fail('ALLOCATIONS_EXCEED_QUANTITY', 422, jsonb_build_object('line_id', l.id, 'allocated', l.qty, 'quantity', l.quantity));
      end if;
    end loop;

    -- 6. Impuestos sin duplicar (tipo, tasa)
    select count(*) into v_dup from (select tax_type, rate from invoices.tax_lines where invoice_id = v_id and deleted_at is null group by tax_type, rate having count(*) > 1) d;
    if v_dup > 0 then perform core.fail('TAX_LINE_DUPLICATE', 422, jsonb_build_object('invoice_id', v_id)); end if;

    -- 7. Signo (0227): una factura ordinaria no lleva impuestos negativos; una rectificativa sí (resta de la original).
    select * into v_inv from invoices.invoices where id = v_id;
    if v_inv.invoice_kind = 'ordinaria' and exists (select 1 from invoices.tax_lines where invoice_id = v_id and deleted_at is null and amount < 0) then
      perform core.fail('NEGATIVE_TAX_IN_ORDINARY', 422, jsonb_build_object('invoice_id', v_id));
    end if;

    -- 8. Rectificativas (0227): enlace con la original por proveedor y número, en los dos sentidos, y líneas devueltas.
    if v_inv.invoice_kind = 'rectificativa' and v_inv.rectifies_invoice_id is null and v_inv.rectifies_number is not null then
      perform invoices.link_rectification(v_ctx, v_id, (select o.id from invoices.invoices o
        where o.deleted_at is null and o.status <> 'anulada' and o.id <> v_id and o.invoice_kind = 'ordinaria' and o.supplier_id = v_inv.supplier_id
          and invoices.normalized_number(o.invoice_number) = invoices.normalized_number(v_inv.rectifies_number) limit 1));
    elsif v_inv.invoice_kind = 'ordinaria' and v_inv.invoice_number is not null then
      for r in select rr.id from invoices.invoices rr
               where rr.deleted_at is null and rr.status <> 'anulada' and rr.invoice_kind = 'rectificativa' and rr.rectifies_invoice_id is null
                 and rr.supplier_id = v_inv.supplier_id and invoices.normalized_number(rr.rectifies_number) = invoices.normalized_number(v_inv.invoice_number) loop
        perform invoices.link_rectification(v_ctx, r.id, v_id);
      end loop;
    end if;
    -- Enlazada a mano desde la ficha: también se emparejan sus líneas.
    select * into v_inv from invoices.invoices where id = v_id;
    if v_inv.invoice_kind = 'rectificativa' and v_inv.rectifies_invoice_id is not null then
      perform invoices.match_returned_lines(v_ctx, v_id, v_inv.rectifies_invoice_id);
    end if;
  end loop;
end $$;

-- validate (de 0223) con las condiciones de la rectificativa.
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
  -- Rectificativa (0227): enlazada con la original (o «no tengo la original») y con total negativo o cero.
  if v_inv.invoice_kind = 'rectificativa' and v_inv.rectifies_invoice_id is null and not v_inv.rectification_without_original then
    v_missing := array_append(v_missing, 'rectified_invoice');
  end if;
  if v_inv.invoice_kind = 'rectificativa' and r.total > 0 then v_missing := array_append(v_missing, 'rectification_sign'); end if;
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

-- import_v1 (de 0226) con invoice_kind y rectifies_number en overrides.
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
  -- Origen y procedencia por campo (0226): quién leyó el documento y de dónde sale cada dato.
  if a->>'origin' is not null and a->>'origin' not in ('pdf_text', 'ia', 'api', 'json') then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.origin')); end if;
  if a->'provenance' is not null and (jsonb_typeof(a->'provenance') <> 'object' or length((a->'provenance')::text) > 20000) then perform core.fail('IMPORT_INVALID', 422, jsonb_build_object('path', 'args.provenance')); end if;

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
      'deductibility_suggestion', inv->'deductibility_suggestion', 'document_totals', doc->'document_totals', 'supplier_name', v_name, 'supplier_tax_id', inv->'supplier_tax_id', 'origin', a->>'origin', 'provenance', a->'provenance'),
    'notes', coalesce(ov->>'notes', inv->>'notes'),
    -- Rectificativa (0227): la detecta el dominio (lectura del PDF, IA o el usuario) y viaja en overrides.
    'invoice_kind', case when ov->>'invoice_kind' = 'rectificativa' then 'rectificativa' else 'ordinaria' end,
    'rectifies_number', case when ov->>'invoice_kind' = 'rectificativa' then nullif(btrim(coalesce(ov->>'rectifies_number', '')), '') end);
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

-- export_manifest (de 0201) con el tipo y la referencia a la original.
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
        'missing_file', not exists (select 1 from invoices.invoice_files f where f.invoice_id = inc.id and f.deleted_at is null and f.kind = 'original'),
        -- Rectificativa (0227): tipo y referencia a la original (que puede ser de otro periodo o faltar).
        'kind', inc.invoice_kind,
        'rectifies', case when inc.invoice_kind = 'rectificativa' then (select jsonb_build_object('code', o.code, 'invoice_number', coalesce(o.invoice_number, inc.rectifies_number),
            'invoice_date', o.invoice_date, 'other_period', o.invoice_date is not null and o.invoice_date not between p_from and p_to, 'without_original', o.id is null)
          from (select 1) one left join invoices.invoices o on o.id = inc.rectifies_invoice_id) end
      ) order by inc.invoice_date, inc.code), '[]'::jsonb) from inc),
    'excluded', (select coalesce(jsonb_agg(jsonb_build_object('id', exc.id, 'code', exc.code, 'status', exc.status, 'reason', exc.review_reason) order by exc.invoice_date, exc.code), '[]'::jsonb) from exc),
    'integrity', jsonb_build_object('algorithm', 'sha256', 'files', 'SHA-256 de cada archivo incluido, verificado por el servidor al subirlo'));
$$;
