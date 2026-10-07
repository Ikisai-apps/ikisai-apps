-- K1 (portales): comprobación de ámbito reutilizable por cualquier app que publique lecturas o acciones para un portal
-- (Finance, Food…), sin depender de una función de Booking. Verdadero si la pertenencia del actor al portal tiene una
-- entrada `scopes.grants` con esa reserva; en Guests, además, con ese huésped. Un portal sin ámbito no ve nada.
create or replace function core.portal_in_scope(p_portal text, p_actor uuid, p_reservation uuid, p_guest uuid default null)
returns boolean language sql stable as $$
  select p_reservation is not null and exists (
    select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
     where m.app = p_portal and m.user_id = p_actor
       and g ->> 'reservation_id' = p_reservation::text
       and (p_portal <> 'guests' or (p_guest is not null and g ->> 'guest_id' = p_guest::text)));
$$;
revoke all on function core.portal_in_scope(text, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function core.portal_in_scope(text, uuid, uuid, uuid) to service_role;
