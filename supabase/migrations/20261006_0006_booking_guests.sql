-- Booking · huéspedes, restricciones alimentarias, checklist y proyección para Food. Toca solo el schema booking.
-- Referencia: docs/booking/API.md §2.3 a §2.6, §4.2, §6 y §7.1.

-- ---------------------------------------------------------------------------
-- Huéspedes (datos del anexo I del RD 933/2021; reader no recibe la tabla y la Edge filtra por scopes.guests)
-- ---------------------------------------------------------------------------
create table booking.guests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  event_id uuid not null references booking.events(id),
  first_name text not null check (length(btrim(first_name)) between 1 and 120),
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
  guardian_name text check (guardian_name is null or length(guardian_name) <= 200),
  kinship text check (kinship is null or length(kinship) <= 80),
  signed_at timestamptz,
  signed_by_name text check (signed_by_name is null or length(signed_by_name) <= 200),
  signature_file_id uuid references core.files(id),
  data_status text not null default 'pendiente_datos' check (data_status in ('pendiente_datos','datos_incompletos','datos_recibidos','datos_revisados','no_aplica')),
  ses_status text not null default 'pendiente_envio' check (ses_status in ('pendiente_envio','listo_para_envio','enviado_SES','incidencia_envio','no_aplica')),
  ses_sent_at timestamptz,
  ses_sent_by text check (ses_sent_by is null or length(ses_sent_by) <= 200),
  ses_receipt_ref text check (ses_receipt_ref is null or length(ses_receipt_ref) <= 500),
  ses_receipt_file_id uuid references core.files(id),
  notes text,
  constraint guests_sent_needs_date check (ses_status <> 'enviado_SES' or ses_sent_at is not null),
  constraint guests_ready_needs_review check (ses_status <> 'listo_para_envio' or data_status = 'datos_revisados'),
  constraint guests_signature_needs_date check (signature_file_id is null or signed_at is not null)
);
create index guests_event_idx on booking.guests (event_id) where deleted_at is null;
create trigger guests_assign_code before insert on booking.guests
  for each row execute function booking.assign_code('HSP');
create trigger guests_forbid_reparent before update on booking.guests
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes'],
  '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Restricciones alimentarias (de un huésped o de N personas sin identificar)
-- ---------------------------------------------------------------------------
create table booking.dietary_restrictions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  guest_id uuid references booking.guests(id),
  restriction_type text not null check (restriction_type in ('alergia','intolerancia','vegetariano','vegano','sin_gluten','sin_lactosa','preferencia','otra')),
  subject text check (subject is null or length(subject) <= 200),
  severity text check (severity is null or severity in ('grave','moderada','leve')),
  servings integer check (servings is null or servings >= 1),
  kitchen_notes text check (kitchen_notes is null or length(kitchen_notes) <= 2000),
  active boolean not null default true,
  constraint restrictions_guest_or_servings check ((guest_id is not null and servings is null) or (guest_id is null and servings is not null)),
  constraint restrictions_severity_scope check (severity is null or restriction_type in ('alergia','intolerancia')),
  constraint restrictions_subject_required check (restriction_type not in ('alergia','intolerancia','otra') or length(btrim(coalesce(subject, ''))) > 0)
);
create index dietary_restrictions_event_idx on booking.dietary_restrictions (event_id) where deleted_at is null;
create index dietary_restrictions_guest_idx on booking.dietary_restrictions (guest_id) where deleted_at is null and guest_id is not null;
create trigger dietary_restrictions_forbid_reparent before update on booking.dietary_restrictions
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'dietary_restrictions', array[
  'event_id','guest_id','restriction_type','subject','severity','servings','kitchen_notes','active']);

-- ---------------------------------------------------------------------------
-- Checklist ligero del evento
-- ---------------------------------------------------------------------------
create table booking.checklist_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  checklist_type text not null check (checklist_type in ('preparacion_general','alojamiento','cocina_comedor','salas','salida_rotacion')),
  label text not null check (length(btrim(label)) between 1 and 200),
  status text not null default 'pendiente' check (status in ('pendiente','hecho','no_aplica')),
  responsible_name text check (responsible_name is null or length(responsible_name) <= 200),
  reviewed_on date,
  notes text,
  position numeric not null default 0
);
create index checklist_items_event_idx on booking.checklist_items (event_id) where deleted_at is null;
create trigger checklist_items_forbid_reparent before update on booking.checklist_items
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'checklist_items', array[
  'event_id','checklist_type','label','status','responsible_name','reviewed_on','notes','position']);

-- ---------------------------------------------------------------------------
-- Contador de la proyección para Food: una fila por evento; su `revision` es el `event_revision` que ve cocina.
-- Tabla cerrada: nadie la lee ni la escribe por el núcleo; la mueven los triggers de abajo.
-- ---------------------------------------------------------------------------
create table booking.event_food_state (
  id uuid primary key references booking.events(id) on delete cascade,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz
);

select core.register_table('booking', 'booking', 'event_food_state', array[]::text[], '{}', '{}');

insert into booking.event_food_state (id) select id from booking.events on conflict do nothing;

create or replace function booking.food_state_touch(p_event uuid)
returns void language sql as $$
  update booking.event_food_state set updated_at = now() where id = p_event;
$$;

create or replace function booking.food_state_on_event()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into booking.event_food_state (id) values (new.id) on conflict do nothing;
  elsif (new.arrival_time, new.departure_time, new.final_guests, new.meal_plan_confirmed, new.menu_style_confirmed, new.deleted_at)
        is distinct from
        (old.arrival_time, old.departure_time, old.final_guests, old.meal_plan_confirmed, old.menu_style_confirmed, old.deleted_at) then
    perform booking.food_state_touch(new.id);
  end if;
  return null;
end $$;
create trigger events_food_state after insert or update on booking.events
  for each row execute function booking.food_state_on_event();

create or replace function booking.food_state_on_reservation()
returns trigger language plpgsql as $$
begin
  if (new.title, new.event_type, new.start_date, new.end_date, new.expected_guests, new.minors_count, new.requires_meals,
      new.meal_plan_requested, new.menu_style_requested, new.meal_notes, new.status, new.deleted_at)
     is distinct from
     (old.title, old.event_type, old.start_date, old.end_date, old.expected_guests, old.minors_count, old.requires_meals,
      old.meal_plan_requested, old.menu_style_requested, old.meal_notes, old.status, old.deleted_at) then
    perform booking.food_state_touch(e.id) from booking.events e where e.reservation_id = new.id;
  end if;
  return null;
end $$;
create trigger reservations_food_state after update on booking.reservations
  for each row execute function booking.food_state_on_reservation();

create or replace function booking.food_state_on_restriction()
returns trigger language plpgsql as $$
begin
  perform booking.food_state_touch(new.event_id);
  return null;
end $$;
create trigger dietary_restrictions_food_state after insert or update on booking.dietary_restrictions
  for each row execute function booking.food_state_on_restriction();

-- ---------------------------------------------------------------------------
-- Proyección para Food (contrato §8): sin huéspedes ni datos personales; restricciones agregadas y sin identificar.
-- ---------------------------------------------------------------------------
create view booking.food_event_projection as
select
  e.id as event_id,
  e.code as event_code,
  r.code as reservation_code,
  r.title,
  r.event_type,
  r.start_date,
  r.end_date,
  e.arrival_time,
  e.departure_time,
  coalesce(e.final_guests, r.expected_guests) as guest_count,
  r.minors_count,
  coalesce(e.meal_plan_confirmed, r.meal_plan_requested) as meal_plan,
  coalesce(e.menu_style_confirmed, r.menu_style_requested) as menu_style,
  coalesce((
    select jsonb_agg(jsonb_build_object('type', x.restriction_type, 'subject', x.subject, 'severity', x.severity, 'servings', x.servings, 'kitchen_notes', x.kitchen_notes)
                     order by x.restriction_type, x.subject nulls first, x.severity nulls first, x.kitchen_notes nulls first)
    from (
      select d.restriction_type, nullif(lower(btrim(d.subject)), '') as subject, d.severity,
             nullif(btrim(d.kitchen_notes), '') as kitchen_notes, sum(coalesce(d.servings, 1))::int as servings
      from booking.dietary_restrictions d
      where d.event_id = e.id and d.active and d.deleted_at is null
      group by 1, 2, 3, 4) x), '[]'::jsonb) as dietary_restrictions,
  s.revision as event_revision,
  r.status as reservation_status,
  (e.final_guests is not null) as guest_count_is_final,
  r.requires_meals,
  r.meal_notes
from booking.events e
join booking.reservations r on r.id = e.reservation_id
join booking.event_food_state s on s.id = e.id
where e.deleted_at is null and r.deleted_at is null;

revoke all on booking.food_event_projection from public, anon, authenticated;
grant select on booking.food_event_projection to service_role;

-- Food la lee con GET /api/v1/read/booking.food_event_projection. La app food se registra aquí por si su migración va después.
select core.ensure_app('food', 'Ikisai Food');
select core.allow_read('food', 'booking.food_event_projection', 'view');
select core.allow_read('booking', 'booking.food_event_projection', 'view');

-- ---------------------------------------------------------------------------
-- Recuentos de huéspedes sin identificar, para quien no puede leer la tabla
-- ---------------------------------------------------------------------------
create or replace function booking.guest_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid; v_out jsonb;
begin
  begin v_event := (p->'args'->>'event_id')::uuid; exception when others then v_event := null; end;
  if v_event is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'event_id must be a uuid')); end if;
  if not exists (select 1 from booking.events where id = v_event and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.events', 'id', v_event));
  end if;
  select jsonb_build_object(
      'eventId', v_event,
      'total', count(*),
      'bySex', jsonb_build_object('H', count(*) filter (where g.sex = 'H'), 'M', count(*) filter (where g.sex = 'M'),
                                  'X', count(*) filter (where g.sex = 'X'), 'sinDato', count(*) filter (where g.sex is null)),
      'minors', count(*) filter (where g.is_minor),
      'signed', count(*) filter (where g.signed_at is not null),
      'dataStatus', coalesce((select jsonb_object_agg(a.data_status, a.n) from (
          select data_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null group by 1) a), '{}'::jsonb),
      'sesStatus', coalesce((select jsonb_object_agg(b.ses_status, b.n) from (
          select ses_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null group by 1) b), '{}'::jsonb))
    into v_out
    from booking.guests g where g.event_id = v_event and g.deleted_at is null;
  return v_out;
end $$;

select core.allow_read('booking', 'booking.guest_summary', 'function');

-- ---------------------------------------------------------------------------
-- Invariantes: se amplían con los hijos del evento
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

  select g.id into v_id from booking.guests g join booking.events e on e.id = g.event_id
   where g.deleted_at is null and e.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.guests', 'id', v_id)); end if;

  select d.id into v_id from booking.dietary_restrictions d join booking.events e on e.id = d.event_id
   where d.deleted_at is null and e.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.dietary_restrictions', 'id', v_id)); end if;

  select c.id into v_id from booking.checklist_items c join booking.events e on e.id = c.event_id
   where c.deleted_at is null and e.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.checklist_items', 'id', v_id)); end if;

  select d.id into v_id from booking.dietary_restrictions d join booking.guests g on g.id = d.guest_id
   where d.deleted_at is null and (g.deleted_at is not null or g.event_id <> d.event_id) limit 1;
  if v_id is not null then perform core.fail('GUEST_MISMATCH', 422, jsonb_build_object('id', v_id)); end if;
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
