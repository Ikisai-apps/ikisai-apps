-- Finance · factura con NIF a petición de un cobro de otra app (vg-38; diseño en
-- MUELA/equipo/feedback/finance/FACTURA_A_PETICION_vg-38.md; API.md §17.13). Toca solo el schema invoices.
--
-- El justificante de las noches es el ticket de Finance (el apunte `booking:stay:<cobro>`). Si el huésped pide factura,
-- el servidor de Booking manda el cobro y los datos fiscales (`worker/entry-invoice`) y Finance crea un BORRADOR en
-- Emitidas que alguien revisa y emite (decisión de VG del 27-10). Booking no guarda los datos fiscales.
--
-- Nada suma dos veces: el apunte sigue siendo la venta (IVA repercutido de su periodo, cobrado, arqueo). La factura que
-- lo documenta (`from_entry_id`) nace cobrada con el medio del apunte, va en el libro de emitidas marcada
-- «sustituye al ticket», y no suma en el resumen de emitidas ni en los KPIs. Sus rectificativas tampoco.

alter table invoices.issued_invoices add column from_entry_id uuid references invoices.app_entries(id);
-- Una factura viva por apunte (las rectificativas heredan el apunte y no cuentan aquí).
create unique index issued_invoices_from_entry_uq on invoices.issued_invoices (from_entry_id)
  where from_entry_id is not null and deleted_at is null and status <> 'anulada' and invoice_type not like 'R%';

select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
  'issuer_tax_id', 'issuer_name', 'issuer',
  'recipient_address', 'recipient_kind', 'prices_include_vat',
  'issued_at', 'issued_by', 'document', 'rectified_by',
  'vf_record_kind', 'vf_hash', 'vf_previous_hash', 'vf_previous_ref', 'vf_first_record', 'vf_generated_at', 'vf_status', 'vf_csv', 'vf_errors', 'vf_qr_url', 'vf_system',
  'purpose', 'sent_at', 'payment_method', 'from_entry_id'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- `from_entry_id` solo lo pone la petición; una rectificativa lo hereda de la factura que rectifica. Nadie lo cambia.
create or replace function invoices.guard_from_entry()
returns trigger language plpgsql as $$
declare v_parent uuid;
begin
  if tg_op = 'INSERT' then
    if new.invoice_type like 'R%' then
      begin
        select i.from_entry_id into v_parent from invoices.issued_invoices i where i.id = (new.rectified->0->>'issued_invoice_id')::uuid;
      exception when others then v_parent := null; end;
      new.from_entry_id := v_parent;
    elsif new.from_entry_id is not null and coalesce(current_setting('invoices.procedure', true), '') <> 'entry_invoice_request' then
      perform core.fail('ENTRY_INVOICE_PROCEDURE_ONLY', 422, jsonb_build_object('field', 'from_entry_id'));
    end if;
    return new;
  end if;
  if new.from_entry_id is distinct from old.from_entry_id then
    perform core.fail('ENTRY_INVOICE_PROCEDURE_ONLY', 422, jsonb_build_object('field', 'from_entry_id', 'id', old.id));
  end if;
  return new;
end $$;
create trigger issued_invoices_from_entry before insert or update on invoices.issued_invoices for each row execute function invoices.guard_from_entry();

-- Peticiones (interna, sin roles): idempotencia por `id` (= request_id de la otra app). Los datos fiscales solo van en
-- el borrador.
create table invoices.entry_invoice_requests (
  id uuid primary key,
  entry_id uuid not null references invoices.app_entries(id),
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  requested_by_app text not null references core.apps(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);
create index entry_invoice_requests_entry_idx on invoices.entry_invoice_requests (entry_id, created_at desc);
select core.register_table('invoices', 'invoices', 'entry_invoice_requests', array[]::text[], '{}', '{}', true);

-- Estado para la otra app: pendiente (borrador por revisar), emitida (con su número), anulada, o descartada (el borrador
-- se borró en Finance; se puede volver a pedir).
create or replace function invoices.entry_invoice_state(p_request uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('request_id', r.id, 'issued_invoice_id', i.id,
           'status', case when i.deleted_at is not null then 'descartada' when i.status = 'borrador' then 'pendiente'
                          when i.status = 'anulada' then 'anulada' else 'emitida' end,
           'full_number', case when i.status <> 'borrador' then i.full_number end,
           'issue_date', case when i.status <> 'borrador' then i.issue_date end)
    from invoices.entry_invoice_requests r join invoices.issued_invoices i on i.id = r.issued_invoice_id where r.id = p_request;
$$;

-- request {request_id, app, source, customer: {name, tax_id, id_type, country, kind, address}} (acción de sistema, la
-- llama la Edge con `X-Ikisai-Caller`; `app` es quien llama y tiene que ser el dueño del apunte).
create or replace function invoices.entry_invoice_request(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  c jsonb := coalesce(a->'customer', '{}'::jsonb);
  v_req uuid; v_app text := btrim(coalesce(a->>'app', '')); v_source text := btrim(coalesce(a->>'source', ''));
  e invoices.app_entries; s invoices.issued_series; v_existing invoices.issued_invoices;
  v_name text := btrim(coalesce(c->>'name', '')); v_tax text := upper(regexp_replace(coalesce(c->>'tax_id', ''), '[\s./-]', '', 'g'));
  v_type text := coalesce(nullif(c->>'id_type', ''), 'NIF'); v_country text := upper(coalesce(nullif(c->>'country', ''), 'ES'));
  v_kind text := coalesce(nullif(c->>'kind', ''), 'particular'); v_addr jsonb := nullif(c->'address', 'null'::jsonb);
  v_id uuid := gen_random_uuid(); v_ops jsonb := '[]'::jsonb; v_rate numeric; v_items jsonb; d jsonb; v_pos int := 0;
  v_gross numeric; v_net numeric; v_qty numeric; v_base numeric := 0; v_quota numeric := 0; v_total numeric := 0; v_method text;
begin
  begin v_req := (a->>'request_id')::uuid; exception when others then v_req := null; end;
  if v_req is null then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'request_id')); end if;
  if exists (select 1 from invoices.entry_invoice_requests where id = v_req) then
    return invoices.entry_invoice_state(v_req) || jsonb_build_object('replayed', true);
  end if;
  if v_app = '' or left(v_source, length(v_app) + 1) <> v_app || ':' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'source')); end if;
  select * into e from invoices.app_entries where source_app = v_app and source_ref = v_source and deleted_at is null;
  if e.id is null then perform core.fail('ENTRY_NOT_FOUND', 404, jsonb_build_object('source', v_source)); end if;
  if e.kind <> 'income' or e.nature <> 'fiscal' or e.amount_cents - e.pending_refunds_cents <= 0 then
    perform core.fail('ENTRY_NOT_INVOICEABLE', 409, jsonb_build_object('source', v_source, 'kind', e.kind, 'nature', e.nature));
  end if;
  select * into v_existing from invoices.issued_invoices
   where from_entry_id = e.id and deleted_at is null and status <> 'anulada' and invoice_type not like 'R%' limit 1;
  if v_existing.id is not null then
    perform core.fail('ALREADY_REQUESTED', 409, jsonb_build_object('source', v_source, 'request_id',
      (select r.id from invoices.entry_invoice_requests r where r.issued_invoice_id = v_existing.id order by r.created_at limit 1),
      'status', case when v_existing.status = 'borrador' then 'pendiente' else 'emitida' end,
      'full_number', case when v_existing.status <> 'borrador' then v_existing.full_number end));
  end if;
  -- Destinatario
  if length(v_name) not between 1 and 200 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.name')); end if;
  if length(v_tax) not between 2 and 30 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.tax_id')); end if;
  if v_type not in ('NIF', '02', '03', '04', '05', '06') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.id_type')); end if;
  if v_country !~ '^[A-Z]{2}$' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.country')); end if;
  if v_kind not in ('particular', 'empresa') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.kind')); end if;
  if v_addr is not null and jsonb_typeof(v_addr) <> 'object' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.address')); end if;
  if v_kind = 'empresa' and (nullif(btrim(coalesce(v_addr->>'line', '')), '') is null or nullif(btrim(coalesce(v_addr->>'postal_code', '')), '') is null
      or nullif(btrim(coalesce(v_addr->>'city', '')), '') is null) then
    perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'customer.address', 'reason', 'line, postal_code and city are required for empresa'));
  end if;
  select * into s from invoices.issued_series where mode = 'emision' and kind = 'ordinaria' and active and closed_at is null and deleted_at is null order by code limit 1;
  if s.id is null then perform core.fail('SERIES_MISSING', 422, jsonb_build_object('kind', 'ordinaria')); end if;
  -- Líneas: lo vendido (sin las devoluciones pendientes), IVA incluido y cuota exacta por línea.
  v_rate := e.tax_rate;
  v_items := case when jsonb_array_length(e.detail) > 0 then e.detail
    else jsonb_build_array(jsonb_build_object('name', e.description, 'quantity', 1, 'amount_cents', e.amount_cents - e.pending_refunds_cents)) end;
  for d in select x from jsonb_array_elements(v_items) x loop
    v_gross := (d->>'amount_cents')::numeric / 100;
    if v_gross = 0 then continue; end if;
    v_qty := coalesce(nullif((d->>'quantity')::numeric, 0), 1);
    v_net := round(v_gross * 100 / (100 + v_rate), 2);
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'invoices.issued_invoice_lines', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'issued_invoice_id', v_id, 'position', v_pos, 'description', left(btrim(d->>'name'), 500), 'quantity', v_qty,
      'unit_price', round(v_gross * 100 / (100 + v_rate) / v_qty, 4), 'discount_amount', 0, 'net_amount', v_net,
      'tax', 'iva', 'vat_rate', v_rate, 'vat_amount', v_gross - v_net));
    v_pos := v_pos + 1; v_base := v_base + v_net; v_quota := v_quota + (v_gross - v_net); v_total := v_total + v_gross;
  end loop;
  -- Medio de cobro: el mayor del apunte.
  select case key when 'cash' then 'efectivo' when 'efectivo' then 'efectivo' when 'card' then 'tarjeta' when 'tarjeta' then 'tarjeta'
                  when 'bizum' then 'bizum' when 'transfer' then 'transferencia' when 'transferencia' then 'transferencia' else 'otro' end
    into v_method from jsonb_each_text(e.methods) order by value::bigint desc limit 1;
  v_ops := jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'invoices.issued_invoices', 'id', v_id, 'fields', jsonb_build_object(
    'series_code', s.code, 'status', 'borrador', 'invoice_type', 'F1', 'issue_date', (now() at time zone 'Europe/Madrid')::date, 'operation_date', e.entry_date,
    'recipient_name', v_name, 'recipient_tax_id', v_tax, 'recipient_id_type', v_type, 'recipient_country', v_country,
    'recipient_kind', v_kind, 'recipient_address', v_addr, 'prices_include_vat', true,
    'description', left(e.description, 500), 'currency', 'EUR',
    'income_category', case when v_source like 'booking:stay:%' then 'alojamiento' else 'otros' end,
    'base_total', v_base, 'quota_total', v_quota, 'total', v_total,
    'payment_status', 'cobrada', 'paid_at', e.entry_date, 'payment_method', coalesce(v_method, 'otro'),
    'from_entry_id', e.id,
    'notes', format('Pedida desde %s (sustituye al ticket del %s).', initcap(v_app), to_char(e.entry_date, 'DD-MM-YYYY'))))) || v_ops;
  perform set_config('invoices.procedure', 'entry_invoice_request', true);
  perform core.apply_system_operations('invoices', v_ops);
  perform set_config('invoices.procedure', '', true);
  insert into invoices.entry_invoice_requests (id, entry_id, issued_invoice_id, requested_by_app) values (v_req, e.id, v_id, v_app);
  return invoices.entry_invoice_state(v_req);
end $$;

-- of {app, source}: la última petición del apunte, o null.
create or replace function invoices.entry_invoice_of(p jsonb)
returns jsonb language sql stable as $$
  select invoices.entry_invoice_state(r.id)
    from invoices.entry_invoice_requests r join invoices.app_entries e on e.id = r.entry_id
   where e.source_app = p->'args'->>'app' and e.source_ref = p->'args'->>'source' and e.deleted_at is null
   order by r.created_at desc limit 1;
$$;

select core.allow_read('invoices', 'invoices.entry_invoice_request', 'action', '{}');
select core.allow_read('invoices', 'invoices.entry_invoice_of', 'action', '{}');
revoke all on function invoices.entry_invoice_request(jsonb), invoices.entry_invoice_of(jsonb), invoices.entry_invoice_state(uuid),
  invoices.guard_from_entry() from public, anon, authenticated;

-- Resumen de emitidas (de 0212): sin las facturas de un apunte, que ya cuenta el apunte.
create or replace function invoices.issued_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.issued_invoices i where i.deleted_at is null and i.status <> 'borrador' and i.from_entry_id is null
      and i.issue_date between p_from and p_to and (p_only is null or i.id = any (p_only))),
  summed as (select * from live where status in ('registrada', 'emitida', 'rectificada')),
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

-- Libro de emitidas de la entrega (de 0212): las de un apunte van, con `replaces_entry` (el ticket y su fecha) para la
-- gestoría. Las demás quedan exactamente igual que antes.
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
    ) || case when i.from_entry_id is null then '{}'::jsonb else jsonb_build_object('replaces_entry',
      (select jsonb_build_object('id', e.id, 'source_ref', e.source_ref, 'entry_date', e.entry_date, 'receipt_number', e.receipt_number)
         from invoices.app_entries e where e.id = i.from_entry_id)) end
    order by i.issue_date, i.full_number), '[]'::jsonb)
  from invoices.issued_invoices i where i.deleted_at is null and i.status <> 'borrador' and i.issue_date between p_from and p_to;
$$;

-- KPIs (vista de 0254, mismas 36 filas): lo facturado, lo cobrado y lo pendiente, sin las facturas de un apunte.
create or replace view invoices.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
months as (
  select m::date as m_start, (m + interval '1 month' - interval '1 day')::date as m_end
    from today, generate_series(date_trunc('month', today.d) - interval '12 months', date_trunc('month', today.d), interval '1 month') as m
),
received as (
  select status, payment_status, calculated_total, invoice_date from invoices.invoices where deleted_at is null
),
issued as (
  select status, base_total, issue_date from invoices.issued_invoices where deleted_at is null and from_entry_id is null
),
quarter as (
  select date_trunc('quarter', today.d)::date as q_start, (date_trunc('quarter', today.d) + interval '3 months' - interval '1 day')::date as q_end,
         to_char(today.d, 'YYYY') || 'T' || extract(quarter from today.d)::int as q_label
    from today
),
issued_all as (
  select status, total, quota_total, issue_date, payment_status, paid_at from invoices.issued_invoices
   where deleted_at is null and from_entry_id is null and status not in ('anulada', 'borrador')
),
entries as (
  select kind, nature, receipt_kind, entry_date, amount_cents, tax_cents, event_id from invoices.app_entries where deleted_at is null
)
-- Recibidas pendientes de datos o de revisión
select 'invoices.pending_review'::text as kpi, 'Facturas recibidas por revisar'::text as label,
       (select count(*) from received where status in ('pendiente_datos', 'pendiente_revision'))::numeric as value,
       'count'::text as unit, 'actual'::text as period, today.d as period_start, today.d as period_end,
       'down'::text as direction, 'https://finance.ikisai.com/#/facturas'::text as link, now() as computed_at
  from today
union all
-- Recibidas sin pagar (no anuladas)
select 'invoices.unpaid', 'Facturas recibidas sin pagar',
       (select count(*) from received where status <> 'anulada' and payment_status = 'pendiente')::numeric,
       'count', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/facturas', now()
  from today
union all
select 'invoices.unpaid_amount', 'Importe recibido sin pagar',
       (select coalesce(sum(calculated_total), 0) from received where status <> 'anulada' and payment_status = 'pendiente')::numeric,
       'eur', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/facturas', now()
  from today
union all
-- Gasto del mes: total (IVA incluido) de las recibidas validadas o archivadas, por fecha de factura
select 'invoices.expenses_month', 'Gasto del mes (facturas validadas)',
       (select coalesce(sum(calculated_total), 0) from received r where r.status in ('validada', 'archivada') and r.invoice_date between months.m_start and months.m_end)::numeric,
       'eur', to_char(months.m_start, 'YYYY-MM'), months.m_start, months.m_end, 'down', 'https://finance.ikisai.com/#/gestoria', now()
  from months
union all
-- Ingreso facturado del mes: base imponible de las emitidas no anuladas (ni borradores), por fecha de expedición
select 'invoices.income_issued_month', 'Ingresos facturados del mes (base)',
       (select coalesce(sum(base_total), 0) from issued i where i.status not in ('anulada', 'borrador') and i.issue_date between months.m_start and months.m_end)::numeric,
       'eur', to_char(months.m_start, 'YYYY-MM'), months.m_start, months.m_end, 'up', 'https://finance.ikisai.com/#/facturas?vista=emitidas', now()
  from months
union all
-- Cobrado hoy (IVA incluido): ingresos de apps del día (barra, alojamiento de recepción) y emitidas cobradas hoy
select 'invoices.collected_today', 'Cobrado hoy',
       ((select coalesce(sum(amount_cents), 0) from entries e where e.kind = 'income' and e.entry_date = today.d) / 100.0
        + (select coalesce(sum(total), 0) from issued_all i where i.payment_status = 'cobrada' and i.paid_at = today.d))::numeric,
       'eur', 'actual', today.d, today.d, 'up', 'https://finance.ikisai.com/#/apuntes', now()
  from today
union all
-- Cobrado en el evento de hoy: todo lo cobrado por apps en los eventos que hoy tienen cobros (todos sus días)
select 'invoices.collected_event_today', 'Cobrado en el evento de hoy',
       ((select coalesce(sum(amount_cents), 0) from entries e where e.kind = 'income'
          and e.event_id in (select event_id from entries x where x.kind = 'income' and x.entry_date = today.d and x.event_id is not null)) / 100.0)::numeric,
       'eur', 'actual', today.d, today.d, 'up', 'https://finance.ikisai.com/#/apuntes', now()
  from today
union all
-- Pendiente de cobro: emitidas (ni borradores ni anuladas) aún sin cobrar
select 'invoices.pending_collection', 'Pendiente de cobro (facturas emitidas)',
       (select coalesce(sum(total), 0) from issued_all where payment_status = 'pendiente')::numeric,
       'eur', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/facturas?vista=emitidas', now()
  from today
union all
select 'invoices.pending_collection_count', 'Facturas emitidas sin cobrar',
       (select count(*) from issued_all where payment_status = 'pendiente')::numeric,
       'count', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/facturas?vista=emitidas', now()
  from today
union all
-- Facturas recibidas con algo «sin asignar» (no anuladas)
select 'invoices.unassigned', 'Facturas recibidas sin asignar',
       (select count(distinct i.id) from invoices.invoices i
          join invoices.invoice_lines l on l.invoice_id = i.id and l.deleted_at is null
          join invoices.allocations a on a.invoice_line_id = l.id and a.deleted_at is null and a.target_app = 'general' and a.target_kind = 'unassigned'
         where i.deleted_at is null and i.status <> 'anulada')::numeric,
       'count', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/compras', now()
  from today
union all
-- IVA del trimestre en curso: repercutido (emitidas y cobros fiscales de apps) menos soportado (facturas validadas y gastos
-- de apps con factura). Positivo: a ingresar; negativo: a compensar. Sin sentido de umbral.
select 'invoices.vat_quarter', 'IVA del trimestre (repercutido − soportado)',
       (((select coalesce(sum(quota_total), 0) from issued_all i where i.issue_date between quarter.q_start and quarter.q_end)
         + (select coalesce(sum(tax_cents), 0) from entries e where e.kind = 'income' and e.nature = 'fiscal' and e.entry_date between quarter.q_start and quarter.q_end) / 100.0)
        - ((select coalesce(sum(calculated_vat), 0) from invoices.invoices r where r.deleted_at is null and r.status in ('validada', 'archivada') and r.receipt_kind = 'invoice'
              and r.declaration_date between quarter.q_start and quarter.q_end)
         + (select coalesce(sum(tax_cents), 0) from entries e where e.kind = 'expense' and e.nature = 'fiscal' and e.receipt_kind = 'invoice' and e.entry_date between quarter.q_start and quarter.q_end) / 100.0))::numeric,
       'eur', quarter.q_label, quarter.q_start, quarter.q_end, null::text, 'https://finance.ikisai.com/#/gestoria', now()
  from quarter
union all
-- Reservas con facturas emitidas enviadas a quien organiza y sin cobrar (F4 de Organizers). Las vencidas según el
-- calendario de pagos de la propuesta son de Booking (B15): Finance no tiene vencimientos.
select 'invoices.organizer_reservations_pending', 'Retiros con facturas enviadas sin cobrar',
       (select count(distinct a.target_id) from invoices.issued_allocations a
          join invoices.issued_invoices i on i.id = a.issued_invoice_id
         where a.deleted_at is null and a.target_app = 'booking' and a.target_kind = 'reservation'
           and i.deleted_at is null and i.status not in ('anulada', 'borrador') and i.sent_at is not null and i.payment_status = 'pendiente')::numeric,
       'count', 'actual', today.d, today.d, 'down', 'https://finance.ikisai.com/#/facturas?vista=emitidas', now()
  from today;

revoke all on invoices.central_kpi_projection from public, anon, authenticated;
grant select on invoices.central_kpi_projection to service_role;
select core.allow_read('central', 'invoices.central_kpi_projection', 'view');
