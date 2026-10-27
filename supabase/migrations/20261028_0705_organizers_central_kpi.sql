-- Organizers · indicadores para el panel de Dirección de Central (P7 de Central, encargo de Core del 27-10-2026; contrato en
-- docs/central/API.md §7.2; claves y fórmulas en docs/organizers/API.md §22). Solo agregados: ningún nombre ni contacto.
-- Toca solo el schema organizers. Lee, como agregados:
--   - `booking.guests_kpi_projection` (0496): reservas confirmadas o en ejecución con sus fechas;
--   - `core.portal_links`: si quien organiza tiene acceso (un enlace de Organizers sin revocar para esa reserva);
--   - `core.feedback_reports`: los comentarios de asistentes que van a quien organiza (destino `organizer`) y los informes
--     enviados desde Organizers.
-- Los pagos pendientes de quien organiza son de Finance: no salen aquí (petición F4 en docs/organizers/PETICIONES.md).
-- `period = 'actual'`, hora de Madrid.

create view organizers.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
upcoming as (
  select r.reservation_id,
         exists (select 1 from core.portal_links l
                  where l.app = 'organizers' and l.revoked_at is null and l.scope->>'reservation_id' = r.reservation_id::text) as with_organizer
    from booking.guests_kpi_projection r, today
   where r.start_date between today.d and today.d + 30),
comments as (
  select f.status from core.feedback_reports f
   where f.origin_app = 'guests' and f.subject = 'event' and f.destination = 'organizer' and f.created_at >= now() - interval '30 days'),
reports as (
  select 1 from core.feedback_reports f where f.origin_app = 'organizers' and f.created_at >= now() - interval '30 days')
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, k.period_start, k.period_end, k.direction, k.link, now() as computed_at
  from today, lateral (values
    -- Retiros confirmados que empiezan en los próximos 30 días y en los que quien organiza ya tiene acceso al portal.
    ('organizers.retreats_next_30d', 'Retiros próximos con quien organiza dentro',
      (select count(*) from upcoming where with_organizer)::numeric, 'count', today.d, today.d + 30, 'up', 'https://booking.ikisai.com/#/reservas'),
    -- Los mismos, sin ningún enlace de Organizers vivo: Dirección puede pedir que se lo envíen.
    ('organizers.retreats_without_access', 'Retiros próximos sin acceso de quien organiza',
      (select count(*) from upcoming where not with_organizer)::numeric, 'count', today.d, today.d + 30, 'down', 'https://booking.ikisai.com/#/reservas'),
    -- Comentarios de asistentes sobre su retiro (Guests → quien organiza) de los últimos 30 días que siguen abiertos.
    ('organizers.guest_comments_open_30d', 'Comentarios de asistentes abiertos (30 días)',
      (select count(*) from comments where status = 'open')::numeric, 'count', today.d - 30, today.d, 'down', null),
    -- Informes (fallos, ideas y propuestas) que quien organiza ha enviado desde Organizers en los últimos 30 días.
    ('organizers.reports_sent_30d', 'Informes enviados desde Organizers (30 días)',
      (select count(*) from reports)::numeric, 'count', today.d - 30, today.d, null, null)
  ) as k(kpi, label, value, unit, period_start, period_end, direction, link);

revoke all on organizers.central_kpi_projection from public, anon, authenticated;
grant select on organizers.central_kpi_projection to service_role;
select core.allow_read('central', 'organizers.central_kpi_projection', 'view');
