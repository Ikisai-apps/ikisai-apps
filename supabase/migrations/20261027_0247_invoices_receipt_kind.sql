-- Invoices · factura o ticket (decisión de VG del 27-10; API.md §17.8). Toca solo el schema invoices.
--
-- 1) El «Justificante del día» de la barra es un TICKET: sin serie ni numeración de factura (lo hace la app).
-- 2) A la gestoría y al IVA soportado solo entran las FACTURAS:
--    - `invoices.invoices.receipt_kind` ('invoice' | 'ticket'; por defecto, factura: lo de siempre). Un ticket se
--      registra como gasto, pero queda fuera del resumen fiscal y de la entrega (no es deducible). Pasa a factura cuando
--      llega su factura; una factura validada no vuelve a ser ticket;
--    - `invoices.app_entries.receipt_kind`: un gasto de otra app es fiscal solo con factura (su IVA cuenta como
--      soportado, venga de la app que venga); con ticket se registra, de proceso, sin ir a la gestoría. Con justificante
--      y sin decir cuál, factura (lo de la 0245). Un ingreso con ticket sigue siendo fiscal: la venta va al IVA
--      repercutido.

alter table invoices.invoices add column receipt_kind text not null default 'invoice' check (receipt_kind in ('invoice', 'ticket'));
select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url',
  'invoice_kind','rectifies_invoice_id','rectifies_number','rectification_without_original',
  'declared_period','delivered_elsewhere','payment_source','receipt_kind'], '{reader,editor,owner}', '{editor,owner}', true);

-- Una factura validada no vuelve a ser ticket (al revés, sí: llega la factura de una compra con ticket). Mientras está
-- pendiente, se corrige en la ficha (una alta a mano que era un ticket).
create or replace function invoices.guard_receipt_kind()
returns trigger language plpgsql as $$
begin
  if old.receipt_kind = 'invoice' and new.receipt_kind = 'ticket' and old.status in ('validada', 'archivada') then
    perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', old.id, 'receipt_kind', old.receipt_kind, 'status', old.status));
  end if;
  return new;
end $$;
create trigger invoices_receipt_kind_guard before update of receipt_kind on invoices.invoices for each row execute function invoices.guard_receipt_kind();

alter table invoices.app_entries add column receipt_kind text check (receipt_kind is null or receipt_kind in ('invoice', 'ticket'));
-- Lo que ya tenía justificante (0245) era factura
update invoices.app_entries set receipt_kind = 'invoice' where receipt_file_id is not null or receipt_number is not null;
select core.register_table('invoices', 'invoices', 'app_entries', array[
  'source_app', 'source_ref', 'kind', 'nature', 'entry_date', 'description', 'amount_cents', 'tax_rate', 'tax_cents', 'net_cents',
  'pending_refunds_cents', 'methods', 'detail', 'event_id', 'notes', 'receipt_file_id', 'receipt_number', 'receipt_kind'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- Guarda de los apuntes (de 0245) con factura o ticket.
create or replace function invoices.guard_app_entry()
returns trigger language plpgsql as $$
declare
  v_proc boolean := coalesce(current_setting('invoices.procedure', true), '') = 'record_app_entry';
  v_actor uuid;
  v_free text[] := array['event_id', 'notes', 'receipt_file_id', 'receipt_number', 'receipt_kind', 'revision', 'updated_at', 'updated_by'];
begin
  begin v_actor := nullif(current_setting('core' || '.actor', true), '')::uuid; exception when others then v_actor := null; end;
  if tg_op = 'INSERT' then
    if not v_proc then perform core.fail('APP_ENTRY_PROCEDURE_ONLY', 422, jsonb_build_object('procedure', 'invoices.record_app_entry')); end if;
    new.received_by := v_actor; new.received_at := now();
    return new;
  end if;
  if new.deleted_at is distinct from old.deleted_at then perform core.fail('APP_ENTRY_NOT_DELETABLE', 422, jsonb_build_object('id', old.id)); end if;
  if v_proc then
    -- Las notas son de Finance.
    new.notes := old.notes;
    new.received_by := v_actor; new.received_at := now();
  elsif (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free) then
    perform core.fail('APP_ENTRY_PROCEDURE_ONLY', 422, jsonb_build_object('id', old.id));
  end if;
  if old.nature = 'fiscal' and new.nature = 'process' then perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', old.id, 'nature', old.nature)); end if;
  -- Factura o ticket (27-10): con justificante y sin decir cuál, factura; una factura no vuelve a ser ticket.
  if new.receipt_file_id is null and new.receipt_number is null then new.receipt_kind := null;
  elsif new.receipt_kind is null then new.receipt_kind := coalesce(old.receipt_kind, 'invoice'); end if;
  if old.receipt_kind = 'invoice' and new.receipt_kind = 'ticket' then perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', old.id, 'receipt_kind', old.receipt_kind)); end if;
  -- Con factura (o un ingreso con ticket), a fiscal: el único sentido permitido
  if new.nature = 'process' and (new.receipt_kind = 'invoice' or (new.kind = 'income' and new.receipt_kind = 'ticket')) then new.nature := 'fiscal'; end if;
  if new.nature = 'fiscal' and new.kind = 'expense' and new.receipt_kind is distinct from 'invoice' then
    perform core.fail('INVOICE_REQUIRED', 422, jsonb_build_object('id', old.id, 'reason', 'a fiscal expense needs an invoice'));
  end if;
  return new;
end $$;

-- record_app_entry (de 0245) con `receipt_kind`.
create or replace function invoices.record_app_entry(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := btrim(coalesce(a->>'source_app', ''));
  v_ref text := btrim(coalesce(a->>'source_ref', ''));
  v_kind text := a->>'kind';
  v_nature text := nullif(a->>'nature', '');
  v_receipt_file uuid; v_receipt_number text := nullif(btrim(coalesce(a->>'receipt_number', '')), '');
  v_receipt_kind text := nullif(a->>'receipt_kind', '');
  v_desc text := btrim(coalesce(a->>'description', ''));
  v_date date; v_amount bigint; v_rate numeric; v_pending bigint; v_net bigint; v_tax bigint;
  v_methods jsonb := coalesce(nullif(a->'methods', 'null'::jsonb), '{}'::jsonb);
  v_detail jsonb := coalesce(nullif(a->'detail', 'null'::jsonb), '[]'::jsonb);
  v_event uuid; v_fields jsonb; v_current jsonb; e invoices.app_entries; v_id uuid; v_status text; m record; d jsonb; v_sum bigint;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.record_app_entry')); end if;
  if v_app = 'invoices' or not exists (select 1 from core.apps where id = v_app) then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'source_app')); end if;
  if length(v_ref) not between 3 and 200 or left(v_ref, length(v_app) + 1) <> v_app || ':' then
    perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'source_ref', 'reason', 'starts with source_app and a colon, 3 to 200 characters'));
  end if;
  if v_kind is null or v_kind not in ('income', 'expense') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'kind')); end if;
  if v_nature is not null and v_nature not in ('fiscal', 'process') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'nature')); end if;
  if a->>'receipt_file_id' is not null then
    begin v_receipt_file := (a->>'receipt_file_id')::uuid; exception when others then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'receipt_file_id')); end;
  end if;
  if length(v_receipt_number) > 64 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'receipt_number')); end if;
  if v_receipt_kind is not null and v_receipt_kind not in ('invoice', 'ticket') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'receipt_kind')); end if;
  begin v_date := (a->>'entry_date')::date; exception when others then v_date := null; end;
  if v_date is null or (a->>'entry_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'entry_date')); end if;
  if length(v_desc) not between 1 and 300 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'description')); end if;
  v_amount := invoices.app_entry_int(a, 'amount_cents');
  v_pending := invoices.app_entry_int(a, 'pending_refunds_cents', 0);
  if v_pending < 0 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'pending_refunds_cents')); end if;
  if (case when jsonb_typeof(a->'tax_rate') = 'number' then (a->>'tax_rate')::numeric not between 0 and 100 else true end) then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'tax_rate')); end if;
  v_rate := round((a->>'tax_rate')::numeric, 2);
  -- IVA incluido: el neto se redondea al céntimo y la cuota es el resto, así siempre suman el importe.
  v_net := round(v_amount * 100 / (100 + v_rate)); v_tax := v_amount - v_net;
  if a ? 'tax_cents' and invoices.app_entry_int(a, 'tax_cents') <> v_tax then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'tax_cents', 'expected', v_tax)); end if;
  if a ? 'net_cents' and invoices.app_entry_int(a, 'net_cents') <> v_net then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'net_cents', 'expected', v_net)); end if;
  -- Medios de cobro o pago: {cash, bizum, …} en céntimos; si vienen, suman el importe.
  if jsonb_typeof(v_methods) <> 'object' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'methods')); end if;
  v_sum := 0;
  for m in select key, value from jsonb_each(v_methods) loop
    if m.key !~ '^[a-z_]{1,30}$' or jsonb_typeof(m.value) <> 'number' or (m.value #>> '{}') !~ '^-?[0-9]{1,13}$' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'methods', 'key', m.key)); end if;
    v_sum := v_sum + (m.value #>> '{}')::bigint;
  end loop;
  if v_methods <> '{}'::jsonb and v_sum <> v_amount then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'methods', 'reason', 'methods must add up to amount_cents', 'sum', v_sum)); end if;
  -- Desglose: [{code?, name, quantity, amount_cents}]; lo vendido más las devoluciones pendientes es el importe.
  if jsonb_typeof(v_detail) <> 'array' or jsonb_array_length(v_detail) > 500 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'detail')); end if;
  v_sum := 0;
  for d in select x from jsonb_array_elements(v_detail) x loop
    if jsonb_typeof(d) <> 'object' or length(btrim(coalesce(d->>'name', ''))) not between 1 and 200 or jsonb_typeof(d->'quantity') is distinct from 'number' then
      perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'detail', 'item', d));
    end if;
    v_sum := v_sum + invoices.app_entry_int(d, 'amount_cents');
  end loop;
  if jsonb_array_length(v_detail) > 0 and v_sum + v_pending <> v_amount then
    perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'detail', 'reason', 'detail plus pending_refunds_cents must equal amount_cents', 'sum', v_sum));
  end if;
  if a->>'event_id' is not null then
    begin v_event := (a->>'event_id')::uuid; exception when others then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'event_id')); end;
  end if;

  perform set_config('invoices.procedure', 'record_app_entry', true);
  select * into e from invoices.app_entries where source_app = v_app and source_ref = v_ref and deleted_at is null for update;
  -- Sin «desfacturar»: pedir proceso para un apunte que ya es fiscal, no.
  if e.id is not null and e.nature = 'fiscal' and v_nature = 'process' then perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref, 'nature', e.nature)); end if;
  -- El justificante que ya tenía (puesto aquí o en Finance) se queda si el reenvío no lo trae.
  v_receipt_file := coalesce(v_receipt_file, e.receipt_file_id); v_receipt_number := coalesce(v_receipt_number, e.receipt_number);
  -- Factura o ticket (VG, 27-10). Con justificante y sin decir cuál, factura (lo de la 0245). Un ticket de gasto no es fiscal.
  v_receipt_kind := case when v_receipt_file is null and v_receipt_number is null then null else coalesce(v_receipt_kind, e.receipt_kind, 'invoice') end;
  if e.id is not null and e.receipt_kind = 'invoice' and v_receipt_kind = 'ticket' then
    perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref, 'receipt_kind', e.receipt_kind, 'reason', 'an invoice does not become a ticket'));
  end if;
  -- De proceso a fiscal solo con su justificante (VG, 27-10): pedir fiscal sin él, no.
  if e.id is not null and e.nature = 'process' and v_nature = 'fiscal' and v_receipt_file is null and v_receipt_number is null and e.receipt_file_id is null and e.receipt_number is null then
    perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref, 'nature', e.nature, 'reason', 'process becomes fiscal only with its invoice or ticket'));
  end if;
  -- Naturaleza: la que mande la app; sin ella, la que ya tenía si era fiscal; si no, un gasto es fiscal con justificante y
  -- de proceso sin él, y un ingreso, fiscal (lo antiguo).
  v_nature := coalesce(v_nature, case when e.nature = 'fiscal' then 'fiscal'
    when v_kind = 'expense' then case when v_receipt_kind = 'invoice' then 'fiscal' else 'process' end
    else 'fiscal' end);
  -- Con factura, a fiscal; un ingreso con ticket también (la venta va al IVA repercutido). Un gasto con ticket, no.
  if v_nature = 'process' and (v_receipt_kind = 'invoice' or (v_kind = 'income' and v_receipt_kind = 'ticket')) then v_nature := 'fiscal'; end if;
  if v_nature = 'fiscal' and v_kind = 'expense' and v_receipt_kind is distinct from 'invoice' then
    perform core.fail('INVOICE_REQUIRED', 422, jsonb_build_object('field', 'receipt_kind', 'reason', 'a fiscal expense needs an invoice; with a ticket it is recorded but not deductible'));
  end if;
  -- Sin «desfacturar»: de fiscal no se vuelve a proceso (de proceso a fiscal sí, cuando llega su justificante).
  if e.id is not null and e.nature = 'fiscal' and v_nature = 'process' then perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref, 'nature', e.nature)); end if;
  v_fields := jsonb_build_object('source_app', v_app, 'source_ref', v_ref, 'kind', v_kind, 'nature', v_nature, 'entry_date', v_date, 'description', v_desc,
    'amount_cents', v_amount, 'tax_rate', v_rate, 'tax_cents', v_tax, 'net_cents', v_net, 'pending_refunds_cents', v_pending,
    'methods', v_methods, 'detail', v_detail,
    -- El evento enlazado a mano en Finance se queda si la otra app no manda uno.
    'event_id', coalesce(v_event, e.event_id), 'receipt_file_id', v_receipt_file, 'receipt_number', v_receipt_number, 'receipt_kind', v_receipt_kind);
  if e.id is null then
    v_id := gen_random_uuid();
    perform invoices.row_op(p, jsonb_build_object('op', 'insert', 'table', 'invoices.app_entries', 'id', v_id, 'fields', v_fields));
    v_status := 'created';
  else
    v_id := e.id;
    select jsonb_object_agg(k, to_jsonb(e)->k) into v_current from jsonb_object_keys(v_fields) k;
    if v_current = v_fields then
      v_status := 'unchanged';
    else
      if invoices.app_entry_delivered(e.id) then perform core.fail('ENTRY_LOCKED', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref)); end if;
      perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.app_entries', 'id', e.id, 'expectedRevision', e.revision, 'fields', v_fields));
      v_status := 'replaced';
    end if;
  end if;
  perform set_config('invoices.procedure', '', true);
  select * into e from invoices.app_entries where id = v_id;
  return jsonb_build_object('entry_id', e.id, 'status', v_status, 'revision', e.revision, 'nature', e.nature, 'receipt_kind', e.receipt_kind, 'tax_cents', e.tax_cents, 'net_cents', e.net_cents);
end $$;

-- Resumen fiscal (de 0228): solo las facturas; los tickets, fuera.
create or replace function invoices.fiscal_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.invoices i where i.deleted_at is null and i.receipt_kind = 'invoice' and i.declaration_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
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

-- Manifest de la entrega (de 0231): solo las facturas.
create or replace function invoices.export_manifest(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with inc as (
    select i.*, s.name supplier_name, s.tax_id supplier_tax_id from invoices.invoices i join invoices.suppliers s on s.id = i.supplier_id
    where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('validada', 'archivada') and not i.delivered_elsewhere and i.receipt_kind = 'invoice'),
  exc as (select i.* from invoices.invoices i where i.deleted_at is null and i.declaration_date between p_from and p_to and i.status in ('pendiente_datos', 'pendiente_revision') and not i.delivered_elsewhere and i.receipt_kind = 'invoice')
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

-- export_bundle (de 0245): un ticket no la desfasa; una factura que pasa a ticket, sí (no debería: lo impide la guarda).
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
    'stale', exists (select 1 from invoices.export_items ei join invoices.invoices i on i.id = ei.invoice_id where ei.export_id = e.id and (i.revision <> ei.invoice_revision or i.status = 'anulada' or i.receipt_kind <> 'invoice'))
      or exists (select 1 from invoices.invoices i where i.deleted_at is null and i.status in ('validada', 'archivada') and i.declaration_date between e.from_date and e.to_date and not i.delivered_elsewhere and i.receipt_kind = 'invoice'
                 and not exists (select 1 from invoices.export_items ei where ei.export_id = e.id and ei.invoice_id = i.id))
      or (e.manifest ? 'issued' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss join invoices.issued_invoices ii on ii.id = (iss->>'id')::uuid where ii.revision <> (iss->>'revision')::bigint)
        or exists (select 1 from invoices.issued_invoices ii where ii.deleted_at is null and ii.status <> 'borrador' and ii.issue_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id))))
      or (e.manifest ? 'app_entries' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'app_entries') x join invoices.app_entries ae on ae.id = (x->>'id')::uuid
                where ae.revision <> (x->>'revision')::bigint)
        or exists (select 1 from invoices.app_entries ae where ae.deleted_at is null and ae.nature = 'fiscal' and ae.entry_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'app_entries') x where (x->>'id')::uuid = ae.id)))));
end $$;

revoke all on function invoices.guard_receipt_kind(), invoices.guard_app_entry(), invoices.record_app_entry(jsonb), invoices.fiscal_summary_for(date, date, uuid[]),
  invoices.export_manifest(date, date, text, int, int, text), invoices.export_bundle(jsonb) from public, anon, authenticated;
