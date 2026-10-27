-- Ikisai Booking · venta de noches en línea con Stripe (VG con Finance, 27-10-2026). El adaptador es el compartido de
-- Finance (`_domain/payments/stripe.ts`); Booking lo envuelve en `booking-api/payments.ts`. Sigue apagado: sin
-- `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET`, `PAYMENTS_OFF`; y ningún evento usa `online` hasta que se encienda.
-- - `stay_payments.provider_payment_ref`: el pago de la pasarela (`pi_…` en Stripe), que llega con el aviso `paid`.
--   Las devoluciones de Stripe (`charge.refunded`) solo traen ese pago, y se casan por él.
-- - `booking.stay_payments_pending` dice también si la retención de la cama ya venció (`hold_expired`). Stripe no deja
--   caducar una sesión antes de 30 minutos y la cama se guarda 20 (VG); el worker caduca a mano la sesión de lo vencido.
-- Toca solo el schema booking.

alter table booking.stay_payments add column provider_payment_ref text check (provider_payment_ref is null or char_length(provider_payment_ref) between 1 and 200);
select core.register_table('booking', 'booking', 'stay_payments', array['request_id','provider','provider_ref','amount_cents','currency','status','paid_at',
  'refunded_cents','fee_cents','last_event_id','redirect_url','cancel_refund_cents','cancel_claimed_at','provider_payment_ref'], '{editor,owner}', '{editor,owner}');

create or replace function booking.stay_payment_record(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); q booking.visitor_requests; sp booking.stay_payments; r booking.reservations;
  v_status text; v_ops jsonb := '[]'::jsonb; v_id uuid; v_accepted boolean := false;
begin
  -- el intento vivo de una solicitud, si lo hay (para no crear otro)
  if a->>'action' = 'current' then
    select * into sp from booking.stay_payments where request_id = nullif(a->>'request_id', '')::uuid and status = 'pending' and deleted_at is null;
    return case when sp.id is null then null else jsonb_build_object('payment_id', sp.id, 'provider', sp.provider, 'provider_ref', sp.provider_ref, 'redirect_url', sp.redirect_url) end;
  end if;
  if a->>'action' = 'open' then
    select * into q from booking.visitor_requests where id = nullif(a->>'request_id', '')::uuid and deleted_at is null;
    if q.id is null or q.kind <> 'stay' then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests')); end if;
    if q.status <> 'pendiente' or q.pay_mode <> 'online' then perform core.fail('REQUEST_CLOSED', 409, jsonb_build_object('request_id', q.id, 'status', q.status)); end if;
    if q.hold_until is null or q.hold_until <= now() then perform core.fail('HOLD_EXPIRED', 409, jsonb_build_object('request_id', q.id)); end if;
    -- antes de pagar, nombre y correo (VG, vg-38): en el contacto o en el borrador del primer viajero
    if coalesce(q.contact, '') !~ '^[^@\s]+@[^@\s]+$' and not exists (select 1 from booking.stay_travelers t
        where t.request_id = q.id and t.deleted_at is null and t.email ~ '^[^@\s]+@[^@\s]+$') then
      perform core.fail('EMAIL_REQUIRED', 422, jsonb_build_object('field', 'email'));
    end if;
    if (a->>'amount_cents')::integer is distinct from q.total_cents then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'amount_cents', 'expected', q.total_cents)); end if;
    select * into sp from booking.stay_payments where request_id = q.id and status = 'pending' and deleted_at is null;
    if sp.id is not null then return jsonb_build_object('payment_id', sp.id, 'status', sp.status, 'provider_ref', sp.provider_ref, 'reused', true); end if;
    v_id := gen_random_uuid();
    perform core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.stay_payments', 'id', v_id,
      'fields', jsonb_build_object('request_id', q.id, 'provider', a->>'provider', 'provider_ref', a->>'provider_ref', 'amount_cents', q.total_cents, 'redirect_url', a->>'redirect_url'))));
    return jsonb_build_object('payment_id', v_id, 'status', 'pending', 'provider_ref', a->>'provider_ref', 'reused', false);
  end if;
  if a->>'action' = 'event' then
    -- por la sesión o, en las devoluciones de Stripe (`charge.refunded`), por el pago (1420)
    select * into sp from booking.stay_payments where provider = a->>'provider' and deleted_at is null
       and (provider_ref = a->>'provider_ref' or provider_payment_ref = a->>'provider_ref') limit 1;
    if sp.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.stay_payments')); end if;
    if sp.last_event_id is not distinct from nullif(a->>'event_id', '') then return jsonb_build_object('payment_id', sp.id, 'status', sp.status, 'replayed', true); end if;
    v_status := a->>'status';
    if v_status not in ('paid', 'failed', 'expired', 'refunded') then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'status')); end if;
    if v_status = 'refunded' and coalesce((a->>'refunded_cents')::integer, sp.amount_cents) < sp.amount_cents then v_status := 'partially_refunded'; end if;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.stay_payments', 'id', sp.id, 'expectedRevision', sp.revision, 'fields',
      jsonb_strip_nulls(jsonb_build_object('status', v_status, 'last_event_id', a->>'event_id',
        'paid_at', case when v_status = 'paid' then now() when sp.paid_at is not null then sp.paid_at end,
        'refunded_cents', case when v_status in ('refunded', 'partially_refunded') then coalesce((a->>'refunded_cents')::integer, sp.amount_cents) end,
        'fee_cents', (a->>'fee_cents')::integer,
        'provider_payment_ref', case when v_status = 'paid' then nullif(a->>'payment_ref', '') end)));
    -- pagado: la cama se guarda hasta la salida, aunque recepción tarde en alojarlo
    if v_status = 'paid' then
      select * into q from booking.visitor_requests where id = sp.request_id;
      if q.status = 'pendiente' then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', q.id, 'expectedRevision', q.revision,
          'fields', jsonb_build_object('hold_until', (q.to_date + 1)::timestamptz));
      end if;
    end if;
    perform set_config('booking.visitor_procedure', 'on', true);
    perform core.apply_system_operations('booking', v_ops);
    perform set_config('booking.visitor_procedure', '', true);
    -- pagado (1415): el servidor aloja solo, en otro lote de sistema. Si no puede (la cama ya no está), el pago queda anotado
    -- igualmente y recepción lo ve como «Pagado en línea» para resolverlo.
    if v_status = 'paid' and q.id is not null and q.status = 'pendiente' then
      begin
        perform core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'call', 'procedure', 'booking.join_from_visitor',
          'args', jsonb_build_object('request_id', q.id, 'decision', 'accept', 'method', 'online'))));
        v_accepted := true;
      exception when others then
        v_accepted := false;
      end;
    end if;
    return jsonb_build_object('payment_id', sp.id, 'status', v_status, 'request_id', sp.request_id, 'replayed', false, 'accepted', v_accepted);
  end if;
  perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'action'));
end $$;

create or replace function booking.stay_payments_pending(p jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider', sp.provider, 'provider_ref', sp.provider_ref,
           'hold_expired', q.hold_until is null or q.hold_until <= now()) order by sp.created_at), '[]'::jsonb)
    from booking.stay_payments sp join booking.visitor_requests q on q.id = sp.request_id
   where sp.status = 'pending' and sp.deleted_at is null
     and sp.created_at < now() - make_interval(mins => least(greatest(coalesce((p->'args'->>'older_minutes')::integer, 10), 0), 1440))
   limit 100
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
