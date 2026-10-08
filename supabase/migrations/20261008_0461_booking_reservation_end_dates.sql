-- Ikisai Booking · B18 de Organizers: fecha de fin de cada reserva para su conservación (borrar las respuestas de los
-- huéspedes a los 6 meses del fin del retiro). Sin datos personales: id, fin y estado. Incluye las reservas borradas
-- (estado `borrada`), para que lo suyo también caduque. Lectura SQL desde el schema organizers (lint, #334); no es una
-- lectura de portal. Toca solo el schema booking.
create or replace view booking.reservation_end_dates as
select r.id as reservation_id, r.end_date, case when r.deleted_at is not null then 'borrada' else r.status end as status
  from booking.reservations r;

revoke all on booking.reservation_end_dates from public, anon, authenticated;
grant select on booking.reservation_end_dates to service_role;
