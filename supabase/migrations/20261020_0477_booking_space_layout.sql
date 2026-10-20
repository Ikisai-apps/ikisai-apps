-- Ikisai Booking · tanda 36 (MUELA-049, PR de datos; VG: «Plano y ficha» con «Monta el dormitorio» en cuadrantes):
--   `spaces.layout` = {cols, rows}: la estancia en cuadrantes (de 2 a 16 de ancho y de 2 a 40 de fondo). No son medidas
--   reales: sirven para ver y ordenar las camas.
--   `beds.cell` = {x, y, rot}: dónde está cada cama; ocupa dos cuadrantes, a lo ancho (rot 0) o a lo largo (rot 90). Las
--   dos plazas de una litera son una sola cama de 2 plazas, así que comparten celda y se asignan por separado, como hoy.
-- Las dos columnas son opcionales y no cambian nada por sí solas. Que no se salgan ni se monten lo comprueba la pantalla
-- (cambia con el tamaño); aquí, solo la forma.
-- Además, cualquier estancia con camas cuenta sus plazas (VG: «una habitación que no es dormitorio… añadir camas»): el
-- indicador de plazas de Central y las habitaciones del retiro de los portales ya no exigen `kind = 'habitacion'`.

create or replace function booking.valid_space_layout(p jsonb)
returns boolean language plpgsql immutable as $$
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'cols') <> 'number' or jsonb_typeof(p->'rows') <> 'number' then return false; end if;
  return (p->>'cols')::numeric = trunc((p->>'cols')::numeric) and (p->>'cols')::numeric between 2 and 16
     and (p->>'rows')::numeric = trunc((p->>'rows')::numeric) and (p->>'rows')::numeric between 2 and 40;
end $$;

create or replace function booking.valid_bed_cell(p jsonb)
returns boolean language plpgsql immutable as $$
begin
  if p is null then return true; end if;
  if jsonb_typeof(p) <> 'object' or jsonb_typeof(p->'x') <> 'number' or jsonb_typeof(p->'y') <> 'number' or jsonb_typeof(p->'rot') <> 'number' then return false; end if;
  return (p->>'x')::numeric = trunc((p->>'x')::numeric) and (p->>'x')::numeric between 0 and 15
     and (p->>'y')::numeric = trunc((p->>'y')::numeric) and (p->>'y')::numeric between 0 and 39
     and (p->>'rot')::numeric in (0, 90);
end $$;

alter table booking.spaces add column layout jsonb check (booking.valid_space_layout(layout));
alter table booking.beds add column cell jsonb check (booking.valid_bed_cell(cell));
select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','bookable','position','notes','public_name','en_suite','resource_id','layout']);
select core.register_table('booking', 'booking', 'beds', array['space_id','label','kind','capacity','active','position','resource_id','resource_part','cell']);

-- Habitaciones del retiro: las que el personal le ha asignado y tienen camas (o son habitaciones, como hasta ahora).
create or replace function booking.event_rooms(p_event uuid)
returns setof uuid language sql stable as $$
  select distinct a.space_id from booking.room_assignments a join booking.spaces s on s.id = a.space_id
   where a.event_id = p_event and a.deleted_at is null and s.deleted_at is null
     and (s.kind = 'habitacion' or exists (select 1 from booking.beds b where b.space_id = s.id and b.deleted_at is null));
$$;

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

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
