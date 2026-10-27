-- Ikisai Booking · venta de noches en línea: cancelación con la política de VG (vg-38, 27-10-2026). Sigue apagado por defecto:
-- solo afecta a lo pagado en línea.
-- - Política: se devuelve el 100 % hasta 7 días antes de la llegada, la mitad hasta 48 h antes y nada después. Si la casa
--   cancela el evento (`cancelada` o `perdida`), siempre el 100 %. La llegada cuenta desde las 00:00 (Europe/Madrid) del
--   primer día. `booking.stay_cancel_quote_of(q, at)` lo calcula, y lo que ya se devolvió se descuenta.
-- - El visitante ve la propuesta en su solicitud (`cancel`: porcentaje, importe y plazos).
-- - `booking.stay_cancel` (acción de sistema, como `stay_payment_record`):
--   - `quote` da la propuesta y el pago;
--   - `claim` reserva la cancelación en el pago (`cancel_refund_cents`, `cancel_claimed_at`) con el pago bloqueado: dos
--     peticiones a la vez se llevan el mismo importe, y la ruta pide la devolución con una clave de idempotencia fija por
--     solicitud, así la pasarela devuelve una sola vez;
--   - `apply` cancela: suelta la cama y la solicitud queda `descartada`. Si ya estaba alojado (sin haber llegado), borra
--     sus fichas y camas y anota lo devuelto en sus cobros (`refund_method = 'online'`); el apunte de Finance queda por
--     reenviar.
--   La devolución la pide antes la ruta a la pasarela. Repetir `apply` no hace nada.
-- - Las fichas de una solicitud aceptada se encuentran por el primer huésped (`guest_id`) y los que se crearon con él en la
--   misma aceptación: mismo evento, mismo instante de alta y cobro `online` con las mismas fechas.
-- Toca solo el schema booking.

alter table booking.stay_payments
  add column cancel_refund_cents integer check (cancel_refund_cents is null or cancel_refund_cents >= 0),
  add column cancel_claimed_at timestamptz,
  add constraint stay_payments_cancel_claim check ((cancel_refund_cents is null) = (cancel_claimed_at is null));
select core.register_table('booking', 'booking', 'stay_payments', array['request_id','provider','provider_ref','amount_cents','currency','status','paid_at',
  'refunded_cents','fee_cents','last_event_id','redirect_url','cancel_refund_cents','cancel_claimed_at'], '{editor,owner}', '{editor,owner}');

create or replace function booking.stay_cancel_quote_of(q booking.visitor_requests, p_at timestamptz)
returns jsonb language sql stable as $$
  with b as (
    select r.status in ('cancelada', 'perdida') as cancelled, (q.from_date::timestamp at time zone 'Europe/Madrid') as arrival,
           coalesce((select sum(sp.amount_cents) from booking.stay_payments sp where sp.request_id = q.id and sp.deleted_at is null
                      and sp.status in ('paid', 'partially_refunded', 'refunded')), 0)::integer as paid,
           coalesce((select sum(sp.refunded_cents) from booking.stay_payments sp where sp.request_id = q.id and sp.deleted_at is null), 0)::integer as refunded
      from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = q.event_id),
  t as (
    select b.*, case when b.cancelled or p_at <= b.arrival - interval '7 days' then 100 when p_at <= b.arrival - interval '48 hours' then 50 else 0 end as pct,
           case when b.cancelled then 'event_cancelled' when p_at <= b.arrival - interval '7 days' then 'full'
                when p_at <= b.arrival - interval '48 hours' then 'half' else 'none' end as tier
      from b)
  select jsonb_build_object('percent', t.pct, 'tier', t.tier, 'paid_cents', t.paid, 'refunded_cents', t.refunded,
           'refund_cents', greatest(t.paid * t.pct / 100 - t.refunded, 0),
           'full_until', t.arrival - interval '7 days', 'half_until', t.arrival - interval '48 hours')
    from t
$$;

-- Las fichas de una solicitud aceptada (ver la cabecera).
create or replace function booking.stay_guests_of(q booking.visitor_requests)
returns setof uuid language sql stable as $$
  select g.id from booking.guests g join booking.guests first on first.id = q.guest_id
   where g.event_id = q.event_id and g.deleted_at is null and g.created_at = first.created_at
     and (g.id = q.guest_id or exists (select 1 from booking.walkin_charges c join booking.room_assignments a on a.id = c.assignment_id
           where c.guest_id = g.id and c.deleted_at is null and c.method = 'online' and a.from_date = q.from_date and a.to_date = q.to_date))
$$;

create or replace function booking.stay_cancel(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); q booking.visitor_requests; sp booking.stay_payments; v_quote jsonb;
  v_ops jsonb := '[]'::jsonb; v_left integer; v_part integer; f record;
begin
  select * into q from booking.visitor_requests where id = nullif(a->>'request_id', '')::uuid and deleted_at is null;
  if q.id is null or q.kind <> 'stay' or q.visitor_id is distinct from nullif(a->>'visitor_id', '')::uuid then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests'));
  end if;
  select * into sp from booking.stay_payments where request_id = q.id and deleted_at is null and status in ('paid', 'partially_refunded', 'refunded')
   order by paid_at desc limit 1 for update;
  if sp.id is null then perform core.fail('NOT_PAID_ONLINE', 409, jsonb_build_object('request_id', q.id)); end if;
  if q.status = 'descartada' then return jsonb_build_object('request_id', q.id, 'status', 'cancelada', 'replayed', true); end if;
  if q.status <> 'pendiente' and q.status <> 'aceptada' then perform core.fail('REQUEST_CLOSED', 409, jsonb_build_object('request_id', q.id, 'status', q.status)); end if;
  if q.status = 'aceptada' and exists (select 1 from booking.guests g where g.id in (select booking.stay_guests_of(q)) and g.arrived_at is not null) then
    perform core.fail('ALREADY_ARRIVED', 409, jsonb_build_object('request_id', q.id));
  end if;
  v_quote := booking.stay_cancel_quote_of(q, now());
  if a->>'action' = 'quote' then
    return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref);
  end if;
  -- reservar la cancelación: el primero fija el importe; los demás reciben el mismo
  if a->>'action' = 'claim' then
    if sp.cancel_claimed_at is null then
      perform core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.stay_payments', 'id', sp.id,
        'expectedRevision', sp.revision, 'fields', jsonb_build_object('cancel_refund_cents', (v_quote->>'refund_cents')::integer, 'cancel_claimed_at', now()))));
      return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'claimed', true);
    end if;
    return v_quote || jsonb_build_object('request_id', q.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'claimed', false,
      'refund_cents', sp.cancel_refund_cents);
  end if;
  if a->>'action' <> 'apply' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'action')); end if;
  -- lo reservado con `claim` (la ruta ya lo ha pedido a la pasarela)
  if sp.cancel_claimed_at is null then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'claim first')); end if;
  v_left := sp.cancel_refund_cents;
  if q.status = 'aceptada' then
    for f in select c.id, c.revision, c.amount_cents, c.refund_cents from booking.walkin_charges c
              where c.guest_id in (select booking.stay_guests_of(q)) and c.deleted_at is null and c.method = 'online' order by c.created_at, c.id loop
      v_part := least(v_left, f.amount_cents - f.refund_cents);
      if v_part > 0 then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.walkin_charges', 'id', f.id, 'expectedRevision', f.revision,
          'fields', jsonb_build_object('refund_cents', f.refund_cents + v_part, 'refund_method', 'online', 'refunded_at', now()));
        v_left := v_left - v_part;
      end if;
    end loop;
    for f in select x.id, x.revision from booking.room_assignments x where x.guest_id in (select booking.stay_guests_of(q)) and x.deleted_at is null loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', f.id, 'expectedRevision', f.revision);
    end loop;
    for f in select g.id, g.revision from booking.guests g where g.id in (select booking.stay_guests_of(q)) loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.guests', 'id', f.id, 'expectedRevision', f.revision);
    end loop;
  end if;
  v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', q.id, 'expectedRevision', q.revision,
    'fields', jsonb_build_object('status', 'descartada', 'decided_at', now(), 'hold_until', null, 'guest_id', null));
  perform set_config('booking.visitor_procedure', 'on', true);
  perform core.apply_system_operations('booking', v_ops);
  perform set_config('booking.visitor_procedure', '', true);
  return v_quote || jsonb_build_object('request_id', q.id, 'status', 'cancelada', 'replayed', false, 'refunded_now_cents', sp.cancel_refund_cents);
end $$;
select core.allow_read('booking', 'booking.stay_cancel', 'action', '{}');

create or replace function booking.visitor_item(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', q.id, 'event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
           'created_at', q.created_at, 'decided_at', q.decided_at,
           'from', q.from_date, 'to', q.to_date, 'persons', q.persons, 'mode_id', q.rate_id, 'total_cents', q.total_cents, 'pay', q.pay_mode,
           'hold_until', q.hold_until, 'hold_expired', q.kind = 'stay' and q.pay_mode in ('hold', 'online') and q.status = 'pendiente' and (q.hold_until is null or q.hold_until <= now()),
           'number', q.number, 'stay_status', booking.stay_status_of(q), 'beds', booking.stay_beds_of(q),
           'paid_at', (select max(c.paid_at) from booking.walkin_charges c where q.guest_id is not null and c.guest_id = q.guest_id and c.deleted_at is null),
           'missing', booking.stay_missing_of(q),
           'paid_online', exists (select 1 from booking.stay_payments sp where sp.request_id = q.id and sp.status = 'paid'),
           -- 1419: lo que se devolvería si cancela ahora (solo lo pagado en línea y aún sin cancelar)
           'cancel', case when q.kind = 'stay' and q.status in ('pendiente', 'aceptada') and exists (select 1 from booking.stay_payments sp
             where sp.request_id = q.id and sp.status in ('paid', 'partially_refunded') and sp.deleted_at is null) then booking.stay_cancel_quote_of(q, now()) end)
    from booking.events e where e.id = q.event_id
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
