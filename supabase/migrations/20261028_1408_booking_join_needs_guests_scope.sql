-- Ikisai Booking · seguridad B7 (auditoría de rutas del 27-10-2026):
-- - `booking.join_from_visitor` con `decision = 'accept'` crea fichas de huésped (y, en las solicitudes de noches, con los
--   datos del borrador): exige lo mismo que ver huéspedes, owner o editor con `scopes.guests` (`booking.actor_sees_guests`,
--   0472). Descartar o atender un dato sigue valiendo para cualquier editor. Va como envoltorio: la de 1401 pasa a `_base`
--   (sin registrar).
-- - `booking.guest_arrive` y `booking.guest_leave` siguen abiertos a cualquier editor A PROPÓSITO: los usa Flow en la
--   llegada y la salida con quien trabaja allí, solo cambian la hora y no enseñan datos personales (Flow ve el nombre
--   corto). Queda documentado en API §5.1 y §26.
-- Toca solo el schema booking.

alter function booking.join_from_visitor(jsonb) rename to join_from_visitor_base;

create or replace function booking.join_from_visitor(p jsonb)
returns jsonb language plpgsql as $$
begin
  if coalesce(p->'args'->>'decision', '') = 'accept' and not booking.actor_sees_guests((p->>'actor')::uuid) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required to accept'));
  end if;
  return booking.join_from_visitor_base(p);
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
