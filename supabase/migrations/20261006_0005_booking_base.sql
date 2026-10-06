-- Booking · base: app registrada, reservas, importes de la reserva y evento operativo. Toca solo el schema booking.
-- Referencia: docs/booking/API.md §2.1, §2.1.1, §2.2, §3.1 y §4.2.
select core.ensure_app('booking', 'Ikisai Booking', 'booking.ikisai.com');

create schema if not exists booking;
revoke all on schema booking from public;
revoke all on schema booking from anon, authenticated;
grant usage on schema booking to service_role;

-- ---------------------------------------------------------------------------
-- Funciones de apoyo
-- ---------------------------------------------------------------------------
-- Código humano (RSV_2026_001) al insertar. El prefijo llega como argumento del trigger; el año es el de alta en Madrid.
create or replace function booking.assign_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then
    new.code := core.next_code(tg_argv[0], extract(year from (now() at time zone 'Europe/Madrid'))::int);
  end if;
  return new;
end $$;

-- Impide cambiar la columna de enlace con el padre (argumento del trigger) después del alta.
create or replace function booking.forbid_reparent()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) ->> tg_argv[0]) is distinct from (to_jsonb(old) ->> tg_argv[0]) then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', tg_table_schema || '.' || tg_table_name, 'field', tg_argv[0]));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Reservas
-- ---------------------------------------------------------------------------
create table booking.reservations (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  title text not null check (length(btrim(title)) between 1 and 200),
  event_type text not null default 'retiro' check (event_type in ('retiro','convivencia','formacion','encuentro','actividad_divulgativa','alquiler_grupo','otro')),
  status text not null default 'en_estudio' check (status in ('en_estudio','negociacion','pre_reservada','confirmada','en_ejecucion','cerrada','cancelada','perdida')),
  priority text not null default 'media' check (priority in ('alta','media','baja')),
  start_date date,
  end_date date,
  expected_guests integer check (expected_guests is null or expected_guests >= 0),
  minors_count integer not null default 0 check (minors_count >= 0),
  contact_name text check (contact_name is null or length(contact_name) <= 200),
  contact_phone text check (contact_phone is null or length(contact_phone) <= 40),
  contact_email text check (contact_email is null or length(contact_email) <= 320),
  customer_type text check (customer_type is null or customer_type in ('particular','empresa','asociacion','colectivo','organizador_recurrente')),
  uses_accommodation boolean not null default true,
  requires_meals boolean not null default false,
  meal_plan_requested text check (meal_plan_requested is null or meal_plan_requested in ('no_aplica','desayuno','media_pension','pension_completa','segun_programa')),
  menu_style_requested text check (menu_style_requested is null or menu_style_requested in ('vegetariano','vegano','mixto','otro')),
  meal_notes text,
  uses_interpretation_center boolean not null default false,
  uses_outdoors boolean not null default false,
  uses_pool boolean not null default false,
  special_setup boolean not null default false,
  technical_support boolean not null default false,
  customer_notes text,
  briefing_received boolean not null default false,
  internal_notes text,
  archived_at timestamptz,
  constraint reservations_dates_order check (start_date is null or end_date is null or end_date >= start_date),
  constraint reservations_minors_within_guests check (expected_guests is null or minors_count <= expected_guests),
  constraint reservations_dates_required check (
    status in ('en_estudio','negociacion','cancelada','perdida')
    or (start_date is not null and end_date is not null and expected_guests is not null))
);
create index reservations_start_idx on booking.reservations (start_date) where deleted_at is null;
create index reservations_status_idx on booking.reservations (status) where deleted_at is null;
create index reservations_title_idx on booking.reservations (lower(title)) where deleted_at is null;
create trigger reservations_assign_code before insert on booking.reservations
  for each row execute function booking.assign_code('RSV');

select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at']);

-- ---------------------------------------------------------------------------
-- Importes y datos de pago de la reserva (reader no la recibe). Mismo id que la reserva.
-- ---------------------------------------------------------------------------
create table booking.reservation_finance (
  id uuid primary key references booking.reservations(id),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  budget_amount numeric(12,2) check (budget_amount is null or budget_amount >= 0),
  final_amount numeric(12,2) check (final_amount is null or final_amount >= 0),
  deposit_required numeric(12,2) check (deposit_required is null or deposit_required >= 0),
  deposit_paid numeric(12,2) check (deposit_paid is null or deposit_paid >= 0),
  payment_type text check (payment_type is null or payment_type in ('efectivo','tarjeta','transferencia','plataforma_pago','otro')),
  payment_date date,
  payment_holder text check (payment_holder is null or length(payment_holder) <= 200)
);

select core.register_table('booking', 'booking', 'reservation_finance', array[
  'budget_amount','final_amount','deposit_required','deposit_paid','payment_type','payment_date','payment_holder'],
  '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Evento operativo (0..1 por reserva; lo crea booking.confirm_reservation)
-- ---------------------------------------------------------------------------
create table booking.events (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  reservation_id uuid not null references booking.reservations(id),
  responsible_name text check (responsible_name is null or length(responsible_name) <= 200),
  arrival_time time,
  departure_time time,
  final_guests integer check (final_guests is null or final_guests >= 0),
  meal_plan_confirmed text check (meal_plan_confirmed is null or meal_plan_confirmed in ('no_aplica','desayuno','media_pension','pension_completa','segun_programa')),
  menu_style_confirmed text check (menu_style_confirmed is null or menu_style_confirmed in ('vegetariano','vegano','mixto','otro')),
  room_distribution text,
  rooms_count integer check (rooms_count is null or rooms_count >= 0),
  setup_style text check (setup_style is null or setup_style in ('no_aplica','basico','circulo','formacion','escenario','personalizado')),
  technical_needs text check (technical_needs is null or technical_needs in ('ninguna','wifi','sonido','proyeccion','mixto','personalizado')),
  reinforced_cleaning boolean not null default false,
  extra_support boolean not null default false,
  preparation_status text not null default 'pendiente' check (preparation_status in ('pendiente','en_proceso','hecha')),
  accommodation_status text not null default 'pendiente' check (accommodation_status in ('no_aplica','pendiente','en_proceso','hecho')),
  kitchen_status text not null default 'pendiente' check (kitchen_status in ('no_aplica','pendiente','en_proceso','hecho')),
  cleaning_status text not null default 'pendiente' check (cleaning_status in ('pendiente','en_proceso','hecha')),
  traveler_registration_status text not null default 'pendiente' check (traveler_registration_status in ('no_aplica','pendiente','en_curso','completo')),
  operational_notes text,
  closed_at timestamptz,
  incidents text,
  post_event_notes text
);
-- Único también contra eventos en la papelera: confirmar de nuevo restaura el mismo evento.
create unique index events_reservation_uidx on booking.events (reservation_id);
create trigger events_assign_code before insert on booking.events
  for each row execute function booking.assign_code('EVT');
create trigger events_forbid_reparent before update on booking.events
  for each row execute function booking.forbid_reparent('reservation_id');

select core.register_table('booking', 'booking', 'events', array[
  'reservation_id','responsible_name','arrival_time','departure_time','final_guests',
  'meal_plan_confirmed','menu_style_confirmed','room_distribution','rooms_count','setup_style','technical_needs',
  'reinforced_cleaning','extra_support','preparation_status','accommodation_status','kitchen_status','cleaning_status',
  'traveler_registration_status','operational_notes','closed_at','incidents','post_event_notes']);

-- ---------------------------------------------------------------------------
-- Procedimiento: confirmar una reserva y garantizar su evento operativo
-- ---------------------------------------------------------------------------
-- p = { app, actor, role, requestId, cursor, args: { reservation_id, event_id, from_status, expectedRevision? } }
create or replace function booking.confirm_reservation(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_request text := p->>'requestId';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_from text := v_args->>'from_status';
  v_id uuid; v_event_id uuid; v_expected bigint; v_code text;
  v_res booking.reservations; v_evt booking.events;
  v_missing text[] := '{}'; v_created boolean := false;
begin
  begin v_id := (v_args->>'reservation_id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id must be a uuid')); end if;
  if v_from is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'from_status required')); end if;

  select * into v_res from booking.reservations where id = v_id for update;
  if v_res.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', v_id)); end if;
  if v_res.deleted_at is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', 'booking.reservations', 'id', v_id)); end if;
  if v_res.status in ('cancelada','perdida') or v_res.archived_at is not null then
    perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('id', v_id, 'status', v_res.status, 'archived', v_res.archived_at is not null));
  end if;
  if v_res.status <> v_from and v_res.status <> 'confirmada' then
    perform core.fail('STATUS_CHANGED', 409, jsonb_build_object('id', v_id, 'expectedStatus', v_from, 'currentStatus', v_res.status, 'currentRevision', v_res.revision));
  end if;
  if v_res.start_date is null then v_missing := array_append(v_missing, 'start_date'); end if;
  if v_res.end_date is null then v_missing := array_append(v_missing, 'end_date'); end if;
  if v_res.expected_guests is null then v_missing := array_append(v_missing, 'expected_guests'); end if;
  if array_length(v_missing, 1) is not null then
    perform core.fail('CONFIRM_REQUIREMENTS', 422, jsonb_build_object('id', v_id, 'missing', to_jsonb(v_missing)));
  end if;

  select * into v_evt from booking.events where reservation_id = v_id for update;
  if v_evt.id is null then
    begin v_event_id := (v_args->>'event_id')::uuid; exception when others then v_event_id := null; end;
    if v_event_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'event_id must be a uuid')); end if;
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor,
      jsonb_build_object('op', 'insert', 'table', 'booking.events', 'id', v_event_id, 'fields', jsonb_build_object('reservation_id', v_id)));
    v_created := true;
  else
    v_event_id := v_evt.id;
    if v_evt.deleted_at is not null then
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor,
        jsonb_build_object('op', 'restore', 'table', 'booking.events', 'id', v_evt.id, 'expectedRevision', v_evt.revision));
    end if;
  end if;

  if v_res.status <> 'confirmada' then
    v_expected := coalesce((v_args->>'expectedRevision')::bigint, v_res.revision);
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor,
      jsonb_build_object('op', 'update', 'table', 'booking.reservations', 'id', v_id, 'expectedRevision', v_expected, 'fields', jsonb_build_object('status', 'confirmada')));
  end if;

  select code into v_code from booking.events where id = v_event_id;
  return jsonb_build_object('reservation_id', v_id, 'event_id', v_event_id, 'event_code', v_code, 'created', v_created, 'status', 'confirmada');
end $$;

select core.allow_procedure('booking', 'booking.confirm_reservation');

-- ---------------------------------------------------------------------------
-- Invariantes entre tablas, comprobadas al final de cada lote
-- ---------------------------------------------------------------------------
create or replace function booking.check_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select r.id into v_id from booking.reservations r
   where r.deleted_at is null and r.status in ('confirmada','en_ejecucion','cerrada')
     and not exists (select 1 from booking.events e where e.reservation_id = r.id and e.deleted_at is null)
   limit 1;
  if v_id is not null then perform core.fail('EVENT_REQUIRED', 422, jsonb_build_object('reservation_id', v_id)); end if;

  select e.id into v_id from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_EVENT', 422, jsonb_build_object('event_id', v_id)); end if;

  select f.id into v_id from booking.reservation_finance f join booking.reservations r on r.id = f.id
   where f.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_FINANCE', 422, jsonb_build_object('reservation_id', v_id)); end if;
end $$;

select core.add_validate_hook('booking', 'booking.check_invariants');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
