-- Ikisai Booking · usa los helpers del núcleo para saber si se está dentro de un lote (`core.in_batch()`,
-- `core.current_request_id()`, 0107; Core Ops 27-10-2026), en vez de mirar `current_setting('core.*')` a mano: fuera de
-- un lote, tras el primero de la sesión, el ajuste queda vacío ('') y no null.
-- - `booking.batch_setting` (0499) devuelve null fuera de un lote, y nunca ''.
-- - El código público que pone el servidor (1406) mira `core.in_batch()`.
-- Toca solo el schema booking.

create or replace function booking.batch_setting(p_name text)
returns text language sql stable as $$
  select case when core.in_batch() then nullif(current_setting('core' || '.' || p_name, true), '') end
$$;

create or replace function booking.public_code_from_server()
returns trigger language plpgsql as $$
declare v text;
begin
  if not core.in_batch() or new.public_code is null or new.public_code is not distinct from old.public_code then return new; end if;
  loop
    v := booking.new_public_code();
    exit when not exists (select 1 from booking.events where public_code = v);
  end loop;
  new.public_code := v;
  return new;
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
