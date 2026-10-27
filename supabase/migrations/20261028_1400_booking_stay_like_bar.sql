-- Ikisai Booking · Alojamiento libre «como la barra» (VG 27-10-2026, por Core; contrato con Guests). Va sobre 0499.
-- El visitante, desde «Alójate aquí» de ven.ikisai.com:
-- - elige noches y cama (o se le asigna una);
-- - mete sus datos en borrador;
-- - pulsa «Ir a pagar» y recibe un NÚMERO corto, como el 142 de la barra;
-- - recepción busca el número, completa lo que falta, cobra y aloja (siguiente migración).
-- Lo que añade:
-- - `visitor_requests.number`: número corto por evento, solo en solicitudes de noches. Los lotes van en serie: no se repite.
-- - Cama elegida: el visitante manda `hold_bed_ids`. Tienen que estar libres TODAS las noches; si no, 409 `BED_TAKEN`. Si
--   no llegan a las personas, se completan solas. Sin elegir, todo se asigna solo, como en 0499.
--   - en `hold`, quedan retenidas el plazo del evento;
--   - en `pay_first`, quedan como preferencia, sin bloquear.
--   La modalidad (`rate_id`) pasa a ser opcional: sin ella, la primera que valga.
-- - `booking.stay_travelers`: el borrador de los datos del viajero, uno por persona de la solicitud, con los campos de
--   `booking.guests`.
--   - Lo escribe el visitante dueño en un lote público, mientras la solicitud está pendiente.
--   - Lo lee el personal con el ámbito de huéspedes: lo filtra la Edge, igual que `booking.guests`.
--   - Al alojar, se pasa a la ficha y se borra.
-- - `booking.draft_missing`: lo que falta para dormir; la misma regla que `missingForSes`.
-- - Lecturas públicas (de cliente):
--   - `booking_public_beds({event_code, from, to})`: habitaciones y camas con `free` (libre todas las noches) y el precio
--     por noche. Nunca personas;
--   - `booking_visitor_stay({event_code})`: la última solicitud de noches del visitante;
--   - `booking_visitor_requests`: añade `number`, `stay_status`, `beds`, `paid_at` y `missing` (por persona, solo nombres
--     de campo).
-- - `booking_stay_drafts` (solo servidor): ids y revisiones de los borradores del visitante, para actualizarlos.
-- Toca solo el schema booking.

alter table booking.visitor_requests add column number integer check (number is null or number between 1 and 99999);
create unique index visitor_requests_number_uidx on booking.visitor_requests (event_id, number) where number is not null;
select core.register_table('booking', 'booking', 'visitor_requests', array['event_id','via_code','visitor_id','kind','name','contact','note','status','guest_id','decided_at',
  'from_date','to_date','persons','rate_id','total_cents','pay_mode','hold_bed_ids','hold_until','number'],
  '{editor,owner}', '{editor,owner}');
alter table booking.visitor_requests drop constraint visitor_requests_stay_fields;
alter table booking.visitor_requests add constraint visitor_requests_stay_fields check (kind <> 'stay' or (from_date is not null and to_date > from_date and persons is not null and rate_id is not null and total_cents is not null and pay_mode is not null and number is not null));

create table booking.stay_travelers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  request_id uuid not null references booking.visitor_requests(id),
  position integer not null check (position between 1 and 20),
  first_name text check (first_name is null or length(btrim(first_name)) between 1 and 120),
  last_name_1 text check (last_name_1 is null or length(last_name_1) <= 120),
  last_name_2 text check (last_name_2 is null or length(last_name_2) <= 120),
  sex text check (sex is null or sex in ('H','M','X')),
  document_type text check (document_type is null or document_type in ('DNI','NIE','Pasaporte','TIE','Otro')),
  document_number text check (document_number is null or length(document_number) <= 40),
  document_support_number text check (document_support_number is null or length(document_support_number) <= 40),
  nationality text check (nationality is null or nationality ~ '^[A-Z]{3}$'),
  birth_date date,
  residence_address text check (residence_address is null or length(residence_address) <= 300),
  residence_postal_code text check (residence_postal_code is null or length(residence_postal_code) <= 20),
  residence_city text check (residence_city is null or length(residence_city) <= 120),
  residence_country text check (residence_country is null or residence_country ~ '^[A-Z]{3}$'),
  phone text check (phone is null or length(phone) <= 40),
  email text check (email is null or length(email) <= 320),
  is_minor boolean not null default false,
  kinship text check (kinship is null or length(kinship) <= 80)
);
create unique index stay_travelers_position_uidx on booking.stay_travelers (request_id, position) where deleted_at is null;
select core.register_table('booking', 'booking', 'stay_travelers', array['request_id','position','first_name','last_name_1','last_name_2','sex',
  'document_type','document_number','document_support_number','nationality','birth_date','residence_address','residence_postal_code',
  'residence_city','residence_country','phone','email','is_minor','kinship'], '{editor,owner}', '{editor,owner}');
select core.allow_public_write('booking', 'booking.stay_travelers');

create or replace function booking.stay_traveler_guard()
returns trigger language plpgsql as $$
declare q booking.visitor_requests;
begin
  if tg_op = 'UPDATE' and new.request_id is distinct from old.request_id then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.stay_travelers', 'field', 'request_id', 'reason', 'no se cambia'));
  end if;
  select * into q from booking.visitor_requests where id = new.request_id and deleted_at is null;
  if q.id is null or q.kind <> 'stay' then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests', 'id', new.request_id)); end if;
  if new.position > q.persons then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.stay_travelers', 'field', 'position')); end if;
  if core.is_public_batch() then
    -- el visitante solo escribe el borrador de su solicitud, y mientras está pendiente
    if q.visitor_id is distinct from core.current_visitor() then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'not your request')); end if;
    if q.status <> 'pendiente' or new.deleted_at is not null then perform core.fail('REQUEST_CLOSED', 409, jsonb_build_object('request_id', q.id, 'status', q.status)); end if;
  end if;
  new.first_name := nullif(btrim(new.first_name), '');
  new.document_number := nullif(upper(btrim(new.document_number)), '');
  return new;
end $$;
create trigger stay_travelers_guard before insert or update on booking.stay_travelers
  for each row execute function booking.stay_traveler_guard();

-- Lo que falta para dormir (la regla de `missingForSes`, en _domain/booking/guests.ts).
create or replace function booking.draft_missing(t booking.stay_travelers)
returns text[] language sql immutable as $$
  select array_remove(array[
    case when nullif(btrim(t.first_name), '') is null then 'first_name' end,
    case when nullif(btrim(t.last_name_1), '') is null then 'last_name_1' end,
    case when t.birth_date is null then 'birth_date' end,
    case when nullif(btrim(t.residence_address), '') is null then 'residence_address' end,
    case when nullif(btrim(t.residence_postal_code), '') is null then 'residence_postal_code' end,
    case when nullif(btrim(t.residence_city), '') is null then 'residence_city' end,
    case when nullif(btrim(t.residence_country), '') is null then 'residence_country' end,
    case when nullif(btrim(t.phone), '') is null and nullif(btrim(t.email), '') is null then 'contact' end,
    case when t.is_minor and nullif(btrim(t.kinship), '') is null then 'kinship' end,
    case when not t.is_minor and t.document_type is null then 'document_type' end,
    case when not t.is_minor and nullif(btrim(t.document_number), '') is null then 'document_number' end,
    case when t.document_type = 'DNI' and nullif(btrim(t.last_name_2), '') is null then 'last_name_2' end,
    case when t.document_type in ('DNI', 'NIE') and nullif(btrim(t.document_support_number), '') is null then 'document_support_number' end
  ]::text[], null)
$$;
-- Lo que falta de una persona sin borrador: todo
create or replace function booking.draft_missing_all()
returns text[] language sql immutable as $$
  select array['first_name','last_name_1','birth_date','residence_address','residence_postal_code','residence_city','residence_country','contact','document_type','document_number']::text[]
$$;

-- La guarda de 0499 con el número, la cama elegida y la modalidad opcional.
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
    if new.pay_mode = 'hold' then new.hold_until := now() + make_interval(hours => r.lodging_hold_hours); end if;
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

-- En pay_first las camas elegidas son preferencia: solo bloquean las de un `hold` vivo (como en 0499).

-- Habitaciones y camas para elegir, con su nombre público. Libre = libre todas las noches de [from, to).
create or replace function booking.public_beds(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_ev record; v_from date; v_to date; v_price integer;
begin
  select * into v_ev from booking.public_open_event(coalesce(p->>'event_code', p->>'code'));
  if v_ev.event_id is null or not v_ev.joinable then perform core.fail('NOT_FOUND', 404, jsonb_build_object('reason', 'event')); end if;
  if v_ev.kind <> 'jornadas_abiertas' then perform core.fail('NO_LODGING', 422, jsonb_build_object('reason', 'event does not sell nights')); end if;
  begin v_from := (p->>'from')::date; v_to := (p->>'to')::date;
  exception when others then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from/to')); end;
  if v_from is null or v_to is null or v_to <= v_from or v_from < v_ev.starts_on or v_to > v_ev.ends_on or v_to - v_from > 31 then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'from', 'starts_on', v_ev.starts_on, 'ends_on', v_ev.ends_on));
  end if;
  select round(x.amount * 100)::integer into v_price from booking.lodging_rates(v_ev.kind) x
   where (x.valid_from is null or x.valid_from <= v_from) and (x.valid_to is null or (v_to - 1) <= x.valid_to)
   order by x.position, x.name limit 1;
  return jsonb_build_object('nights', v_to - v_from, 'price_night_cents', v_price, 'rooms', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', coalesce(s.public_name, s.name), 'beds', (
        select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'kind', b.kind, 'places', greatest(coalesce(b.capacity, 1), 1),
                 'free', exists (select 1 from booking.free_beds(v_from, v_to) x where x.bed_id = b.id), 'resource_bed_id', b.resource_id)
                 order by b.position, b.label)
          from booking.beds b
         where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria' and not b.team_bed))
      order by s.position, coalesce(s.public_name, s.name))
      from booking.spaces s
     where s.deleted_at is null and s.active and s.bookable
       and exists (select 1 from booking.beds b where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria' and not b.team_bed)), '[]'::jsonb));
end $$;
select core.allow_public_read('booking_public_beds', 'booking.public_beds', true);

-- Estado de una solicitud de noches para el visitante (los valores del contrato con Guests).
create or replace function booking.stay_status_of(q booking.visitor_requests)
returns text language sql stable as $$
  select case
    when q.kind <> 'stay' then null
    when q.status = 'descartada' then 'descartada'
    when q.status = 'pendiente' then case when q.pay_mode = 'hold' and (q.hold_until is null or q.hold_until <= now()) then 'caducada' else 'por_pagar' end
    when g.left_at is not null then 'salida'
    when g.arrived_at is not null then 'alojado'
    when exists (select 1 from booking.walkin_charges c where c.guest_id = q.guest_id and c.deleted_at is null and c.paid_at is not null) then 'pagada'
    else 'por_pagar' end
    from (select 1) one left join booking.guests g on g.id = q.guest_id
$$;

create or replace function booking.stay_beds_of(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('room', coalesce(s.public_name, s.name), 'label', b.label) order by s.position, b.position, b.label), '[]'::jsonb)
    from booking.beds b join booking.spaces s on s.id = b.space_id
   where q.kind = 'stay' and b.id in (
     select unnest(q.hold_bed_ids) where q.status = 'pendiente'
     union
     select a.bed_id from booking.room_assignments a where q.status = 'aceptada' and a.guest_id = q.guest_id and a.deleted_at is null and a.bed_id is not null)
$$;

create or replace function booking.stay_missing_of(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select case when q.kind <> 'stay' or q.status <> 'pendiente' then '[]'::jsonb else coalesce((
    select jsonb_agg(to_jsonb(case when t.id is null then booking.draft_missing_all() else booking.draft_missing(t) end) order by n)
      from generate_series(1, q.persons) n
      left join booking.stay_travelers t on t.request_id = q.id and t.position = n and t.deleted_at is null), '[]'::jsonb) end
$$;

create or replace function booking.visitor_item(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', q.id, 'event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
           'created_at', q.created_at, 'decided_at', q.decided_at,
           'from', q.from_date, 'to', q.to_date, 'persons', q.persons, 'mode_id', q.rate_id, 'total_cents', q.total_cents, 'pay', q.pay_mode,
           'hold_until', q.hold_until, 'hold_expired', q.kind = 'stay' and q.pay_mode = 'hold' and q.status = 'pendiente' and (q.hold_until is null or q.hold_until <= now()),
           'number', q.number, 'stay_status', booking.stay_status_of(q), 'beds', booking.stay_beds_of(q),
           'paid_at', (select max(c.paid_at) from booking.walkin_charges c where q.guest_id is not null and c.guest_id = q.guest_id and c.deleted_at is null),
           'missing', booking.stay_missing_of(q))
    from booking.events e where e.id = q.event_id
$$;

create or replace function booking.visitor_requests_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(booking.visitor_item(q) order by q.created_at desc), '[]'::jsonb))
    from booking.visitor_requests q join booking.events e on e.id = q.event_id
   where q.deleted_at is null and q.visitor_id = nullif(p->>'visitor_id', '')::uuid
     and (nullif(p->>'event_code', '') is null or e.public_code = upper(btrim(p->>'event_code')))
$$;

-- La última solicitud de noches del visitante en ese evento (la que no está descartada, si la hay).
create or replace function booking.visitor_stay(p jsonb)
returns jsonb language sql stable as $$
  select booking.visitor_item(q)
    from booking.visitor_requests q join booking.events e on e.id = q.event_id
   where q.deleted_at is null and q.kind = 'stay' and q.visitor_id = nullif(p->>'visitor_id', '')::uuid
     and (nullif(p->>'event_code', '') is null or e.public_code = upper(btrim(p->>'event_code')))
   order by q.status = 'descartada', q.created_at desc
   limit 1
$$;
select core.allow_public_read('booking_visitor_stay', 'booking.visitor_stay', true);

-- Solo servidor: ids y revisiones de los borradores del visitante, para que la Edge los actualice.
create or replace function booking.stay_drafts_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('request', (select jsonb_build_object('id', q.id, 'persons', q.persons, 'status', q.status) from booking.visitor_requests q
           where q.id = nullif(p->>'request_id', '')::uuid and q.visitor_id = nullif(p->>'visitor_id', '')::uuid and q.kind = 'stay' and q.deleted_at is null),
         'items', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'position', t.position, 'revision', t.revision) order by t.position)
           from booking.stay_travelers t join booking.visitor_requests q on q.id = t.request_id
          where t.deleted_at is null and q.id = nullif(p->>'request_id', '')::uuid and q.visitor_id = nullif(p->>'visitor_id', '')::uuid), '[]'::jsonb))
$$;
select core.allow_public_read('booking_stay_drafts', 'booking.stay_drafts_of');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
