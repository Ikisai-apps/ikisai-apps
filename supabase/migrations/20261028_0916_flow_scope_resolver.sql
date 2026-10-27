-- Ikisai Flow · resolutor de ámbito para el núcleo (core 0098), para que Booking sirva a Flow los huéspedes de un evento
-- solo si la persona tiene en su ámbito algún flujo de ese evento (booking.flow_guests_of, 0486). Va con la PR de Booking
-- (#751) para que main no se rompa al cerrar la vista; la 0912 de Flow define lo mismo (create or replace: idempotente).

create or replace function flow.in_scope(p_actor uuid, p_kind text, p_id text) returns boolean language sql stable as $$
  select case p_kind
    when 'booking_event' then exists (
      select 1 from flow.projects pr
       where pr.deleted_at is null and pr.booking_event_id::text = p_id and flow.in_scope(p_actor, pr.id))
    else false end
$$;
select core.allow_scope_resolver('flow', 'flow.in_scope');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
