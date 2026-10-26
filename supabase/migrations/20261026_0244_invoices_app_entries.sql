-- Invoices · ingresos y gastos que llegan de otras apps (encargo de VG del 26-10-2026, plazo jueves 29; API.md §17).
-- Toca solo el schema invoices. Primer emisor: Flow, con las ventas de la barra del evento del 31-10.
--
-- - `invoices.app_entries`: un apunte por (source_app, source_ref), p. ej. «flow:project:<uuid>:2026-10-31». Importes en
--   céntimos, IVA incluido; Finance calcula cuota y neto con `tax_rate`. Sincronizable y `never_purge`; no se borra.
-- - `invoices.record_app_entry`: lo llama la otra app por `invoices-api` (`POST commands`, `call`) con la sesión de quien
--   cierra (editor u owner en Finance). Idempotente por (source_app, source_ref): la segunda llamada sustituye el apunte
--   («replaced») o no hace nada si es igual («unchanged»). Si el apunte ya está en una entrega entregada a la gestoría,
--   409 ENTRY_LOCKED. Nunca toca «facturado» ni el evento que se enlazó a mano en Finance.
-- - Facturado (decisión de VG): cada apunte se puede facturar o no; por defecto, sí. En Finance solo se cambian
--   `invoiced`, `invoiced_reason`, `event_id` y `notes`; quién y cuándo cambió «facturado» lo pone el disparador. Lo
--   facturado entra en el resumen y en la entrega del periodo de su fecha (los ingresos, como IVA repercutido); lo no
--   facturado queda fuera, pero visible (`app_entries_totals.not_invoiced`). Con la entrega ya entregada, ENTRY_LOCKED.

create table invoices.app_entries (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  source_app text not null references core.apps(id),
  source_ref text not null check (length(source_ref) between 3 and 200),
  kind text not null check (kind in ('income', 'expense')),
  entry_date date not null,
  description text not null check (length(btrim(description)) between 1 and 300),
  amount_cents bigint not null,
  tax_rate numeric(5,2) not null check (tax_rate between 0 and 100),
  tax_cents bigint not null,
  net_cents bigint not null,
  pending_refunds_cents bigint not null default 0 check (pending_refunds_cents >= 0),
  methods jsonb not null default '{}'::jsonb check (jsonb_typeof(methods) = 'object'),
  detail jsonb not null default '[]'::jsonb check (jsonb_typeof(detail) = 'array'),
  event_id uuid,
  invoiced boolean not null default true,
  invoiced_reason text check (invoiced_reason is null or length(invoiced_reason) <= 300),
  invoiced_changed_by uuid references auth.users(id),
  invoiced_changed_at timestamptz,
  received_by uuid references auth.users(id),
  received_at timestamptz not null default now(),
  notes text check (notes is null or length(notes) <= 2000),
  constraint app_entries_split check (tax_cents + net_cents = amount_cents),
  constraint app_entries_ref_prefix check (left(source_ref, length(source_app) + 1) = source_app || ':')
);
create unique index app_entries_source_live on invoices.app_entries (source_app, source_ref) where deleted_at is null;
create index app_entries_date_idx on invoices.app_entries (entry_date);
create index app_entries_event_idx on invoices.app_entries (event_id) where event_id is not null;

select core.register_table('invoices', 'invoices', 'app_entries', array[
  'source_app', 'source_ref', 'kind', 'entry_date', 'description', 'amount_cents', 'tax_rate', 'tax_cents', 'net_cents',
  'pending_refunds_cents', 'methods', 'detail', 'event_id', 'invoiced', 'invoiced_reason', 'notes'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- ¿Está el apunte en una entrega ya entregada a la gestoría?
create or replace function invoices.app_entry_delivered(p_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from invoices.exports e
    where e.deleted_at is null and e.status = 'entregada' and e.manifest->'app_entries' @> jsonb_build_array(jsonb_build_object('id', p_id)))
$$;

-- Guarda: lo que viene de la otra app solo lo escribe `record_app_entry`; en Finance, solo facturado, motivo, evento y notas.
create or replace function invoices.guard_app_entry()
returns trigger language plpgsql as $$
declare
  v_proc boolean := coalesce(current_setting('invoices.procedure', true), '') = 'record_app_entry';
  v_actor uuid;
  v_free text[] := array['invoiced', 'invoiced_reason', 'invoiced_changed_by', 'invoiced_changed_at', 'event_id', 'notes', 'revision', 'updated_at', 'updated_by'];
begin
  begin v_actor := nullif(current_setting('core.actor', true), '')::uuid; exception when others then v_actor := null; end;
  if tg_op = 'INSERT' then
    if not v_proc then perform core.fail('APP_ENTRY_PROCEDURE_ONLY', 422, jsonb_build_object('procedure', 'invoices.record_app_entry')); end if;
    new.received_by := v_actor; new.received_at := now();
    new.invoiced := true; new.invoiced_reason := null; new.invoiced_changed_by := null; new.invoiced_changed_at := null;
    return new;
  end if;
  if new.deleted_at is distinct from old.deleted_at then perform core.fail('APP_ENTRY_NOT_DELETABLE', 422, jsonb_build_object('id', old.id)); end if;
  if v_proc then
    -- La otra app no decide lo que se decide en Finance.
    new.invoiced := old.invoiced; new.invoiced_reason := old.invoiced_reason;
    new.invoiced_changed_by := old.invoiced_changed_by; new.invoiced_changed_at := old.invoiced_changed_at; new.notes := old.notes;
    new.received_by := v_actor; new.received_at := now();
    return new;
  end if;
  if (to_jsonb(new) - v_free) <> (to_jsonb(old) - v_free) then perform core.fail('APP_ENTRY_PROCEDURE_ONLY', 422, jsonb_build_object('id', old.id)); end if;
  new.invoiced_changed_by := old.invoiced_changed_by; new.invoiced_changed_at := old.invoiced_changed_at;
  if new.invoiced is distinct from old.invoiced then
    if invoices.app_entry_delivered(old.id) then perform core.fail('ENTRY_LOCKED', 409, jsonb_build_object('id', old.id)); end if;
    new.invoiced_changed_by := v_actor; new.invoiced_changed_at := now();
    -- Volver a facturar borra el motivo de no facturar, salvo que llegue uno nuevo.
    if new.invoiced and new.invoiced_reason is not distinct from old.invoiced_reason then new.invoiced_reason := null; end if;
  end if;
  return new;
end $$;
create trigger app_entries_guard before insert or update on invoices.app_entries for each row execute function invoices.guard_app_entry();

-- ---------------------------------------------------------------------------
-- invoices.record_app_entry
-- ---------------------------------------------------------------------------
create or replace function invoices.app_entry_int(a jsonb, k text, p_default bigint default null)
returns bigint language plpgsql immutable as $$
begin
  if a->k is null or jsonb_typeof(a->k) = 'null' then
    if p_default is null then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', k, 'reason', 'required')); end if;
    return p_default;
  end if;
  if jsonb_typeof(a->k) <> 'number' or (a->>k) !~ '^-?[0-9]{1,13}$' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', k, 'reason', 'integer cents')); end if;
  return (a->>k)::bigint;
end $$;

create or replace function invoices.record_app_entry(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := btrim(coalesce(a->>'source_app', ''));
  v_ref text := btrim(coalesce(a->>'source_ref', ''));
  v_kind text := a->>'kind';
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
  begin v_date := (a->>'entry_date')::date; exception when others then v_date := null; end;
  if v_date is null or (a->>'entry_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'entry_date')); end if;
  if length(v_desc) not between 1 and 300 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'description')); end if;
  v_amount := invoices.app_entry_int(a, 'amount_cents');
  v_pending := invoices.app_entry_int(a, 'pending_refunds_cents', 0);
  if v_pending < 0 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'pending_refunds_cents')); end if;
  if case when jsonb_typeof(a->'tax_rate') = 'number' then (a->>'tax_rate')::numeric not between 0 and 100 else true end then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'tax_rate')); end if;
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
  v_fields := jsonb_build_object('source_app', v_app, 'source_ref', v_ref, 'kind', v_kind, 'entry_date', v_date, 'description', v_desc,
    'amount_cents', v_amount, 'tax_rate', v_rate, 'tax_cents', v_tax, 'net_cents', v_net, 'pending_refunds_cents', v_pending,
    'methods', v_methods, 'detail', v_detail,
    -- El evento enlazado a mano en Finance se queda si la otra app no manda uno.
    'event_id', coalesce(v_event, e.event_id));
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
  return jsonb_build_object('entry_id', e.id, 'status', v_status, 'revision', e.revision, 'invoiced', e.invoiced, 'tax_cents', e.tax_cents, 'net_cents', e.net_cents);
end $$;
select core.allow_procedure('invoices', 'invoices.record_app_entry');

-- ---------------------------------------------------------------------------
-- Resumen fiscal y entrega a la gestoría
-- ---------------------------------------------------------------------------
-- Totales en euros, con la forma de `issued_summary_for`: ingresos facturados como IVA repercutido por tipo; gastos
-- facturados aparte (sin factura de proveedor no hay IVA soportado deducible: pregunta en PETICIONES.md); los no
-- facturados, fuera de la cuenta pero contados.
create or replace function invoices.app_entries_summary_for(p_from date, p_to date)
returns jsonb language sql stable as $$
  with live as (select * from invoices.app_entries where deleted_at is null and entry_date between p_from and p_to),
  inc as (select * from live where invoiced and kind = 'income'),
  exp as (select * from live where invoiced and kind = 'expense')
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
    'not_invoiced', (select jsonb_build_object('count', count(*), 'income', coalesce(sum(amount_cents) filter (where kind = 'income'), 0) / 100.0,
      'expense', coalesce(sum(amount_cents) filter (where kind = 'expense'), 0) / 100.0) from live where not invoiced));
$$;

create or replace function invoices.app_entries_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_range jsonb := invoices.range_of(coalesce(p->'args', '{}'::jsonb));
begin
  return jsonb_build_object('range', v_range) || invoices.app_entries_summary_for((v_range->>'from')::date, (v_range->>'to')::date);
end $$;
select core.allow_read('invoices', 'invoices.app_entries_summary', 'function');

-- Lo que va a la gestoría: los facturados del periodo, uno a uno (sin notas ni motivo).
create or replace function invoices.app_entries_manifest(p_from date, p_to date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'revision', x.revision, 'source_app', x.source_app, 'source_ref', x.source_ref, 'kind', x.kind, 'entry_date', x.entry_date,
      'description', x.description, 'tax_rate', x.tax_rate, 'base', x.net_cents / 100.0, 'quota', x.tax_cents / 100.0, 'total', x.amount_cents / 100.0,
      'pending_refunds', x.pending_refunds_cents / 100.0,
      'methods', (select coalesce(jsonb_object_agg(k, (v #>> '{}')::numeric / 100), '{}'::jsonb) from jsonb_each(x.methods) m(k, v)),
      'event_id', x.event_id) order by x.entry_date, x.source_app, x.source_ref), '[]'::jsonb)
  from invoices.app_entries x where x.deleted_at is null and x.invoiced and x.entry_date between p_from and p_to;
$$;

-- El manifest de 0206 más los apuntes de apps (`app_entry_count`, `app_entries_totals`, `app_entries`).
create or replace function invoices.export_manifest_v2(p_from date, p_to date, p_kind text, p_year int, p_quarter int, p_folder text)
returns jsonb language sql stable as $$
  with issued as (select invoices.issued_manifest(p_from, p_to) list), entries as (select invoices.app_entries_manifest(p_from, p_to) list)
  select invoices.export_manifest(p_from, p_to, p_kind, p_year, p_quarter, p_folder)
    || jsonb_build_object(
      'issued_count', (select count(*) from issued, jsonb_array_elements(issued.list) x where x->>'status' = 'registrada'),
      'issued_file_count', (select count(*) from issued, jsonb_array_elements(issued.list) x, jsonb_array_elements(x->'files') f),
      'issued_totals', invoices.issued_summary_for(p_from, p_to),
      'issued', (select list from issued),
      'app_entry_count', (select jsonb_array_length(list) from entries),
      'app_entries_totals', invoices.app_entries_summary_for(p_from, p_to),
      'app_entries', (select list from entries));
$$;

-- create_export (de 0206): tampoco está vacía si hay apuntes facturados.
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
  -- Una entrega sin recibidas vale si hay emitidas registradas o apuntes de apps facturados en el periodo.
  if v_count = 0 and coalesce((v_manifest->>'issued_count')::int, 0) = 0 and coalesce((v_manifest->>'app_entry_count')::int, 0) = 0 then
    perform core.fail('EXPORT_EMPTY', 422, jsonb_build_object('from', v_from, 'to', v_to));
  end if;
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
  return jsonb_build_object('export_id', v_id, 'code', v_row->>'code', 'folder_name', v_folder, 'invoice_count', v_count, 'issued_count', coalesce((v_manifest->>'issued_count')::int, 0),
    'app_entry_count', coalesce((v_manifest->>'app_entry_count')::int, 0), 'manifest_sha256', v_sha,
    'warnings', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v_manifest->'excluded') x));
end $$;

-- Vista previa (de 0206) con los apuntes de apps.
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
      from jsonb_array_elements(v_manifest->'issued') x),
    'app_entry_count', v_manifest->'app_entry_count', 'app_entries_totals', v_manifest->'app_entries_totals',
    'app_entries', (select coalesce(jsonb_agg(jsonb_build_object('id', x->'id', 'source_app', x->'source_app', 'kind', x->'kind', 'entry_date', x->'entry_date', 'description', x->'description', 'total', x->'total')), '[]'::jsonb)
      from jsonb_array_elements(v_manifest->'app_entries') x));
end $$;

-- export_bundle (de 0231): también desfasada si cambió un apunte incluido o hay apuntes facturados nuevos del periodo
-- (solo en las entregas que ya llevan apuntes; las anteriores a esta migración no los tenían).
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
                where ae.revision <> (x->>'revision')::bigint or not ae.invoiced)
        or exists (select 1 from invoices.app_entries ae where ae.deleted_at is null and ae.invoiced and ae.entry_date between e.from_date and e.to_date
                   and not exists (select 1 from jsonb_array_elements(e.manifest->'app_entries') x where (x->>'id')::uuid = ae.id)))));
end $$;

revoke all on function invoices.app_entry_delivered(uuid), invoices.guard_app_entry(), invoices.app_entry_int(jsonb, text, bigint), invoices.record_app_entry(jsonb),
  invoices.app_entries_summary_for(date, date), invoices.app_entries_summary(jsonb), invoices.app_entries_manifest(date, date),
  invoices.export_manifest_v2(date, date, text, int, int, text), invoices.create_export(jsonb), invoices.export_preview(jsonb), invoices.export_bundle(jsonb)
  from public, anon, authenticated;
