-- Ikisai Central · R7 (tabla «hoy / después» aprobada el 18-10-2026): 12 indicadores nuevos de personas y oficios en
-- `central.central_kpi_projection`. Las 7 claves de la 0520 no cambian ni de fórmula ni de etiqueta.
-- Directorio: personas activas, no borradas ni fusionadas y con nivel de casa (el nivel efectivo de la 1506).
-- Capaz: nivel Sabe o Experto en el oficio o en uno activo que cuelga de él; cada persona cuenta una vez, con su mejor nivel.
-- Mientras nadie tenga nivel de casa (P1 sin aplicar), los nuevos valen null («—»): sin directorio no dicen nada.
-- Solo agregados. Toca solo el schema central.

create or replace view central.central_kpi_projection as
with recursive today as (select (now() at time zone 'Europe/Madrid')::date as d),
req as (
  select r.*, (r.expires_on < t.d) as overdue, (r.expires_on between t.d and t.d + r.notice_days) as soon
    from central.requirements r, today t
   where r.deleted_at is null and r.status not in ('no_aplica','cerrado')),
docs as (
  select d.*, (d.expires_on < t.d) as overdue from central.key_documents d, today t
   where d.deleted_at is null and d.status <> 'sustituido'),
recs as (
  select x.*, (x.expires_on < t.d) as overdue, (x.expires_on - t.d) as days_left
    from central.person_records x join central.people p on p.id = x.person_id and p.deleted_at is null, today t
   where x.deleted_at is null and x.status <> 'no_aplica'),
levels_on as (select exists (select 1 from central.people p where p.deleted_at is null and p.house_level is not null) as on_),
dir as (
  select p.id, p.house_level, p.user_id from central.people p
   where p.active and p.deleted_at is null and p.merged_into is null and p.house_level is not null),
tr as (select t.id, t.parent_id from central.trades t where t.deleted_at is null and t.active),
-- Cada oficio activo con sus antepasados activos: lo que sabe hacer alguien en «ACS» cuenta también para «Fontanería».
anc (trade_id, ancestor_id) as (
  select id, id from tr
  union all
  select a.trade_id, t.parent_id from anc a join tr t on t.id = a.ancestor_id join tr up on up.id = t.parent_id),
caps as (
  select x.person_id, x.trade_id, x.level from central.person_trades x
    join dir d on d.id = x.person_id join tr t on t.id = x.trade_id
   where x.deleted_at is null),
cov as (select a.ancestor_id as trade_id, c.person_id, max(c.level) as level from caps c join anc a on a.trade_id = c.trade_id group by 1, 2),
tstat as (
  select t.id,
         count(*) filter (where cov.level >= 1) as capable,
         count(*) filter (where cov.level >= 1 and d.house_level <> 'outsider') as capable_house,
         count(*) filter (where cov.level = 0) as learners,
         count(*) filter (where cov.level = 2) as experts
    from tr t left join cov on cov.trade_id = t.id left join dir d on d.id = cov.person_id
   group by t.id),
lv as (select (select on_ from levels_on) as on_)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, k.link, now() as computed_at
  from (values
    ('central.legal_overdue', 'Obligaciones vencidas', (select count(*) from req where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.legal_due_soon', 'Obligaciones que vencen pronto', (select count(*) from req where soon)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.blocking_overdue', 'Vencidas que bloquean la operación', (select count(*) from req where overdue and blocks_operation)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento'),
    ('central.risks_high_open', 'Riesgos alto o crítico abiertos', (select count(*) from req where risk in ('alto','critico') and status in ('pendiente','en_revision','bloqueado'))::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento/requisitos'),
    ('central.documents_expired', 'Documentos clave caducados', (select count(*) from docs where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/cumplimiento/documentos'),
    ('central.people_active', 'Personas activas', (select count(*) from central.people where deleted_at is null and active)::numeric, 'count', null, 'https://central.ikisai.com/#/personas'),
    ('central.people_records_expired', 'Documentación de personas caducada', (select count(*) from recs where overdue)::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    -- R7 · personas
    ('central.people_direction_staff', 'Dirección y staff', case when (select on_ from lv) then (select count(*) from dir where house_level in ('direccion','staff')) end::numeric, 'count', null, 'https://central.ikisai.com/#/personas'),
    ('central.people_outsiders', 'Outsiders', case when (select on_ from lv) then (select count(*) from dir where house_level = 'outsider') end::numeric, 'count', null, 'https://central.ikisai.com/#/personas'),
    ('central.people_without_level', 'Activas sin nivel de casa', case when (select on_ from lv) then (select count(*) from central.people where active and deleted_at is null and merged_into is null and house_level is null) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    ('central.outsiders_without_account', 'Outsiders sin cuenta', case when (select on_ from lv) then (select count(*) from dir where house_level = 'outsider' and user_id is null) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    ('central.people_records_due_30d', 'Documentación de personas que caduca en 30 días', (select count(*) from recs where days_left between 0 and 30)::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    ('central.people_records_due_90d', 'Documentación de personas que caduca en 90 días', (select count(*) from recs where days_left between 0 and 90)::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    -- R7 · oficios
    ('central.trades_at_risk', 'Oficios con una persona capaz o ninguna', case when (select on_ from lv) then (select count(*) from tstat where capable <= 1) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas/oficios?riesgo'),
    ('central.trades_learners_no_expert', 'Oficios con aprendices y sin experto', case when (select on_ from lv) then (select count(*) from tstat where learners > 0 and experts = 0) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas/oficios'),
    ('central.trades_only_outsiders', 'Oficios que solo cubren outsiders', case when (select on_ from lv) then (select count(*) from tstat where capable > 0 and capable_house = 0) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas/oficios?riesgo'),
    ('central.people_without_trades', 'Personas del directorio sin oficios', case when (select on_ from lv) then (select count(*) from dir where not exists (select 1 from caps where caps.person_id = dir.id)) end::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas'),
    ('central.trades_per_person', 'Oficios por persona (media)', case when (select on_ from lv) then round((select count(*) from caps)::numeric / nullif((select count(*) from dir), 0), 2) end, 'count', 'up', 'https://central.ikisai.com/#/personas'),
    ('central.trades_archived_with_people', 'Oficios archivados con personas', (select count(distinct t.id) from central.trades t
       join central.person_trades x on x.trade_id = t.id and x.deleted_at is null
       join central.people p on p.id = x.person_id and p.deleted_at is null
      where t.deleted_at is null and not t.active)::numeric, 'count', 'down', 'https://central.ikisai.com/#/personas/oficios')
  ) as k(kpi, label, value, unit, direction, link);
revoke all on central.central_kpi_projection from public, anon, authenticated;
grant select on central.central_kpi_projection to service_role;
