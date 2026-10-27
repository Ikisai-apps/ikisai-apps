-- Ikisai Booking · dos indicadores más para el panel de Dirección V2 de Central (P7; Core, 27-10-2026; contrato en
-- docs/central/API.md §7.2), del alojamiento como la barra:
-- - `booking.beds_free_tonight`: plazas de cama libres esta noche (hoy en Madrid). Usa `booking.free_beds`: activas, no
--   supletorias ni de equipo, sin asignación, estancia ni retención viva;
-- - `booking.stay_requests_unpaid`: solicitudes de noches del QR pendientes de cobrar en recepción, sin las de retención
--   caducada.
-- Misma vista `booking.central_kpi_projection` (0493) con dos filas más; el resto de claves no cambia.
-- Toca solo el schema booking.

create or replace view booking.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
live as (
  -- reservas vivas que siguen en el circuito (ni canceladas, ni perdidas, ni archivadas)
  select r.* from booking.reservations r
   where r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
),
months as (
  select date_trunc('month', (select d from today) + make_interval(months => m))::date as m_start
    from generate_series(-12, 3) m
),
capacity as (
  -- plazas base: camas activas no supletorias de estancias activas y reservables (0477: de cualquier tipo)
  select coalesce(sum(b.capacity), 0)::numeric as places
    from booking.beds b join booking.spaces s on s.id = b.space_id
   where b.deleted_at is null and b.active and b.kind <> 'supletoria'
     and s.deleted_at is null and s.active and s.bookable
),
weekend as (
  -- el fin de semana que viene (noches de viernes y sábado); el sábado, el que está en curso
  select case extract(isodow from d)::int when 6 then d - 1 else d + ((12 - extract(isodow from d)::int) % 7) end as fri from today
),
nights as (
  -- personas alojadas por noche (asignaciones de reservas vivas; noches [entrada, salida))
  select gs::date as night, sum(a.persons)::numeric as persons
    from booking.room_assignments a
    join booking.events e on e.id = a.event_id and e.deleted_at is null
    join live r on r.id = e.reservation_id
    cross join lateral generate_series(coalesce(a.from_date, r.start_date), coalesce(a.to_date, r.end_date) - 1, interval '1 day') gs
   where a.deleted_at is null and coalesce(a.from_date, r.start_date) is not null and coalesce(a.to_date, r.end_date) is not null
   group by 1
)
select 'booking.reservations_confirmed_90d'::text as kpi, 'Reservas confirmadas en los próximos 90 días'::text as label,
       count(*)::numeric as value, 'count'::text as unit, 'actual'::text as period,
       (select d from today) as period_start, (select d from today) + 90 as period_end,
       'up'::text as direction, 'https://booking.ikisai.com/#/reservas'::text as link, now() as computed_at
  from live r where r.status in ('confirmada','en_ejecucion') and r.start_date between (select d from today) and (select d from today) + 90
union all
select 'booking.guests_expected_90d', 'Personas previstas en los próximos 90 días',
       coalesce(sum(coalesce(e.final_guests, r.expected_guests)), 0)::numeric, 'persons', 'actual',
       (select d from today), (select d from today) + 90, 'up', 'https://booking.ikisai.com/#/reservas', now()
  from live r left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
 where r.status in ('confirmada','en_ejecucion') and r.start_date between (select d from today) and (select d from today) + 90
union all
select 'booking.events_next_30d', 'Eventos en los próximos 30 días',
       count(*)::numeric, 'count', 'actual', (select d from today), (select d from today) + 30, 'up',
       'https://booking.ikisai.com/#/calendario', now()
  from booking.events e join live r on r.id = e.reservation_id
 where e.deleted_at is null and r.start_date between (select d from today) and (select d from today) + 30
union all
select 'booking.deposits_pending', 'Reservas confirmadas con la señal sin cobrar',
       count(*)::numeric, 'count', 'actual', (select d from today), (select d from today), 'down',
       'https://booking.ikisai.com/#/reservas', now()
  from live r join booking.reservation_finance f on f.id = r.id and f.deleted_at is null
 where r.status in ('pre_reservada','confirmada') and coalesce(f.deposit_required, 0) > 0 and coalesce(f.deposit_paid, 0) < f.deposit_required
union all
select 'booking.staff_needs_open', 'Refuerzos de personal sin cubrir',
       count(*)::numeric, 'count', 'actual', (select d from today), (select d from today), 'down',
       'https://booking.ikisai.com/#/reservas', now()
  from booking.staff_needs n join booking.events e on e.id = n.event_id and e.deleted_at is null join live r on r.id = e.reservation_id
 where n.deleted_at is null and n.status <> 'cubierto' and coalesce(r.end_date, r.start_date, (select d from today)) >= (select d from today)
union all
select 'booking.occupancy_rate', 'Ocupación de plazas de alojamiento',
       case when c.places = 0 then null
            else round(100 * coalesce((select sum(n.persons) from nights n where n.night >= m.m_start and n.night < (m.m_start + interval '1 month')::date), 0)
                       / (c.places * ((m.m_start + interval '1 month')::date - m.m_start)), 1) end,
       'pct', to_char(m.m_start, 'YYYY-MM'), m.m_start, ((m.m_start + interval '1 month')::date - 1), 'up',
       'https://booking.ikisai.com/#/calendario', now()
  from months m cross join capacity c
union all
select 'booking.occupancy_weekend', 'Ocupación del fin de semana',
       case when c.places = 0 then null
            else round(100 * coalesce((select sum(n.persons) from nights n where n.night in (w.fri, w.fri + 1)), 0) / (c.places * 2), 1) end,
       'pct', 'actual', w.fri, w.fri + 2, 'up', 'https://booking.ikisai.com/#/calendario', now()
  from weekend w cross join capacity c
union all
select 'booking.beds_free_tonight', 'Camas libres esta noche',
       coalesce((select sum(f.places) from booking.free_beds((select d from today), (select d from today) + 1) f), 0)::numeric,
       'count', 'actual', (select d from today), (select d from today) + 1, 'up', 'https://booking.ikisai.com/#/recepcion', now()
union all
select 'booking.stay_requests_unpaid', 'Solicitudes de noches por pagar',
       count(*)::numeric, 'count', 'actual', (select d from today), (select d from today), 'down', 'https://booking.ikisai.com/#/recepcion', now()
  from booking.visitor_requests q
 where q.kind = 'stay' and q.status = 'pendiente' and q.deleted_at is null
   and (q.pay_mode <> 'hold' or q.hold_until > now());

revoke all on booking.central_kpi_projection from public, anon, authenticated;
grant select on booking.central_kpi_projection to service_role;
