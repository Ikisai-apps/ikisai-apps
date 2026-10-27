-- Ikisai Booking · seguridad B8 (auditoría de rutas del 27-10-2026): con el código del QR se podían crear peticiones sin
-- límite. En un lote público, una petición nueva falla con 429 `RATE_LIMITED` si:
-- - el mismo visitante ya ha hecho 20 en la última hora (cada «pedir otra vez» de noches cuenta);
-- - el evento ya ha recibido 120 en los últimos 10 minutos.
-- Es un disparador aparte de la guarda (0489/0499/1400): se dispara después, por orden de nombre, con el evento ya sacado
-- del código. El límite por IP de crear visitantes es del núcleo (`core.visitors`, 0096): se lo pido a Core.
-- Toca solo el schema booking.

create index visitor_requests_visitor_recent_idx on booking.visitor_requests (visitor_id, created_at);

create or replace function booking.visitor_request_rate()
returns trigger language plpgsql as $$
begin
  if not core.is_public_batch() then return new; end if;
  if (select count(*) from booking.visitor_requests q where q.visitor_id = new.visitor_id and q.created_at > now() - interval '1 hour') >= 20 then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many requests from this visitor', 'retry_after_seconds', 3600));
  end if;
  if (select count(*) from booking.visitor_requests q where q.event_id = new.event_id and q.created_at > now() - interval '10 minutes') >= 120 then
    perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many requests for this event', 'retry_after_seconds', 600));
  end if;
  return new;
end $$;
create trigger visitor_requests_rate before insert on booking.visitor_requests
  for each row execute function booking.visitor_request_rate();

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
