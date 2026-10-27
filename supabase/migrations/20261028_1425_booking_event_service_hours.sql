-- Ikisai Booking · horario de servicio de cada día en `booking.event_projection` (petición de Flow, vg-48, 27-10-2026). Lo
-- que pide dirección o el equipo fuera de ese horario es un pedido de prueba; dentro, cuenta.
-- - `service_hours jsonb`: `[{day, starts_at, ends_at}]`, en hora de Madrid (`HH:MM`). Por día, el primer inicio y el último
--   fin del programa (`program_items` con hora; sin fin, cuenta su inicio). Los días sin programa con hora no salen; sin
--   ninguno, `null`, y Flow usa los días `starts_on..ends_on` enteros.
-- Es la vista de la 1405 con la columna al final (una vista que crece por el final se puede reemplazar).
-- Toca solo el schema booking.

create or replace view booking.event_projection as
select
  e.id as event_id,
  e.code as event_code,
  r.title as name,
  r.event_type as kind,
  r.status,
  r.start_date as starts_on,
  r.end_date as ends_on,
  coalesce(e.final_guests, r.expected_guests) as expected_attendance,
  e.revision as event_revision,
  e.public_code,
  (select jsonb_agg(jsonb_build_object('day', d.day, 'starts_at', to_char(d.s, 'HH24:MI'), 'ends_at', to_char(d.f, 'HH24:MI')) order by d.day)
     from (select p.day, min(p.starts_at) as s, max(coalesce(p.ends_at, p.starts_at)) as f
             from booking.program_items p
            where p.event_id = e.id and p.deleted_at is null and p.starts_at is not null
            group by p.day) d) as service_hours
from booking.events e
join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
where e.deleted_at is null and r.status not in ('cancelada', 'perdida');

revoke all on booking.event_projection from public, anon, authenticated;
grant select on booking.event_projection to service_role;
