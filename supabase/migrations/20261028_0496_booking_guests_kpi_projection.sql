-- Ikisai Booking · agregados de huéspedes para los KPIs de Guests en el panel de Dirección (P7 de Central; petición de
-- Guests del 27-10-2026). Guests no tiene tablas: su vista `guests.central_kpi_projection` lee esta, que solo lleva
-- números por reserva (ningún nombre ni dato de una persona).
-- `booking.guests_kpi_projection`: una fila por reserva viva confirmada o en ejecución que entra entre hoy−30 y hoy+30
-- (hora de Madrid) o está en curso.
-- - `guests`: huéspedes vivos del evento. No cuentan el de muestra (`preview`), el equipo (`portal_role`), los borrados
--   ni los anonimizados.
-- - De esos `guests`:
--   - `entered`: aceptaron la privacidad (`privacy_ack_at`);
--   - `signed`: firmaron (`signed_at`);
--   - `unsigned`: guests − signed;
--   - `ses_sent`: `ses_status = 'enviado_SES'`;
--   - `ses_pending`: llegaron (`arrived_at`) y no están ni en `enviado_SES` ni en `no_aplica`.
-- Sin `allow_read`: solo la lee service_role (la vista de Guests).
-- Toca solo el schema booking.

create or replace view booking.guests_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d)
select r.id as reservation_id, r.start_date, r.end_date,
       count(g.id)::integer as guests,
       (count(g.id) filter (where g.privacy_ack_at is not null))::integer as entered,
       (count(g.id) filter (where g.signed_at is not null))::integer as signed,
       (count(g.id) filter (where g.signed_at is null))::integer as unsigned,
       (count(g.id) filter (where g.ses_status = 'enviado_SES'))::integer as ses_sent,
       (count(g.id) filter (where g.arrived_at is not null and g.ses_status not in ('enviado_SES', 'no_aplica')))::integer as ses_pending
  from booking.reservations r
  cross join today
  left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
  left join booking.guests g on g.event_id = e.id and g.deleted_at is null and not g.preview and g.portal_role is null and g.anonymized_at is null
 where r.deleted_at is null and r.archived_at is null and r.status in ('confirmada', 'en_ejecucion')
   and r.start_date is not null
   and (r.start_date between today.d - 30 and today.d + 30 or (r.start_date <= today.d and coalesce(r.end_date, r.start_date) >= today.d))
 group by r.id, r.start_date, r.end_date;

revoke all on booking.guests_kpi_projection from public, anon, authenticated;
grant select on booking.guests_kpi_projection to service_role;
