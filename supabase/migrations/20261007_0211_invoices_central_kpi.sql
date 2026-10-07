-- Invoices · indicadores para el panel de Dirección de Central (P7). Toca solo el schema invoices.
--
-- Contrato: docs/central/API.md §7.2. Una sola vista con las columnas del contrato; solo agregados (ningún proveedor,
-- cliente ni importe de una factura concreta). «Hoy» en hora de Madrid. Las mensuales cubren el mes en curso y los 12
-- anteriores (13 filas cada una); en total, 3 + 2 × 13 = 29 filas. Fórmulas documentadas en docs/invoices/API.md §7.5.

create view invoices.central_kpi_projection as
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
  from months;

revoke all on invoices.central_kpi_projection from public, anon, authenticated;
grant select on invoices.central_kpi_projection to service_role;
select core.allow_read('central', 'invoices.central_kpi_projection', 'view');
