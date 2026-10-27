-- Ikisai Booking · `lodging` en la lectura pública de un evento por su código (`booking_event`, 0488), con la misma regla
-- que `booking_public_events` (0498): jornadas abiertas que tienen alguna tarifa de alojamiento por persona y noche
-- (`booking.lodging_rates`). Así Guests no lo supone por el tipo de evento (petición de Guests, 27-10-2026).
-- Toca solo el schema booking.

create or replace function booking.public_event(p jsonb)
returns jsonb language sql stable as $$
  select case when r.id is null then null else jsonb_build_object(
      'code', e.public_code, 'name', r.title, 'starts_on', r.start_date, 'ends_on', r.end_date, 'kind', r.event_type,
      'status', case when r.status in ('pre_reservada', 'confirmada', 'en_ejecucion') and r.archived_at is null then 'abierto' else 'cerrado' end,
      'joinable', r.guests_visible and r.archived_at is null and r.status in ('pre_reservada', 'confirmada', 'en_ejecucion'),
      'summary', case when r.guests_visible then r.public_summary end,
      'lodging', r.event_type = 'jornadas_abiertas' and exists (select 1 from booking.lodging_rates(r.event_type))) end
    from booking.events e
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.status not in ('cancelada', 'perdida')
   where e.deleted_at is null and e.public_code = upper(btrim(coalesce(p->>'code', '')))
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
