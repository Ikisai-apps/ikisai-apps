-- Invoices · apuntes fiscales y de proceso (decisión de VG del 27-10; API.md §17.7). Toca solo el schema invoices.
--
-- - `nature` en `invoices.app_entries`:
--   · `fiscal`: lo que acaba en factura o ticket. Va a la gestoría, al IVA y al justificante;
--   · `process`: informativo, como el resumen del cierre del día. Se ve y cuenta en «Evento», pero no va a la gestoría.
-- - Por defecto `fiscal`, para lo que ya hay y para lo que llegue sin `nature`: el sábado 31 todo sigue igual.
-- - `record_app_entry` la fija al crear y no la cambia al sustituir (409 NATURE_CHANGE). Sin «desfacturar».
-- - En Finance no se escribe: la guarda de la 0244 solo deja cambiar el evento y las notas.
-- - El resumen (con `process` aparte, informativo), el manifest y la entrega desactualizada: solo lo fiscal.
-- - Justificante (VG, 27-10: a la gestoría va solo lo que tiene factura o ticket, ingresos y gastos):
--   · `receipt_file_id` (documento de Finance en `core.files`) y `receipt_number` (número de la factura o del ticket);
--   · un gasto sin `nature` explícita es `fiscal` si trae justificante y `process` si no. Un gasto `fiscal` sin
--     justificante se rechaza. Un ingreso sin `nature` sigue siendo `fiscal` (lo antiguo); Flow manda `nature`;
--   · adjuntar el justificante después, al sustituir o en Finance, lo pasa a `fiscal`. Ese sentido se permite; el
--     contrario, no (409 NATURE_CHANGE);
--   · en Finance se puede escribir el justificante, además del evento y las notas. Lo que puso Finance no lo borra
--     un reenvío que no lo trae.

alter table invoices.app_entries
  add column nature text not null default 'fiscal' check (nature in ('fiscal', 'process')),
  add column receipt_file_id uuid references core.files(id),
  add column receipt_number text check (receipt_number is null or length(btrim(receipt_number)) between 1 and 64);
select core.register_file_field('invoices', 'invoices', 'app_entries', 'receipt_file_id', 'legal');

select core.register_table('invoices', 'invoices', 'app_entries', array[
  'source_app', 'source_ref', 'kind', 'nature', 'entry_date', 'description', 'amount_cents', 'tax_rate', 'tax_cents', 'net_cents',
  'pending_refunds_cents', 'methods', 'detail', 'event_id', 'notes', 'receipt_file_id', 'receipt_number'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- Guarda (de 0244): en Finance, además del evento y las notas, el justificante. Con justificante, un apunte de proceso
-- pasa a fiscal; un gasto fiscal no se queda sin él.
create or replace function invoices.guard_app_entry()
returns trigger language plpgsql as $$
declare
  v_proc boolean := coalesce(current_setting('invoices.procedure', true), '') = 'record_app_entry';
  v_actor uuid;
  v_free text[] := array['event_id', 'notes', 'receipt_file_id', 'receipt_number', 'revision', 'updated_at', 'updated_by'];
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
  -- Con justificante, a fiscal (el único sentido permitido)
  if new.nature = 'process' and (new.receipt_file_id is not null or new.receipt_number is not null) then new.nature := 'fiscal'; end if;
  if new.nature = 'fiscal' and new.kind = 'expense' and new.receipt_file_id is null and new.receipt_number is null then
    perform core.fail('RECEIPT_REQUIRED', 422, jsonb_build_object('id', old.id, 'reason', 'a fiscal expense needs its invoice or ticket'));
  end if;
  return new;
end $$;

-- record_app_entry (de 0244) con `nature` y el justificante.
create or replace function invoices.record_app_entry(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := btrim(coalesce(a->>'source_app', ''));
  v_ref text := btrim(coalesce(a->>'source_ref', ''));
  v_kind text := a->>'kind';
  v_nature text := nullif(a->>'nature', '');
  v_receipt_file uuid; v_receipt_number text := nullif(btrim(coalesce(a->>'receipt_number', '')), '');
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
  -- Naturaleza: la que mande la app; sin ella, la que ya tenía si era fiscal; si no, un gasto es fiscal con justificante y
  -- de proceso sin él, y un ingreso, fiscal (lo antiguo).
  v_nature := coalesce(v_nature, case when e.nature = 'fiscal' then 'fiscal'
    when v_kind = 'expense' then case when v_receipt_file is not null or v_receipt_number is not null then 'fiscal' else 'process' end
    else 'fiscal' end);
  if v_nature = 'process' and (v_receipt_file is not null or v_receipt_number is not null) then v_nature := 'fiscal'; end if;
  if v_nature = 'fiscal' and v_kind = 'expense' and v_receipt_file is null and v_receipt_number is null then
    perform core.fail('RECEIPT_REQUIRED', 422, jsonb_build_object('field', 'receipt_file_id', 'reason', 'a fiscal expense needs its invoice or ticket'));
  end if;
  -- Sin «desfacturar»: de fiscal no se vuelve a proceso (de proceso a fiscal sí, cuando llega su justificante).
  if e.id is not null and e.nature = 'fiscal' and v_nature = 'process' then perform core.fail('NATURE_CHANGE', 409, jsonb_build_object('id', e.id, 'source_ref', v_ref, 'nature', e.nature)); end if;
  v_fields := jsonb_build_object('source_app', v_app, 'source_ref', v_ref, 'kind', v_kind, 'nature', v_nature, 'entry_date', v_date, 'description', v_desc,
    'amount_cents', v_amount, 'tax_rate', v_rate, 'tax_cents', v_tax, 'net_cents', v_net, 'pending_refunds_cents', v_pending,
    'methods', v_methods, 'detail', v_detail,
    -- El evento enlazado a mano en Finance se queda si la otra app no manda uno.
    'event_id', coalesce(v_event, e.event_id), 'receipt_file_id', v_receipt_file, 'receipt_number', v_receipt_number);
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
  return jsonb_build_object('entry_id', e.id, 'status', v_status, 'revision', e.revision, 'nature', e.nature, 'tax_cents', e.tax_cents, 'net_cents', e.net_cents);
end $$;

-- Resumen (de 0244): solo lo fiscal; lo de proceso, aparte.
create or replace function invoices.app_entries_summary_for(p_from date, p_to date)
returns jsonb language sql stable as $$
  with all_live as (select * from invoices.app_entries where deleted_at is null and entry_date between p_from and p_to),
  live as (select * from all_live where nature = 'fiscal'),
  inc as (select * from live where kind = 'income'),
  exp as (select * from live where kind = 'expense')
  select jsonb_build_object(
    'income', jsonb_build_object('count', (select count(*) from inc),
      'base', (select coalesce(sum(net_cents), 0) / 100.0 from inc), 'quota', (select coalesce(sum(tax_cents), 0) / 100.0 from inc),
      'total', (select coalesce(sum(amount_cents), 0) / 100.0 from inc),
      'quota_by_rate', (select coalesce(jsonb_agg(jsonb_build_object('rate', g.rate, 'base', g.base, 'quota', g.quota) order by g.rate), '[]'::jsonb)
        from (select tax_rate rate, sum(net_cents) / 100.0 base, sum(tax_cents) / 100.0 quota from inc group by tax_rate) g),
      'by_app', (select coalesce(jsonb_agg(jsonb_build_object('source_app', g.source_app, 'count', g.n, 'total', g.total) order by g.source_app), '[]'::jsonb)
        from (select source_app, count(*) n, sum(amount_cents) / 100.0 total from inc group by source_app) g)),
    'expense', jsonb_build_object('count', (select count(*) from exp),
      'base', (select coalesce(sum(net_cents), 0) / 100.0 from exp), 'quota', (select coalesce(sum(tax_cents), 0) / 100.0 from exp),
      'total', (select coalesce(sum(amount_cents), 0) / 100.0 from exp)),
    -- Apuntes de proceso: informativos, fuera de la cuenta fiscal
    'process', (select jsonb_build_object('count', count(*), 'income', coalesce(sum(amount_cents) filter (where kind = 'income'), 0) / 100.0,
      'expense', coalesce(sum(amount_cents) filter (where kind = 'expense'), 0) / 100.0) from all_live where nature = 'process'));
$$;

-- Manifest (de 0244): solo lo fiscal.
create or replace function invoices.app_entries_manifest(p_from date, p_to date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'revision', x.revision, 'source_app', x.source_app, 'source_ref', x.source_ref, 'kind', x.kind, 'entry_date', x.entry_date,
      'description', x.description, 'tax_rate', x.tax_rate, 'base', x.net_cents / 100.0, 'quota', x.tax_cents / 100.0, 'total', x.amount_cents / 100.0,
      'pending_refunds', x.pending_refunds_cents / 100.0,
      'methods', (select coalesce(jsonb_object_agg(k, (v #>> '{}')::numeric / 100), '{}'::jsonb) from jsonb_each(x.methods) m(k, v)),
      'event_id', x.event_id) order by x.entry_date, x.source_app, x.source_ref), '[]'::jsonb)
  from invoices.app_entries x where x.deleted_at is null and x.nature = 'fiscal' and x.entry_date between p_from and p_to;
$$;

-- export_bundle (de 0244): los apuntes nuevos que la desfasan son solo los fiscales.
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
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'issued') iss where (iss->>'id')::uuid = ii.id))))
      or (e.manifest ? 'app_entries' and (
        exists (select 1 from jsonb_array_elements(e.manifest->'app_entries') x join invoices.app_entries ae on ae.id = (x->>'id')::uuid
                where ae.revision <> (x->>'revision')::bigint)
        or exists (select 1 from invoices.app_entries ae where ae.deleted_at is null and ae.nature = 'fiscal' and ae.entry_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'app_entries') x where (x->>'id')::uuid = ae.id)))));
end $$;

revoke all on function invoices.guard_app_entry(), invoices.record_app_entry(jsonb), invoices.app_entries_summary_for(date, date), invoices.app_entries_manifest(date, date), invoices.export_bundle(jsonb)
  from public, anon, authenticated;
