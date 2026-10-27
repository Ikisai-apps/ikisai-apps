-- Ikisai Booking · seguridad B9 (auditoría de rutas del 27-10-2026): «Regenerar» el código público del evento ya no acepta
-- el código que manda el cliente; un editor podía poner uno débil o adivinable. En un lote (lo que llega de la app) el
-- servidor pone siempre uno nuevo con `booking.new_public_code()` (0488), único, aunque el cliente mande otro. Quitarlo
-- (null) sigue valiendo. Lo que se hace a mano en la base, fuera de un lote, no cambia.
-- Toca solo el schema booking.

create or replace function booking.public_code_from_server()
returns trigger language plpgsql as $$
declare v text;
begin
  if booking.batch_setting('request_id') is null or new.public_code is null or new.public_code is not distinct from old.public_code then return new; end if;
  loop
    v := booking.new_public_code();
    exit when not exists (select 1 from booking.events where public_code = v);
  end loop;
  new.public_code := v;
  return new;
end $$;
create trigger events_public_code_from_server before update of public_code on booking.events
  for each row execute function booking.public_code_from_server();

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
