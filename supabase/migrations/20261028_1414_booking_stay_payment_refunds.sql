-- Ikisai Booking · venta de noches en línea, tarjetas 4 y 5 (booking-22; apagada por defecto, va sobre 1413):
-- - Conciliación: `booking.stay_payments_pending({older_minutes})` (sistema) da los intentos pendientes de hace más de N
--   minutos. El worker pregunta a la pasarela por cada uno y aplica lo que diga con `stay_payment_record` (por si se perdió
--   un aviso).
-- - Devolución por la pasarela: `booking.stay_payment_for_charge({charge_id})` (editor, owner) da el pago en línea del cobro
--   (proveedor, referencia, importe y lo devuelto). booking-api pide la devolución a la pasarela; la ficha anota la
--   devolución en el cobro (1403) y el aviso `refunded` de la pasarela la anota en el pago.
-- Toca solo el schema booking.

create or replace function booking.stay_payments_pending(p jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider', sp.provider, 'provider_ref', sp.provider_ref) order by sp.created_at), '[]'::jsonb)
    from booking.stay_payments sp
   where sp.status = 'pending' and sp.deleted_at is null
     and sp.created_at < now() - make_interval(mins => least(greatest(coalesce((p->'args'->>'older_minutes')::integer, 10), 0), 1440))
   limit 100
$$;
select core.allow_read('booking', 'booking.stay_payments_pending', 'action', '{}');

create or replace function booking.stay_payment_for_charge(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('payment_id', sp.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'amount_cents', sp.amount_cents,
           'refunded_cents', sp.refunded_cents, 'status', sp.status, 'charge_amount_cents', c.amount_cents, 'charge_refund_cents', c.refund_cents)
    from booking.walkin_charges c
    join booking.visitor_requests q on q.guest_id = c.guest_id and q.kind = 'stay' and q.status = 'aceptada'
    join booking.stay_payments sp on sp.request_id = q.id and sp.status in ('paid', 'partially_refunded', 'refunded') and sp.deleted_at is null
   where c.id = nullif(p->'args'->>'charge_id', '')::uuid and c.deleted_at is null and c.method = 'online'
   limit 1
$$;
select core.allow_read('booking', 'booking.stay_payment_for_charge', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
