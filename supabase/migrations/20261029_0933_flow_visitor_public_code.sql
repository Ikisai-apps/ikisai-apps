-- Ikisai Flow · el visitante encuentra la barra por el código público del evento (Booking #919, `public_code`).
-- El QR y las direcciones de ven.ikisai.com llevan siempre `public_code` (Booking 0488); el código interno (EVT_…) no sale
-- fuera. `flow.visitor_project` comparaba solo con el interno: con el QR real no encontraba la barra. Acepta los dos
-- mientras convivan.
create or replace function flow.visitor_project(p_event_code text) returns uuid language sql stable as $$
  select pr.id from flow.projects pr join booking.event_projection e on e.event_id = pr.booking_event_id
   where (e.public_code = upper(btrim(p_event_code)) or e.event_code = p_event_code)
     and pr.deleted_at is null and pr.status = 'active' and pr.serves_public
   order by pr.created_at desc limit 1
$$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
