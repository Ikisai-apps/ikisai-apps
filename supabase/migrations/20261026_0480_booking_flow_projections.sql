-- Ikisai Booking · el evento y su personal para Flow (encargo de VG del 26-10-2026, barra del evento del 30-10 al 1-11).
-- Dos vistas de solo lectura, sin importes, sin organizador y sin datos de huéspedes (contrato §2.1 y §8):
-- - `booking.event_projection`: una fila por evento vivo cuya reserva no está cancelada ni perdida. Flow la usa al crear o
--   editar su proyecto (`flow.projects.booking_event_id`) y en caja (nombre y fechas). La leen Flow (reader, editor y owner)
--   y Booking.
-- - `booking.event_staff_projection`: una fila por turno no cancelado, con la cuenta Ikisai de la persona (si la tiene),
--   su ficha de Central (si está enlazada), un nombre corto («Marta R.»), su función y su día. Sin horas, notas ni nombre
--   completo. La lee Flow (editor y owner) para proponer a quién dar acceso.
-- Toca solo el schema booking.

create view booking.event_projection as
select
  e.id as event_id,
  e.code as event_code,
  r.title as name,
  r.event_type as kind,
  r.status,
  r.start_date as starts_on,
  r.end_date as ends_on,
  coalesce(e.final_guests, r.expected_guests) as expected_attendance,
  e.revision as event_revision
from booking.events e
join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
where e.deleted_at is null and r.status not in ('cancelada', 'perdida');

revoke all on booking.event_projection from public, anon, authenticated;
grant select on booking.event_projection to service_role;

-- «Marta Ruiz Gómez» → «Marta R.»; un solo nombre, tal cual (120 caracteres como mucho, como `person_name`).
create or replace function booking.short_person_name(p_name text)
returns text language sql immutable as $$
  select case when array_length(w, 1) > 1 then w[1] || ' ' || upper(left(w[2], 1)) || '.' else w[1] end
  from (select regexp_split_to_array(btrim(p_name), '\s+') as w) x
$$;

create view booking.event_staff_projection as
select
  s.event_id,
  s.member_user_id as user_id,
  case when s.person_ref_app = 'central' then s.person_ref_id end as central_person_id,
  booking.short_person_name(s.person_name) as display_name,
  s.function as role,
  s.work_date as day
from booking.staff_assignments s
join booking.event_projection p on p.event_id = s.event_id
where s.deleted_at is null and s.status <> 'cancelada';

revoke all on booking.event_staff_projection from public, anon, authenticated;
grant select on booking.event_staff_projection to service_role;

select core.allow_read('flow', 'booking.event_projection', 'view', '{reader,editor,owner}');
select core.allow_read('booking', 'booking.event_projection', 'view');
select core.allow_read('flow', 'booking.event_staff_projection', 'view', '{editor,owner}');
