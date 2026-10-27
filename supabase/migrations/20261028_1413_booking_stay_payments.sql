-- Ikisai Booking · venta de noches en línea, tarjeta 1 (booking-22; análisis en
-- MUELA/equipo/feedback/booking/VENTA_EN_LINEA_ANALISIS.md). APAGADO POR DEFECTO: ningún evento lo usa hasta que se le pone
-- `lodging_pay_mode = 'online'`. Lo de la pasarela concreta (vg-38) va aparte.
-- - Modo `online` por evento: la solicitud retiene la cama `lodging_online_minutes` (20 por defecto) mientras se paga en
--   la página de la pasarela.
-- - `booking.stay_payments`: una fila por intento de pago (proveedor, referencia, importe, estado). Solo la escribe el
--   sistema (`booking.stay_payment_record`, una acción de sistema con `core.apply_system_operations`), con cada aviso de
--   la pasarela una sola vez (`last_event_id`).
--   - Al confirmarse el pago, la retención se alarga hasta la salida: la cama no se pierde aunque recepción tarde.
--   - El visitante ve `pagada` y recepción «Pagado en línea».
--   - Recepción aloja con `join_from_visitor({accept, method: 'online'})`, que solo vale si consta pagado.
--   - Que lo haga el servidor solo necesita que el núcleo deje a la cuenta de servicio de Booking escribir en Booking:
--     se pide a Core.
-- - El cobro y la devolución admiten el método `online`.
-- Toca solo el schema booking.

alter table booking.reservations drop constraint reservations_lodging_pay_mode_check;
alter table booking.reservations add constraint reservations_lodging_pay_mode_check check (lodging_pay_mode in ('hold', 'pay_first', 'online'));
alter table booking.reservations add column lodging_online_minutes integer not null default 20 check (lodging_online_minutes between 5 and 120);
select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive','organizer_notes',
  'guests_visible','public_summary','food_carta_ids','lodging_pay_mode','lodging_hold_hours','lodging_online_minutes']);

alter table booking.visitor_requests drop constraint visitor_requests_pay_mode_check;
alter table booking.visitor_requests add constraint visitor_requests_pay_mode_check check (pay_mode is null or pay_mode in ('hold', 'pay_first', 'online'));
alter table booking.walkin_charges drop constraint walkin_charges_method_check;
alter table booking.walkin_charges add constraint walkin_charges_method_check check (method is null or method in ('cash', 'bizum', 'bitcoin', 'card', 'online'));
alter table booking.walkin_charges drop constraint walkin_charges_refund_method_check;
alter table booking.walkin_charges add constraint walkin_charges_refund_method_check check (refund_method is null or refund_method in ('cash', 'bizum', 'bitcoin', 'card', 'online'));

create table booking.stay_payments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  request_id uuid not null references booking.visitor_requests(id),
  provider text not null check (provider ~ '^[a-z][a-z0-9_]{1,30}$'),
  provider_ref text not null check (char_length(provider_ref) between 1 and 200),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'expired', 'refunded', 'partially_refunded')),
  paid_at timestamptz,
  refunded_cents integer not null default 0 check (refunded_cents >= 0),
  fee_cents integer check (fee_cents is null or fee_cents >= 0),
  last_event_id text check (last_event_id is null or char_length(last_event_id) <= 200),
  -- la página de pago de la pasarela (para volver a ella sin crear otro intento)
  redirect_url text check (redirect_url is null or (redirect_url ~ '^https://' and char_length(redirect_url) <= 1000)),
  constraint stay_payments_refund_range check (refunded_cents <= amount_cents),
  constraint stay_payments_paid_at check ((status in ('paid', 'refunded', 'partially_refunded')) = (paid_at is not null))
);
create unique index stay_payments_provider_ref_uidx on booking.stay_payments (provider, provider_ref);
create unique index stay_payments_one_pending on booking.stay_payments (request_id) where status = 'pending' and deleted_at is null;
select core.register_table('booking', 'booking', 'stay_payments', array['request_id','provider','provider_ref','amount_cents','currency','status','paid_at',
  'refunded_cents','fee_cents','last_event_id','redirect_url'], '{editor,owner}', '{editor,owner}');

-- Solo el sistema (los avisos de la pasarela) escribe los pagos; nadie los cambia a mano.
create or replace function booking.stay_payment_guard()
returns trigger language plpgsql as $$
begin
  if core.current_role() is distinct from 'system' then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'booking.stay_payments', 'reason', 'only the payment provider (system) writes payments'));
  end if;
  return new;
end $$;
create trigger stay_payments_guard before insert or update on booking.stay_payments
  for each row execute function booking.stay_payment_guard();

-- La acción de sistema de los pagos (la llama la Edge con la clave de servicio, sin persona):
-- - {action: 'open', request_id, provider, provider_ref, amount_cents}: el intento de pago de una solicitud en línea viva;
-- - {action: 'event', provider, provider_ref, event_id, status: 'paid'|'failed'|'expired'|'refunded', refunded_cents?, fee_cents?}:
--   un aviso de la pasarela, una sola vez por `event_id`;
-- - {action: 'current', request_id}: el intento vivo, si lo hay.
create or replace function booking.stay_payment_record(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); q booking.visitor_requests; sp booking.stay_payments; r booking.reservations;
  v_status text; v_ops jsonb := '[]'::jsonb; v_id uuid;
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
    return jsonb_build_object('payment_id', sp.id, 'status', v_status, 'request_id', sp.request_id, 'replayed', false);
  end if;
  perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'action'));
end $$;
select core.allow_read('booking', 'booking.stay_payment_record', 'action', '{}');

-- La guarda de las solicitudes (1400) con la retención del modo en línea.
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
    new.pay_mode := r.lodging_pay_mode;
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

-- Aceptar (1401, envoltorio de 1408): 'online' solo con el pago confirmado.
create or replace function booking.join_from_visitor_base(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb); v_req booking.visitor_requests; v_guest uuid; v_name text; v_id uuid;
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_rid text := p->>'requestId'; v_cur bigint := (p->>'cursor')::bigint;
  v_beds uuid[]; v_left integer; v_n integer := 0; v_in integer; v_guests uuid[] := '{}'; v_assign uuid; v_night integer; v_nights integer;
  v_method text := nullif(v_args->>'method', ''); v_fields jsonb; t booking.stay_travelers;
  f record; b record;
begin
  begin v_id := (v_args->>'request_id')::uuid; exception when others then v_id := null; end;
  select * into v_req from booking.visitor_requests where id = v_id and deleted_at is null;
  if v_req.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests', 'id', v_args->>'request_id')); end if;
  if v_req.status <> 'pendiente' then return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'guest_id', v_req.guest_id); end if;
  perform set_config('booking.visitor_procedure', 'on', true);
  if v_req.kind = 'contact' and v_args->>'decision' in ('done', 'reject') then
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'decided_at', now())));
    perform set_config('booking.visitor_procedure', '', true);
    return jsonb_build_object('request_id', v_req.id, 'status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'guest_id', null);
  end if;
  if v_req.kind = 'contact' then
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision', 'reason', 'un dato se atiende o se descarta'));
  end if;
  if v_args->>'decision' = 'accept' then
    -- 'online' solo si la pasarela ha confirmado el pago de esta solicitud (1413)
    if v_method = 'online' and not exists (select 1 from booking.stay_payments sp where sp.request_id = v_req.id and sp.status = 'paid') then
      perform set_config('booking.visitor_procedure', '', true);
      perform core.fail('NOT_PAID_ONLINE', 409, jsonb_build_object('request_id', v_req.id));
    end if;
    if v_method is not null and v_method not in ('cash', 'bizum', 'bitcoin', 'card', 'online') then
      perform set_config('booking.visitor_procedure', '', true);
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'method'));
    end if;
    v_name := left(coalesce(nullif(btrim(v_args->>'name'), ''), v_req.name, 'Visitante'), 120);
    if v_req.kind <> 'stay' then
      v_guest := gen_random_uuid();
      perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
        jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_guest, 'fields', jsonb_build_object('event_id', v_req.event_id, 'first_name', v_name)));
    else
      -- una ficha por persona, con su borrador si lo hay (y el borrador se borra al pasarlo)
      for v_n in 1 .. v_req.persons loop
        v_id := gen_random_uuid();
        select * into t from booking.stay_travelers where request_id = v_req.id and position = v_n and deleted_at is null;
        v_fields := jsonb_strip_nulls(jsonb_build_object('event_id', v_req.event_id,
          'first_name', coalesce(nullif(btrim(t.first_name), ''), case when v_n = 1 then v_name else left(format('Acompañante %s de %s', v_n - 1, v_name), 120) end),
          'last_name_1', t.last_name_1, 'last_name_2', t.last_name_2, 'sex', t.sex, 'document_type', t.document_type, 'document_number', t.document_number,
          'document_support_number', t.document_support_number, 'nationality', t.nationality, 'birth_date', t.birth_date,
          'residence_address', t.residence_address, 'residence_postal_code', t.residence_postal_code, 'residence_city', t.residence_city,
          'residence_country', t.residence_country, 'phone', t.phone, 'email', t.email, 'kinship', t.kinship))
          || case when t.id is not null and t.is_minor then jsonb_build_object('is_minor', true) else '{}'::jsonb end;
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur, jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', v_fields));
        if t.id is not null then
          perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
            jsonb_build_object('op', 'delete', 'table', 'booking.stay_travelers', 'id', t.id, 'expectedRevision', t.revision));
        end if;
        v_guests := v_guests || v_id;
      end loop;
      v_guest := v_guests[1];
      -- las camas: las retenidas si el bloqueo sigue vivo; las elegidas si siguen libres; si no, las libres ahora
      if v_req.hold_until is not null and v_req.hold_until > now() and coalesce(cardinality(v_req.hold_bed_ids), 0) > 0 then
        v_beds := v_req.hold_bed_ids;
      elsif coalesce(cardinality(v_req.hold_bed_ids), 0) > 0
        and not exists (select 1 from unnest(v_req.hold_bed_ids) c(id) where c.id not in (select x.bed_id from booking.free_beds(v_req.from_date, v_req.to_date) x))
        and (select coalesce(sum(greatest(coalesce(bb.capacity, 1), 1)), 0) from booking.beds bb where bb.id = any (v_req.hold_bed_ids)) >= v_req.persons then
        v_beds := v_req.hold_bed_ids;
      else
        v_beds := '{}'; v_left := v_req.persons;
        for f in select * from booking.free_beds(v_req.from_date, v_req.to_date) order by space_id, bed_id loop
          exit when v_left <= 0;
          v_beds := v_beds || f.bed_id; v_left := v_left - f.places;
        end loop;
        if v_left > 0 then
          perform set_config('booking.visitor_procedure', '', true);
          perform core.fail('NO_AVAILABILITY', 409, jsonb_build_object('request_id', v_req.id, 'persons', v_req.persons));
        end if;
      end if;
      v_nights := v_req.to_date - v_req.from_date;
      v_night := v_req.total_cents / greatest(v_nights * v_req.persons, 1);
      v_left := v_req.persons; v_n := 1;
      for b in select bb.id, bb.space_id, greatest(coalesce(bb.capacity, 1), 1) as places from booking.beds bb where bb.id = any (v_beds) order by bb.space_id, bb.id loop
        exit when v_left <= 0;
        v_in := least(b.places, v_left);
        v_assign := gen_random_uuid();
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
          jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_assign, 'fields', jsonb_build_object(
            'event_id', v_req.event_id, 'space_id', b.space_id, 'bed_id', b.id, 'guest_id', v_guests[v_n], 'persons', v_in,
            'from_date', v_req.from_date, 'to_date', v_req.to_date)));
        perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
          jsonb_build_object('op', 'insert', 'table', 'booking.walkin_charges', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
            'event_id', v_req.event_id, 'assignment_id', v_assign, 'guest_id', v_guests[v_n], 'nights', v_nights,
            'price_cents', v_night * v_in, 'amount_cents', v_night * v_in * v_nights)
            || case when v_method is not null then jsonb_build_object('method', v_method, 'paid_at', now()) else '{}'::jsonb end));
        v_left := v_left - v_in; v_n := v_n + v_in;
      end loop;
    end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'aceptada', 'guest_id', v_guest, 'decided_at', now())));
  elsif v_args->>'decision' = 'reject' then
    perform core.apply_row_op(v_app, v_actor, v_role, v_rid, v_cur,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'descartada', 'decided_at', now())));
  else
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision'));
  end if;
  perform set_config('booking.visitor_procedure', '', true);
  return jsonb_build_object('request_id', v_req.id, 'status', case when v_guest is null then 'descartada' else 'aceptada' end, 'guest_id', v_guest);
end $$;

-- Estado para el visitante (1400): pagada en cuanto la pasarela lo confirma.
create or replace function booking.stay_status_of(q booking.visitor_requests)
returns text language sql stable as $$
  select case
    when q.kind <> 'stay' then null
    when q.status = 'descartada' then 'descartada'
    when q.status = 'pendiente' and exists (select 1 from booking.stay_payments sp where sp.request_id = q.id and sp.status = 'paid') then 'pagada'
    when q.status = 'pendiente' then case when q.pay_mode in ('hold', 'online') and (q.hold_until is null or q.hold_until <= now()) then 'caducada' else 'por_pagar' end
    when g.left_at is not null then 'salida'
    when g.arrived_at is not null then 'alojado'
    when exists (select 1 from booking.walkin_charges c where c.guest_id = q.guest_id and c.deleted_at is null and c.paid_at is not null) then 'pagada'
    else 'por_pagar' end
    from (select 1) one left join booking.guests g on g.id = q.guest_id
$$;

create or replace function booking.visitor_item(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', q.id, 'event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
           'created_at', q.created_at, 'decided_at', q.decided_at,
           'from', q.from_date, 'to', q.to_date, 'persons', q.persons, 'mode_id', q.rate_id, 'total_cents', q.total_cents, 'pay', q.pay_mode,
           'hold_until', q.hold_until, 'hold_expired', q.kind = 'stay' and q.pay_mode in ('hold', 'online') and q.status = 'pendiente' and (q.hold_until is null or q.hold_until <= now()),
           'number', q.number, 'stay_status', booking.stay_status_of(q), 'beds', booking.stay_beds_of(q),
           'paid_at', (select max(c.paid_at) from booking.walkin_charges c where q.guest_id is not null and c.guest_id = q.guest_id and c.deleted_at is null),
           'missing', booking.stay_missing_of(q),
           'paid_online', exists (select 1 from booking.stay_payments sp where sp.request_id = q.id and sp.status = 'paid'))
    from booking.events e where e.id = q.event_id
$$;

-- La oferta pública dice también los minutos que se guarda la plaza mientras se paga en línea.
create or replace function booking.public_lodging_pay(p_code text)
returns jsonb language sql stable as $$
  select jsonb_build_object('pay', r.lodging_pay_mode, 'hold_hours', case when r.lodging_pay_mode = 'hold' then r.lodging_hold_hours end,
           'hold_minutes', case when r.lodging_pay_mode = 'online' then r.lodging_online_minutes end)
    from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.deleted_at is null and e.public_code = upper(btrim(coalesce(p_code, '')))
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
