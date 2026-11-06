-- Finance · la factura con NIF pedida sobre un ticket es una F3, sustitutiva de simplificadas (decisión de VG del 06-11,
-- F-P3 b del triaje del 05-11). Cambia lo que dejó la 0263. Toca solo el schema invoices.
--
-- - «Pedir factura» (`entry_invoice_request`) crea un borrador F3 que referencia el ticket (`rectified`: serie TICKET, su
--   número y su fecha). Al emitirla, el ticket queda anulado solo: un único importe ante Verifactu y la gestoría.
-- - El IVA lo cuenta la F3 y no el ticket: se quita la exclusión de la 0263 en el resumen de emitidas y en los KPIs, y los
--   apuntes sustituidos por una F3 emitida (`app_entry_replaced`) salen del resumen, de la entrega y del KPI del IVA.
-- - El dinero no cambia: lo cobrado y el arqueo siguen con el apunte (la F3 nace cobrada y no suma en lo cobrado).
-- - Si el ticket ya se entregó a la gestoría, no se pide (409 ENTRY_DELIVERED) ni se emite la F3.

-- ¿Lo sustituye una F3 ya emitida?
create or replace function invoices.app_entry_replaced(p_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from invoices.issued_invoices i where i.from_entry_id = p_id and i.invoice_type = 'F3' and i.deleted_at is null
                   and i.status in ('emitida', 'rectificada'));
$$;

-- No se emite una F3 sobre un ticket ya entregado a la gestoría (el periodo está cerrado allí).
create or replace function invoices.guard_entry_invoice_issue()
returns trigger language plpgsql as $$
begin
  if old.status = 'borrador' and new.status <> 'borrador' and new.from_entry_id is not null and new.invoice_type = 'F3'
     and invoices.app_entry_delivered(new.from_entry_id) then
    perform core.fail('ENTRY_DELIVERED', 409, jsonb_build_object('id', new.id, 'entry_id', new.from_entry_id));
  end if;
  return new;
end $$;
create trigger issued_invoices_entry_delivered before update on invoices.issued_invoices for each row execute function invoices.guard_entry_invoice_issue();

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
  -- La F3 anula el ticket en el IVA: si el ticket ya se entregó a la gestoría, no se puede sustituir desde aquí.
  if invoices.app_entry_delivered(e.id) then perform core.fail('ENTRY_DELIVERED', 409, jsonb_build_object('source', v_source)); end if;
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
    'series_code', s.code, 'status', 'borrador', 'invoice_type', 'F3',
    'rectified', jsonb_build_array(jsonb_build_object('series', 'TICKET', 'number', coalesce(e.receipt_number, upper(left(e.id::text, 8))),
      'issue_date', e.entry_date, 'entry_id', e.id, 'source_ref', e.source_ref)), 'issue_date', (now() at time zone 'Europe/Madrid')::date, 'operation_date', e.entry_date,
    'recipient_name', v_name, 'recipient_tax_id', v_tax, 'recipient_id_type', v_type, 'recipient_country', v_country,
    'recipient_kind', v_kind, 'recipient_address', v_addr, 'prices_include_vat', true,
    'description', left(e.description, 500), 'currency', 'EUR',
    'income_category', case when v_source like 'booking:stay:%' then 'alojamiento' else 'otros' end,
    'base_total', v_base, 'quota_total', v_quota, 'total', v_total,
    'payment_status', 'cobrada', 'paid_at', e.entry_date, 'payment_method', coalesce(v_method, 'otro'),
    'from_entry_id', e.id,
    'notes', format('Pedida desde %s. Sustituye y anula el ticket %s del %s.', initcap(v_app), coalesce(e.receipt_number, upper(left(e.id::text, 8))), to_char(e.entry_date, 'DD-MM-YYYY'))))) || v_ops;
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

-- Resumen de emitidas: todas cuentan, también la F3 de un ticket.
create or replace function invoices.issued_summary_for(p_from date, p_to date, p_only uuid[] default null)
returns jsonb language sql stable as $$
  with live as (
    select i.* from invoices.issued_invoices i where i.deleted_at is null and i.status <> 'borrador'
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

-- Apuntes (de 0245): sin los tickets sustituidos por una F3 emitida.
create or replace function invoices.app_entries_summary_for(p_from date, p_to date)
returns jsonb language sql stable as $$
  with all_live as (select * from invoices.app_entries where deleted_at is null and entry_date between p_from and p_to),
  live as (select * from all_live where nature = 'fiscal' and not invoices.app_entry_replaced(id)),
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

create or replace function invoices.app_entries_manifest(p_from date, p_to date)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'revision', x.revision, 'source_app', x.source_app, 'source_ref', x.source_ref, 'kind', x.kind, 'entry_date', x.entry_date,
      'description', x.description, 'tax_rate', x.tax_rate, 'base', x.net_cents / 100.0, 'quota', x.tax_cents / 100.0, 'total', x.amount_cents / 100.0,
      'pending_refunds', x.pending_refunds_cents / 100.0,
      'methods', (select coalesce(jsonb_object_agg(k, (v #>> '{}')::numeric / 100), '{}'::jsonb) from jsonb_each(x.methods) m(k, v)),
      'event_id', x.event_id) order by x.entry_date, x.source_app, x.source_ref), '[]'::jsonb)
  from invoices.app_entries x where x.deleted_at is null and x.nature = 'fiscal' and not invoices.app_entry_replaced(x.id) and x.entry_date between p_from and p_to;
$$;

-- KPIs (vista de 0263, mismas 36 filas): la F3 cuenta en lo facturado y en el IVA; el ticket que sustituye, no.
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
  select status, base_total, issue_date from invoices.issued_invoices where deleted_at is null
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
-- IVA repercutido: todas las emitidas, también la F3 que sustituye un ticket (el ticket ya no cuenta, `replaced`)
issued_vat as (
  select quota_total, issue_date from invoices.issued_invoices where deleted_at is null and status not in ('anulada', 'borrador')
),
entries as (
  select kind, nature, receipt_kind, entry_date, amount_cents, tax_cents, event_id, invoices.app_entry_replaced(id) as replaced from invoices.app_entries where deleted_at is null
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
       (((select coalesce(sum(quota_total), 0) from issued_vat i where i.issue_date between quarter.q_start and quarter.q_end)
         + (select coalesce(sum(tax_cents), 0) from entries e where e.kind = 'income' and e.nature = 'fiscal' and not e.replaced and e.entry_date between quarter.q_start and quarter.q_end) / 100.0)
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

revoke all on function invoices.app_entry_replaced(uuid), invoices.guard_entry_invoice_issue() from public, anon, authenticated;
revoke all on invoices.central_kpi_projection from public, anon, authenticated;
grant select on invoices.central_kpi_projection to service_role;
select core.allow_read('central', 'invoices.central_kpi_projection', 'view');
