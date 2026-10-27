-- Ikisai Booking · `public_code` en `booking.event_projection` (Core, 27-10-2026, para Flow). Flow solo puede leer esta
-- vista de Booking (lint), y necesita el código público del evento (el del QR de ven.ikisai.com, 0488) para dos cosas:
-- - enseñar «Alójate aquí» solo si `booking_public_events` marca `lodging` para ese código;
-- - que `visitor_join` encuentre la barra cuando el QR lleva el código público.
-- Es el de 0480 con la columna al final (una vista que crece por el final se puede reemplazar). El código ya va en el
-- cartel y en el QR: no es un dato personal.
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
  e.public_code
from booking.events e
join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
where e.deleted_at is null and r.status not in ('cancelada', 'perdida');

revoke all on booking.event_projection from public, anon, authenticated;
grant select on booking.event_projection to service_role;
