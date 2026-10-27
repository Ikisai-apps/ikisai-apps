-- Ikisai Booking · venta de noches en línea: el visitante elige pagar en línea o en recepción (VG, vg-38, 27-10-2026).
-- Sigue apagado por defecto: solo cambia algo en los eventos con `lodging_pay_mode = 'online'`.
-- - `reservations.lodging_pay_on_site` (por defecto `false`): con `online`, deja además pagar en recepción. La solicitud
--   guarda `pay_mode = 'hold'` (se guarda la plaza `lodging_hold_hours`) o `online` (20 minutos mientras se paga).
--   Si el visitante pide un modo que el evento no deja, 422 `PAY_MODE_NOT_ALLOWED`.
-- - La oferta pública dice `pay_options` (`online`, `on_site`) para que Guests pinte uno o dos botones.
-- - Para pagar en línea hace falta un correo (VG: nombre y correo antes de pagar; SES al llegar o desde el enlace). Vale
--   el del contacto o el del borrador del primer viajero; si no hay, 422 `EMAIL_REQUIRED`.
-- Toca solo el schema booking.

alter table booking.reservations add column lodging_pay_on_site boolean not null default false;
select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive','organizer_notes',
  'guests_visible','public_summary','food_carta_ids','lodging_pay_mode','lodging_hold_hours','lodging_online_minutes','lodging_pay_on_site']);

-- Cómo puede pagar las noches el visitante de ese evento.
create or replace function booking.pay_options_of(r booking.reservations)
returns jsonb language sql immutable as $$
  select case when r.lodging_pay_mode = 'online' and r.lodging_pay_on_site then '["online", "on_site"]'::jsonb
              when r.lodging_pay_mode = 'online' then '["online"]'::jsonb
              else '["on_site"]'::jsonb end
$$;

create or replace function booking.visitor_request_guard()
returns trigger language plpgsql as $$
declare r booking.reservations; t booking.rates; v_free integer; v_got integer := 0; v_beds uuid[] := '{}'; v_chosen uuid[]; f record;
begin
  if tg_op = 'UPDATE' and coalesce(current_setting('booking.visitor_procedure', true), '') = 'on'
     and new.visitor_id is not distinct from old.visitor_id and new.event_id is not distinct from old.event_id then
    return new;
  end if;
  if core.is_public_batch() then
    if tg_op <> 'INSERT' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a visitor only creates its request')); end if;
    if new.visitor_id is null or new.visitor_id is distinct from core.current_visitor() then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'visitor_id must be the visitor of the batch'));
    end if;
    if new.status <> 'pendiente' or new.guest_id is not null or new.decided_at is not null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'pending request with visitor_id only'));
    end if;
    new.via_code := upper(btrim(coalesce(new.via_code, '')));
    new.event_id := (select e.id from booking.events e where e.public_code = new.via_code and e.deleted_at is null);
    select rr.* into r from booking.events e join booking.reservations rr on rr.id = e.reservation_id
     where e.id = new.event_id and e.deleted_at is null and rr.deleted_at is null;
    if r.id is null or r.archived_at is not null or r.status not in ('pre_reservada', 'confirmada', 'en_ejecucion') or (new.kind in ('join', 'stay') and not r.guests_visible) then
      perform core.fail('RESERVATION_NOT_OPEN', 422, jsonb_build_object('event_id', new.event_id));
    end if;
    new.name := nullif(btrim(new.name), '');
    new.note := nullif(btrim(new.note), '');
    new.contact := nullif(btrim(new.contact), '');
    if new.kind = 'contact' and new.contact is null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'contact'));
    end if;
    if new.kind <> 'stay' then
      if new.from_date is not null or new.to_date is not null or new.persons is not null or new.rate_id is not null or new.hold_bed_ids is not null or new.hold_until is not null or new.number is not null then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'nights only in a stay request'));
      end if;
      return new;
    end if;
    if r.event_type <> 'jornadas_abiertas' then perform core.fail('NO_LODGING', 422, jsonb_build_object('event_id', new.event_id)); end if;
    if new.name is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'name')); end if;
    if new.from_date is null or new.to_date is null or new.to_date <= new.from_date or new.from_date < r.start_date or new.to_date > r.end_date or new.to_date - new.from_date > 31 then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'from_date', 'starts_on', r.start_date, 'ends_on', r.end_date));
    end if;
    if new.persons is null or new.persons not between 1 and 20 then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'persons'));
    end if;
    -- la modalidad elegida, o la primera que valga
    select x.* into t from booking.lodging_rates(r.event_type) x
     where (new.rate_id is null or x.id = new.rate_id)
       and (x.valid_from is null or x.valid_from <= new.from_date) and (x.valid_to is null or (new.to_date - 1) <= x.valid_to)
       and (x.max_persons is null or new.persons <= x.max_persons) and (x.min_persons is null or new.persons >= x.min_persons)
     order by x.position, x.name limit 1;
    if t.id is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'rate_id')); end if;
    new.rate_id := t.id;
    new.total_cents := round(t.amount * 100)::integer * (new.to_date - new.from_date) * new.persons;
    -- el visitante elige (1418): en línea o en recepción, si el evento deja las dos; si no dice nada, el del evento
    if new.pay_mode is null or new.pay_mode = r.lodging_pay_mode then
      new.pay_mode := r.lodging_pay_mode;
    elsif not (r.lodging_pay_mode = 'online' and r.lodging_pay_on_site and new.pay_mode = 'hold') then
      perform core.fail('PAY_MODE_NOT_ALLOWED', 422, jsonb_build_object('pay', new.pay_mode, 'allowed', booking.pay_options_of(r)));
    end if;
    v_chosen := new.hold_bed_ids;
    new.hold_bed_ids := null; new.hold_until := null;
    -- la solicitud anterior del mismo visitante para este evento queda sustituida (y suelta su bloqueo)
    perform set_config('booking.visitor_procedure', 'on', true);
    for f in select id, revision from booking.visitor_requests
              where event_id = new.event_id and visitor_id = new.visitor_id and kind = 'stay' and status = 'pendiente' and deleted_at is null loop
      perform core.apply_row_op(booking.batch_setting('app'), nullif(booking.batch_setting('actor'), '')::uuid, 'editor',
        booking.batch_setting('request_id'), booking.batch_setting('cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', f.id, 'expectedRevision', f.revision,
          'fields', jsonb_build_object('status', 'descartada', 'decided_at', now(), 'hold_until', null)));
    end loop;
    perform set_config('booking.visitor_procedure', '', true);
    select coalesce(sum(x.places), 0) into v_free from booking.free_beds(new.from_date, new.to_date) x;
    if v_free < new.persons then
      perform core.fail('NO_AVAILABILITY', 409, jsonb_build_object('available', least(v_free, 20), 'persons', new.persons));
    end if;
    -- las camas elegidas, libres todas las noches; si no llegan a las personas, se completan solas
    if coalesce(cardinality(v_chosen), 0) > 0 then
      if cardinality(v_chosen) > 20 or exists (select 1 from unnest(v_chosen) c(id) where c.id not in (select x.bed_id from booking.free_beds(new.from_date, new.to_date) x)) then
        perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_ids', to_jsonb(v_chosen)));
      end if;
      select array_agg(distinct x.bed_id), coalesce(sum(x.places), 0) into v_beds, v_got
        from booking.free_beds(new.from_date, new.to_date) x where x.bed_id = any (v_chosen);
    end if;
    for f in select * from booking.free_beds(new.from_date, new.to_date) x where not (x.bed_id = any (v_beds)) order by space_id, bed_id loop
      exit when v_got >= new.persons;
      v_beds := v_beds || f.bed_id; v_got := v_got + f.places;
    end loop;
    new.hold_bed_ids := v_beds;
    if new.pay_mode = 'hold' then new.hold_until := now() + make_interval(hours => r.lodging_hold_hours);
    elsif new.pay_mode = 'online' then new.hold_until := now() + make_interval(mins => r.lodging_online_minutes); end if;
    new.number := coalesce((select max(q.number) from booking.visitor_requests q where q.event_id = new.event_id), 0) + 1;
    return new;
  end if;
  if tg_op = 'INSERT' and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'only visitors create requests'));
  end if;
  if tg_op = 'UPDATE' and (new.visitor_id is distinct from old.visitor_id or new.event_id is distinct from old.event_id) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'visitor and event do not change'));
  end if;
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.guest_id is distinct from old.guest_id)
     and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decide with booking.join_from_visitor'));
  end if;
  if tg_op = 'UPDATE' and (new.from_date, new.to_date, new.persons, new.rate_id, new.total_cents, new.pay_mode, new.hold_bed_ids, new.hold_until, new.number)
       is distinct from (old.from_date, old.to_date, old.persons, old.rate_id, old.total_cents, old.pay_mode, old.hold_bed_ids, old.hold_until, old.number)
     and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'stay fields do not change'));
  end if;
  return new;
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

create or replace function booking.public_lodging_pay(p_code text)
returns jsonb language sql stable as $$
  select jsonb_build_object('pay', r.lodging_pay_mode, 'pay_options', booking.pay_options_of(r),
           'hold_hours', case when r.lodging_pay_mode = 'hold' or (r.lodging_pay_mode = 'online' and r.lodging_pay_on_site) then r.lodging_hold_hours end,
           'hold_minutes', case when r.lodging_pay_mode = 'online' then r.lodging_online_minutes end)
    from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.deleted_at is null and e.public_code = upper(btrim(coalesce(p_code, '')))
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
