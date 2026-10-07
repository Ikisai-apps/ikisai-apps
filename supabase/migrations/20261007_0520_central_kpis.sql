-- Ikisai Central · dirección (C01), primer paso: objetivos y umbrales de los KPIs, y los KPIs de la propia Central
-- publicados con el contrato común de proyección (docs/central/API.md §7.2). Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- Objetivos y umbrales (C01 «indicadores.objetivo_referencia»). El estado ok | atencion | critico se calcula al leer.
-- ---------------------------------------------------------------------------
create table central.kpi_targets (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  kpi text not null check (kpi ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$' and length(kpi) <= 80),
  period text not null default '*' check (period ~ '^(\*|\d{4}|\d{4}-\d{2}|\d{4}T[1-4])$'),
  target numeric,
  warn_at numeric,
  critical_at numeric,
  direction text not null default 'up' check (direction in ('up','down')),
  notes text check (notes is null or length(notes) <= 300)
);
create unique index kpi_targets_key_idx on central.kpi_targets (kpi, period) where deleted_at is null;

select core.register_table('central', 'central', 'kpi_targets', array['kpi','period','target','warn_at','critical_at','direction','notes'],
  '{reader,editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- KPIs de Central con el contrato común (API.md §7.2). Solo agregados: ningún nombre ni dato de una persona.
-- `period = 'actual'`: la foto de hoy (hora de Madrid).
-- ---------------------------------------------------------------------------
create view central.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
req as (
  select r.*, (r.expires_on < t.d) as overdue, (r.expires_on between t.d and t.d + r.notice_days) as soon
    from central.requirements r, today t
   where r.deleted_at is null and r.status not in ('no_aplica','cerrado')),
docs as (
  select d.*, (d.expires_on < t.d) as overdue from central.key_documents d, today t
   where d.deleted_at is null and d.status <> 'sustituido'),
recs as (
  select x.*, (x.expires_on < t.d) as overdue from central.person_records x join central.people p on p.id = x.person_id and p.deleted_at is null, today t
   where x.deleted_at is null and x.status <> 'no_aplica')
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, k.link, now() as computed_at
  from (values
    ('central.legal_overdue', 'Obligaciones vencidas', (select count(*) from req where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.legal_due_soon', 'Obligaciones que vencen pronto', (select count(*) from req where soon)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.blocking_overdue', 'Vencidas que bloquean la operación', (select count(*) from req where overdue and blocks_operation)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.risks_high_open', 'Riesgos alto o crítico abiertos', (select count(*) from req where risk in ('alto','critico') and status in ('pendiente','en_revision','bloqueado'))::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento/requisitos'),
    ('central.documents_expired', 'Documentos clave caducados', (select count(*) from docs where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento/documentos'),
    ('central.people_active', 'Personas activas', (select count(*) from central.people where deleted_at is null and active)::numeric, 'count', null, 'https://central.ikisai.com/#/personas'),
    ('central.people_records_expired', 'Documentación de personas caducada', (select count(*) from recs where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas')
  ) as k(kpi, label, value, unit, direction, link);

revoke all on central.central_kpi_projection from public, anon, authenticated;
grant select on central.central_kpi_projection to service_role;
select core.allow_read('central', 'central.central_kpi_projection', 'view');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
