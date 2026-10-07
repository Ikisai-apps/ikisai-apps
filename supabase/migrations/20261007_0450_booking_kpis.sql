-- Ikisai Booking · indicadores para el panel de Dirección de Central (contrato en docs/central/API.md §7.2; claves y
-- fórmulas en docs/booking/API.md §18). Solo agregados; «hoy» en hora de Madrid. Toca solo el schema booking.

create view booking.central_kpi_projection as
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
  -- plazas base: camas activas no supletorias de habitaciones activas y reservables
  select coalesce(sum(b.capacity), 0)::numeric as places
    from booking.beds b join booking.spaces s on s.id = b.space_id
   where b.deleted_at is null and b.active and b.kind <> 'supletoria'
     and s.deleted_at is null and s.active and s.bookable and s.kind = 'habitacion'
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
  from months m cross join capacity c;

revoke all on booking.central_kpi_projection from public, anon, authenticated;
grant select on booking.central_kpi_projection to service_role;
select core.allow_read('central', 'booking.central_kpi_projection', 'view');
