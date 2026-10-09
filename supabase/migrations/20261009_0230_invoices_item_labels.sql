-- Invoices · «Mi nombre» de cada artículo, con memoria por proveedor (9-10-2026, petición del usuario vía Core).
-- Toca solo el schema invoices.
--
-- - `invoice_lines.label`: el nombre propio del usuario (hasta 120 caracteres). La descripción de la factura no se toca,
--   porque es la que vale fiscalmente, y la entrega a la gestoría (CSV y manifest) sigue usándola.
-- - `invoice_lines.label_source`: «manual» (lo escribió una persona) o «recordado» (puesto solo, desde la memoria). Lo
--   pone el disparador; el cliente no lo escribe.
-- - `invoices.item_labels`: la memoria, por proveedor y clave del artículo (`cod:<código>` si la descripción empieza por
--   un código, o `txt:<descripción normalizada>`). Se aprende al validar una factura con nombres propios (hook) y se
--   aplica sola al insertar una línea del mismo proveedor y clave, venga de donde venga (importación, a mano, Drive, lote).

alter table invoices.invoice_lines
  add column label text check (label is null or length(btrim(label)) between 1 and 120),
  add column label_source text check (label_source is null or label_source in ('manual', 'recordado'));

select core.register_table('invoices', 'invoices', 'invoice_lines', array[
  'invoice_id','position','description','quantity','unit','unit_price','discount_amount','net_amount','vat_rate','vat_amount','gross_amount',
  'item_type','match_name','expense_category','is_investment','confidence','notes','rectifies_line_id','label'], '{reader,editor,owner}', '{editor,owner}', true);

create table invoices.item_labels (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  supplier_id uuid not null references invoices.suppliers(id),
  match_key text not null check (length(match_key) between 5 and 210),
  label text not null check (length(btrim(label)) between 1 and 120),
  uses int not null default 1 check (uses >= 0),
  last_invoice_id uuid references invoices.invoices(id)
);
create unique index item_labels_key_uq on invoices.item_labels (supplier_id, match_key) where deleted_at is null;
-- El hook de validación escribe todas las columnas; el cliente solo puede corregir `label` o borrar una entrada (lo
-- impone la Edge).
select core.register_table('invoices', 'invoices', 'item_labels', array['supplier_id','match_key','label','uses','last_invoice_id'], '{reader,editor,owner}', '{editor,owner}', true);

-- Clave de un artículo: el código si la descripción empieza por uno (letras y cifras, con alguna cifra), si no el texto
-- normalizado (minúsculas, sin acentos ni signos, espacios simples).
create or replace function invoices.item_key(p_description text)
returns text language sql immutable as $$
  with n as (
    select btrim(regexp_replace(regexp_replace(translate(lower(coalesce(p_description, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'), '[^a-z0-9]+', ' ', 'g'), '\s+', ' ', 'g')) as t),
  f as (select t, split_part(t, ' ', 1) as first from n)
  select case
    when t = '' then null
    when first ~ '[0-9]' and length(first) between 3 and 20 and position(' ' in t) > 0 then 'cod:' || first
    else 'txt:' || left(t, 200) end
  from f;
$$;

-- Al insertar una línea sin nombre propio: el recordado para ese proveedor y artículo. Al cambiar el nombre, «manual».
create or replace function invoices.apply_item_label()
returns trigger language plpgsql as $$
declare v_label text;
begin
  if tg_op = 'INSERT' then
    if new.label is not null then new.label_source := 'manual'; return new; end if;
    select il.label into v_label from invoices.item_labels il
      join invoices.invoices i on i.id = new.invoice_id and i.supplier_id = il.supplier_id
     where il.deleted_at is null and il.match_key = invoices.item_key(new.description);
    if v_label is not null then new.label := v_label; new.label_source := 'recordado'; end if;
    return new;
  end if;
  if new.label is distinct from old.label then new.label_source := case when new.label is null then null else 'manual' end; end if;
  return new;
end $$;
create trigger invoices_apply_item_label before insert or update on invoices.invoice_lines for each row execute function invoices.apply_item_label();

-- Hook de validación: al validar una factura, sus líneas con nombre propio se guardan en la memoria del proveedor.
create or replace function invoices.learn_item_labels(p jsonb)
returns void language plpgsql as $$
declare v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p); l record; m invoices.item_labels;
begin
  for l in
    select distinct on (invoices.item_key(li.description)) i.id as invoice_id, i.supplier_id, invoices.item_key(li.description) as match_key, btrim(li.label) as label
      from invoices.invoices i
      join invoices.invoice_lines li on li.invoice_id = i.id and li.deleted_at is null and li.label is not null
     where i.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'invoices'
                      and ch.op = 'update' and ch.after->>'status' = 'validada' and ch.before->>'status' is distinct from 'validada')
       and invoices.item_key(li.description) is not null
     order by invoices.item_key(li.description), li.position
  loop
    select * into m from invoices.item_labels where supplier_id = l.supplier_id and match_key = l.match_key and deleted_at is null;
    if m.id is null then
      perform invoices.row_op(v_ctx, jsonb_build_object('op', 'insert', 'table', 'invoices.item_labels', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('supplier_id', l.supplier_id, 'match_key', l.match_key, 'label', l.label, 'uses', 1, 'last_invoice_id', l.invoice_id)));
    else
      perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.item_labels', 'id', m.id, 'expectedRevision', m.revision,
        'fields', jsonb_build_object('label', l.label, 'uses', m.uses + 1, 'last_invoice_id', l.invoice_id)));
    end if;
  end loop;
end $$;
select core.add_validate_hook('invoices', 'invoices.learn_item_labels');

-- Cambiar solo «Mi nombre» de una línea no es editar la factura: no la devuelve a «Pendiente de revisión».
create or replace function invoices.label_only_change(p_op text, p_before jsonb, p_after jsonb)
returns boolean language sql immutable as $$
  select p_op = 'update' and p_before is not null and p_after is not null
     and (p_before - array['label', 'label_source', 'revision', 'updated_at', 'updated_by']) = (p_after - array['label', 'label_source', 'revision', 'updated_at', 'updated_by']);
$$;

-- check_invariants (de 0227) con esa excepción en «editada tras validar»; el resto, igual.
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
        and (ch.table_name = 'tax_lines' or (ch.table_name = 'invoice_lines' and not invoices.label_only_change(ch.op, ch.before, ch.after))
             or (ch.table_name = 'invoice_files' and coalesce(ch.after, ch.before)->>'kind' = 'original'))) into v_children;
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

-- Proyección de stock para Food (de 0203): el nombre propio si lo hay.
create or replace view invoices.food_stock_projection as
  select a.id as allocation_id, a.target_kind, a.target_id, i.code as invoice_code, i.invoice_date, s.name as supplier_name,
         coalesce(l.label, l.description) as line_description, l.match_name, a.allocated_quantity, l.unit, a.allocated_amount, a.revision as allocation_revision,
         nu.unit as unit_normalized, round(a.allocated_quantity * nu.factor, 4) as quantity_normalized
  from invoices.allocations a
  join invoices.invoice_lines l on l.id = a.invoice_line_id
  join invoices.invoices i on i.id = a.invoice_id
  join invoices.suppliers s on s.id = i.supplier_id
  cross join lateral invoices.normalize_unit(l.unit) nu
  where a.deleted_at is null and l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'food';

revoke all on function invoices.item_key(text), invoices.learn_item_labels(jsonb), invoices.label_only_change(text, jsonb, jsonb) from public, anon, authenticated;
