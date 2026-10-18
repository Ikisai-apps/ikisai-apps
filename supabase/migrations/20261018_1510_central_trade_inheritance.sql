-- Ikisai Central · las capacidades se heredan del padre a los hijos, nunca al revés (decisión del usuario del 18-10-2026,
-- coordinacion/central/RESPUESTAS.md). Quien sabe Albañilería sabe todos sus hijos (Demolición…): el grado del padre es el
-- mínimo en los hijos; en un hijo se puede tener más, y eso no sube al padre. Hasta ahora (1507) era al revés.
-- - `central.person_trade_levels` (interna): grado efectivo de cada persona en cada oficio activo = el máximo entre lo puesto
--   en él y lo puesto en cualquiera de sus antepasados activos. Nunca mira a los descendientes. `inherited`: el grado viene de
--   un antepasado y en el oficio no hay uno igual o mayor puesto.
--   Oficio archivado en medio de la cadena: la herencia pasa a través de él (Albañilería › [archivado] › Demolición:
--   Demolición hereda de Albañilería); lo puesto en el archivado no cuenta, como hasta ahora.
-- - `central.capability_options` (Tasks, también el outsider): una fila por persona y oficio con el grado efectivo, también
--   en los hijos heredados, y `inherited` al final. Las mismas personas que antes (vivas, activas y con nivel de casa).
-- - `central.central_kpi_projection`: la cobertura de oficios (en riesgo, aprendices sin experto, solo outsiders) con el grado
--   efectivo. «Personas sin oficios» y «Oficios por persona» siguen contando lo puesto. El resto no cambia.
-- Toca solo el schema central.

create view central.person_trade_levels as
with recursive tr as (select t.id, t.parent_id, t.active from central.trades t where t.deleted_at is null),
-- Cada oficio con él mismo y todos sus antepasados (también los archivados, para pasar a través de ellos).
up (trade_id, ancestor_id, depth) as (
  select id, id, 0 from tr
  union all
  select u.trade_id, t.parent_id, u.depth + 1 from up u join tr t on t.id = u.ancestor_id where t.parent_id is not null and u.depth < 5),
src as (
  select x.person_id, u.trade_id, x.level, u.depth = 0 as own
    from central.person_trades x
    join up u on u.ancestor_id = x.trade_id
    join tr a on a.id = x.trade_id and a.active
   where x.deleted_at is null)
select s.person_id, s.trade_id, max(s.level) as level, coalesce(max(s.level) filter (where s.own), -1) < max(s.level) as inherited
  from src s join tr t on t.id = s.trade_id and t.active
 group by s.person_id, s.trade_id;

revoke all on central.person_trade_levels from public, anon, authenticated;
grant select on central.person_trade_levels to service_role;

-- Las columnas de antes, en su orden, y `inherited` al final.
create or replace view central.capability_options as
select l.person_id, l.trade_id, l.level, l.inherited
  from central.person_trade_levels l
  join central.people p on p.id = l.person_id and p.deleted_at is null and p.active and p.house_level is not null;

create or replace view central.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
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
-- Oficios puestos (sin heredar): «Personas sin oficios» y «Oficios por persona» no cambian.
caps as (
  select x.person_id, x.trade_id, x.level from central.person_trades x
    join dir d on d.id = x.person_id join tr t on t.id = x.trade_id
   where x.deleted_at is null),
-- 1510: grado efectivo; lo del padre baja a los hijos, nunca al revés.
cov as (select l.trade_id, l.person_id, l.level from central.person_trade_levels l join dir d on d.id = l.person_id),
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
