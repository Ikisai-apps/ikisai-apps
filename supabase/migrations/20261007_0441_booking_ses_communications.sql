-- Ikisai Booking · SES.HOSPEDAJES, paso 2: comunicación de la reserva (RH) con botón tras el pago, anulación y estados
-- (docs/booking/API.md §17.2 y §17.4; decisiones del usuario en coordinacion/ampliacion/SES.md §0). Toca solo el schema booking.
-- Como la cola de Calendar: tablas cerradas que escriben solo acciones del sistema; la interfaz lee el estado con una función.

-- ---------------------------------------------------------------------------
-- Momento legal del plazo: cuándo se registró el pago en la app (no la fecha del pago, que puede ser anterior)
-- ---------------------------------------------------------------------------
alter table booking.reservation_finance add column payment_registered_at timestamptz;

create or replace function booking.finance_payment_registered()
returns trigger language plpgsql as $$
begin
  if new.payment_date is not null and (tg_op = 'INSERT' or old.payment_date is null) then
    new.payment_registered_at := now();
  elsif new.payment_date is null then
    new.payment_registered_at := null;
  elsif tg_op = 'UPDATE' then
    new.payment_registered_at := old.payment_registered_at;
  end if;
  return new;
end $$;
create trigger reservation_finance_payment_registered before insert or update on booking.reservation_finance
  for each row execute function booking.finance_payment_registered();

-- ---------------------------------------------------------------------------
-- Comunicaciones y llamadas al servicio (sin XML ni SOAP: solo la huella del contenido)
-- ---------------------------------------------------------------------------
create table booking.ses_communications (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  kind text not null check (kind in ('RH','PV','anulacion')),
  guest_ids uuid[],
  cancels_id uuid references booking.ses_communications(id),
  environment text not null check (environment in ('pre','prod')),
  status text not null default 'preparada' check (status in ('preparada','enviando','en_proceso','aceptada','rechazada','anulada','error')),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  -- lo comunicado (fechas y personas), para avisar si la reserva cambió después; sin datos personales
  snapshot jsonb not null default '{}'::jsonb,
  lot_id text check (lot_id is null or length(lot_id) <= 36),
  ses_code text check (ses_code is null or length(ses_code) <= 36),
  error_code text check (error_code is null or length(error_code) <= 40),
  error_text text check (error_text is null or length(error_text) <= 300),
  legal_start_at timestamptz,
  requested_by uuid references auth.users(id),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  sent_at timestamptz,
  accepted_at timestamptz,
  cancelled_at timestamptz
);
create index ses_communications_reservation_idx on booking.ses_communications (reservation_id, created_at desc);
create index ses_communications_due_idx on booking.ses_communications (status, next_attempt_at) where status in ('preparada','en_proceso','error');
-- como mucho una comunicación de reserva viva (no rechazada ni anulada) por reserva
create unique index ses_communications_one_rh on booking.ses_communications (reservation_id)
  where kind = 'RH' and status in ('preparada','enviando','en_proceso','aceptada','error');
select core.register_table('booking', 'booking', 'ses_communications', array[]::text[], '{}', '{}');

create table booking.ses_attempts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  communication_id uuid not null references booking.ses_communications(id),
  operation text not null check (operation in ('comunicacion','consultaLote','anulacion')),
  http_status integer,
  outcome text not null check (length(outcome) <= 40),
  lot_id text check (lot_id is null or length(lot_id) <= 36),
  error_code text check (error_code is null or length(error_code) <= 40)
);
create index ses_attempts_communication_idx on booking.ses_attempts (communication_id, created_at);
select core.register_table('booking', 'booking', 'ses_attempts', array[]::text[], '{}', '{}');

-- ---------------------------------------------------------------------------
-- Datos para preparar la comunicación de la reserva. Falla con un código claro si no se puede comunicar todavía.
-- ---------------------------------------------------------------------------
create or replace function booking.ses_reservation_source(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_id uuid; v_r booking.reservations; v_f booking.reservation_finance; v_e booking.events; v_s booking.ses_settings;
begin
  begin v_id := (p->'args'->>'reservation_id')::uuid; exception when others then v_id := null; end;
  select * into v_r from booking.reservations where id = v_id and deleted_at is null;
  if v_r.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', p->'args'->>'reservation_id')); end if;
  if not v_r.ses_enabled then perform core.fail('SES_DISABLED', 422, jsonb_build_object('reservation_id', v_id)); end if;
  if v_r.status not in ('confirmada','en_ejecucion','cerrada') then perform core.fail('SES_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_id, 'status', v_r.status)); end if;
  select * into v_f from booking.reservation_finance where id = v_id and deleted_at is null;
  if v_f.payment_registered_at is null then perform core.fail('SES_PAYMENT_REQUIRED', 422, jsonb_build_object('reservation_id', v_id)); end if;
  select * into v_e from booking.events where reservation_id = v_id and deleted_at is null;
  select * into v_s from booking.ses_settings where deleted_at is null limit 1;
  return jsonb_build_object(
    'reservation', jsonb_build_object('id', v_r.id, 'code', v_r.code, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
      'persons', coalesce(v_e.final_guests, v_r.expected_guests), 'contact_name', v_r.contact_name, 'contact_phone', v_r.contact_phone,
      'contact_email', v_r.contact_email, 'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time, 'rooms', v_e.rooms_count),
    'payment', jsonb_build_object('type', v_f.payment_type, 'date', v_f.payment_date, 'holder', v_f.payment_holder,
      'registered_at', v_f.payment_registered_at, 'contract_date', (v_f.payment_registered_at at time zone 'Europe/Madrid')::date),
    'settings', jsonb_build_object('environment', coalesce(v_s.environment, 'pre'), 'paused', coalesce(v_s.paused, false)));
end $$;

-- ---------------------------------------------------------------------------
-- Acciones del sistema (las llaman las rutas de la Edge tras comprobar el rol, y el tick)
-- ---------------------------------------------------------------------------
-- Registra una comunicación preparada (RH o anulación) y devuelve su id. Una sola RH viva por reserva.
create or replace function booking.ses_prepare(p jsonb)
returns jsonb language plpgsql as $$
declare v_a jsonb := p->'args'; v_id uuid; v_kind text := v_a->>'kind'; v_cancels uuid; v_reservation uuid;
begin
  v_reservation := (v_a->>'reservation_id')::uuid;
  if v_kind = 'anulacion' then
    v_cancels := (v_a->>'cancels_id')::uuid;
    if not exists (select 1 from booking.ses_communications where id = v_cancels and status = 'aceptada' and ses_code is not null and reservation_id = v_reservation) then
      perform core.fail('SES_NOT_CANCELLABLE', 422, jsonb_build_object('communication_id', v_cancels));
    end if;
    if exists (select 1 from booking.ses_communications where cancels_id = v_cancels and status in ('preparada','enviando','en_proceso','aceptada','error')) then
      perform core.fail('SES_ALREADY_CANCELLING', 409, jsonb_build_object('communication_id', v_cancels));
    end if;
  elsif exists (select 1 from booking.ses_communications where reservation_id = v_reservation and kind = 'RH'
                 and status in ('preparada','enviando','en_proceso','aceptada','error')) then
    perform core.fail('SES_ALREADY_COMMUNICATED', 409, jsonb_build_object('reservation_id', v_reservation));
  end if;
  insert into booking.ses_communications (reservation_id, kind, cancels_id, environment, content_sha256, snapshot, legal_start_at, requested_by, next_attempt_at)
  values (v_reservation, v_kind, v_cancels, v_a->>'environment', v_a->>'content_sha256', coalesce(v_a->'snapshot', '{}'::jsonb),
          nullif(v_a->>'legal_start_at', '')::timestamptz, nullif(v_a->>'requested_by', '')::uuid, now())
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- Pasa a «enviando» (reclamada para enviar ahora); null si otro proceso ya la tiene.
create or replace function booking.ses_claim(p jsonb)
returns jsonb language plpgsql as $$
declare v_row booking.ses_communications;
begin
  update booking.ses_communications set status = 'enviando', attempts = attempts + 1, next_attempt_at = now() + interval '2 minutes'
   where id = (p->'args'->>'id')::uuid and status in ('preparada','error')
  returning * into v_row;
  return case when v_row.id is null then 'null'::jsonb else to_jsonb(v_row) end;
end $$;

-- Resultado de una llamada: `submitted` (lote recibido), `accepted` (código asignado), `rejected` (error de SES con su texto),
-- `error` (red, credenciales o servicio: se reintenta con espera creciente), `in_progress` (sigue en proceso).
create or replace function booking.ses_report(p jsonb)
returns jsonb language plpgsql as $$
declare v_a jsonb := p->'args'; v_c booking.ses_communications; v_outcome text := v_a->>'outcome';
begin
  select * into v_c from booking.ses_communications where id = (v_a->>'id')::uuid for update;
  if v_c.id is null then return 'null'::jsonb; end if;
  insert into booking.ses_attempts (communication_id, operation, http_status, outcome, lot_id, error_code)
  values (v_c.id, coalesce(v_a->>'operation', 'comunicacion'), nullif(v_a->>'http_status', '')::int, v_outcome, v_a->>'lot_id', left(v_a->>'error_code', 40));
  if v_outcome = 'submitted' then
    update booking.ses_communications set status = 'en_proceso', lot_id = v_a->>'lot_id', sent_at = coalesce(sent_at, now()),
      error_code = null, error_text = null, next_attempt_at = now() + interval '1 minute' where id = v_c.id;
  elsif v_outcome = 'accepted' then
    update booking.ses_communications set status = 'aceptada', ses_code = v_a->>'ses_code', accepted_at = now(),
      error_code = null, error_text = null, next_attempt_at = null where id = v_c.id;
    if v_c.kind = 'anulacion' then
      update booking.ses_communications set status = 'anulada', cancelled_at = now() where id = v_c.cancels_id;
    end if;
  elsif v_outcome = 'rejected' then
    update booking.ses_communications set status = 'rechazada', error_code = left(v_a->>'error_code', 40), error_text = left(v_a->>'error_text', 300),
      next_attempt_at = null where id = v_c.id;
  elsif v_outcome = 'in_progress' then
    update booking.ses_communications set next_attempt_at = now() + least(interval '30 minutes', interval '1 minute' * power(2, least(v_c.attempts, 5)))
     where id = v_c.id;
  elsif v_outcome = 'held' then
    -- envíos pausados o sin credenciales: queda preparada para el siguiente tick
    update booking.ses_communications set status = 'preparada', error_code = left(v_a->>'error_code', 40), next_attempt_at = now() + interval '5 minutes' where id = v_c.id;
  else
    update booking.ses_communications set status = 'error', error_code = left(v_a->>'error_code', 40), error_text = left(v_a->>'error_text', 300),
      next_attempt_at = now() + least(interval '1 hour', interval '1 minute' * power(2, least(v_c.attempts, 6))) where id = v_c.id;
  end if;
  return jsonb_build_object('id', v_c.id);
end $$;

-- Trabajo pendiente del tick: preparadas o con error para enviar, y en proceso para consultar su lote.
create or replace function booking.ses_due(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('cancels_code',
      (select o.ses_code from booking.ses_communications o where o.id = c.cancels_id)) order by c.next_attempt_at), '[]'::jsonb))
    from (select * from booking.ses_communications
           where status in ('preparada','en_proceso','error') and (next_attempt_at is null or next_attempt_at <= now())
           order by next_attempt_at nulls first limit greatest(1, least(coalesce((p->'args'->>'limit')::int, 10), 50))) c;
$$;

-- Estado para la ficha (editor y owner): comunicaciones de la reserva, sin intentos ni datos personales.
create or replace function booking.ses_status(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'environment', c.environment,
      'cancels_id', c.cancels_id, 'lot_id', c.lot_id, 'ses_code', c.ses_code, 'error_code', c.error_code, 'error_text', c.error_text,
      'legal_start_at', c.legal_start_at, 'snapshot', c.snapshot, 'attempts', c.attempts, 'sent_at', c.sent_at, 'accepted_at', c.accepted_at,
      'cancelled_at', c.cancelled_at, 'created_at', c.created_at) order by c.created_at desc), '[]'::jsonb))
    from booking.ses_communications c where c.reservation_id = (p->'args'->>'reservation_id')::uuid and c.deleted_at is null;
$$;

select core.allow_read('booking', 'booking.ses_reservation_source', 'function', '{editor,owner}');
select core.allow_read('booking', 'booking.ses_status', 'function', '{editor,owner}');
-- La misma fuente para el tick, sin usuario (acción del sistema).
create or replace function booking.ses_reservation_source_system(p jsonb)
returns jsonb language sql stable as $$ select booking.ses_reservation_source(p) $$;
select core.allow_read('booking', 'booking.ses_reservation_source_system', 'action', '{}');
select core.allow_read('booking', 'booking.ses_prepare', 'action', '{}');
select core.allow_read('booking', 'booking.ses_claim', 'action', '{}');
select core.allow_read('booking', 'booking.ses_report', 'action', '{}');
select core.allow_read('booking', 'booking.ses_due', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
