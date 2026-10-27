-- Ikisai Booking · venta de noches en línea: el servidor aloja solo cuando la pasarela confirma el pago (booking-22; va
-- sobre 1414 y necesita la 0109 del núcleo, #1013, que admite llamadas de procedimiento en los lotes de sistema).
-- - `booking.join_from_visitor` se registra para el sistema (`core.allow_system_procedure`). El envoltorio de B7 (1408)
--   deja pasar la llamada de sistema (`core.is_system_call()`) solo para aceptar con `method: 'online'`; para el resto
--   sigue exigiendo el ámbito de huéspedes.
-- - `booking.stay_payment_record`, con el aviso `paid`: después de anotar el pago, aloja en otro lote de sistema (fichas con
--   el borrador, cama con fechas y cobro `online` ya cobrado). Si no puede, el pago queda anotado igualmente
--   (`accepted: false`) y recepción lo resuelve.
-- Toca solo el schema booking.

select core.allow_system_procedure('booking', 'booking.join_from_visitor');

create or replace function booking.join_from_visitor(p jsonb)
returns jsonb language plpgsql as $$
begin
  if coalesce(p->'args'->>'decision', '') = 'accept' then
    if core.is_system_call() then
      -- el sistema solo aloja lo pagado en línea (la comprobación del pago la hace la base)
      if coalesce(p->'args'->>'method', '') <> 'online' then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'system accepts only online payments'));
      end if;
    elsif not booking.actor_sees_guests((p->>'actor')::uuid) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guests scope required to accept'));
    end if;
  end if;
  return booking.join_from_visitor_base(p);
end $$;

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
    if (a->>'amount_cents')::integer is distinct from q.total_cents then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'amount_cents', 'expected', q.total_cents)); end if;
    select * into sp from booking.stay_payments where request_id = q.id and status = 'pending' and deleted_at is null;
    if sp.id is not null then return jsonb_build_object('payment_id', sp.id, 'status', sp.status, 'provider_ref', sp.provider_ref, 'reused', true); end if;
    v_id := gen_random_uuid();
    perform core.apply_system_operations('booking', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.stay_payments', 'id', v_id,
      'fields', jsonb_build_object('request_id', q.id, 'provider', a->>'provider', 'provider_ref', a->>'provider_ref', 'amount_cents', q.total_cents, 'redirect_url', a->>'redirect_url'))));
    return jsonb_build_object('payment_id', v_id, 'status', 'pending', 'provider_ref', a->>'provider_ref', 'reused', false);
  end if;
  if a->>'action' = 'event' then
    select * into sp from booking.stay_payments where provider = a->>'provider' and provider_ref = a->>'provider_ref' and deleted_at is null;
    if sp.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.stay_payments')); end if;
    if sp.last_event_id is not distinct from nullif(a->>'event_id', '') then return jsonb_build_object('payment_id', sp.id, 'status', sp.status, 'replayed', true); end if;
    v_status := a->>'status';
    if v_status not in ('paid', 'failed', 'expired', 'refunded') then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'status')); end if;
    if v_status = 'refunded' and coalesce((a->>'refunded_cents')::integer, sp.amount_cents) < sp.amount_cents then v_status := 'partially_refunded'; end if;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.stay_payments', 'id', sp.id, 'expectedRevision', sp.revision, 'fields',
      jsonb_strip_nulls(jsonb_build_object('status', v_status, 'last_event_id', a->>'event_id',
        'paid_at', case when v_status = 'paid' then now() when sp.paid_at is not null then sp.paid_at end,
        'refunded_cents', case when v_status in ('refunded', 'partially_refunded') then coalesce((a->>'refunded_cents')::integer, sp.amount_cents) end,
        'fee_cents', (a->>'fee_cents')::integer)));
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

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
