-- Finance · indicadores nuevos para Dirección V2 (P7 de Central, 27-10). Toca solo el schema invoices.
--
-- La misma vista de 0211 (contrato docs/central/API.md §7.2, solo agregados), con seis claves más: cobrado hoy, cobrado
-- en el evento de hoy, pendiente de cobro (importe y número), facturas recibidas sin asignar e IVA del trimestre en curso.
-- Fórmulas en docs/invoices/API.md §7.6. «Apuntes por reenviar» no es de Finance: lo saben Booking y Flow (lo que
-- cambió después de enviarse), y lo publican ellas. 29 + 6 = 35 filas.

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
   where deleted_at is null and status not in ('anulada', 'borrador')
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
  from quarter;

revoke all on invoices.central_kpi_projection from public, anon, authenticated;
grant select on invoices.central_kpi_projection to service_role;
select core.allow_read('central', 'invoices.central_kpi_projection', 'view');
