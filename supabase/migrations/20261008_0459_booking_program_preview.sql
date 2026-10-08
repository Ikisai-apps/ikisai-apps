-- Ikisai Booking · fases 4 y 5 de los portales, parte 1: programa del retiro (Organizers B16, Guests BG9) y huésped de
-- muestra para la vista previa del organizador (Guests BG11). BG12 ya estaba: `reservation_id` en `food_event_projection`
-- (0404). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Nombre público de un espacio (lo que ven organizador y huésped si no es el interno). Lo usan el programa y el alojamiento.
-- ---------------------------------------------------------------------------
alter table booking.spaces add column public_name text check (public_name is null or length(btrim(public_name)) between 1 and 120);
select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','bookable','position','notes','public_name']);

create or replace function booking.space_public_name(s booking.spaces)
returns text language sql immutable as $$ select coalesce(nullif(btrim(s.public_name), ''), s.name) $$;

-- ---------------------------------------------------------------------------
-- B16 / BG9 · programa del retiro: uno por evento, para los dos portales. Lo edita el organizador con acciones de portal y
-- el personal desde Booking.
-- ---------------------------------------------------------------------------
create table booking.program_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  day date not null,
  starts_at time,
  ends_at time,
  title text not null check (length(btrim(title)) between 1 and 120),
  space_id uuid references booking.spaces(id),
  place_text text check (place_text is null or length(place_text) <= 80),
  public_note text check (public_note is null or length(public_note) <= 500),
  internal_note text check (internal_note is null or length(internal_note) <= 2000),
  kind text not null default 'actividad' check (kind in ('actividad','comida','descanso','otro')),
  optional boolean not null default false,
  position numeric not null default 0,
  constraint program_items_place check (space_id is null or place_text is null),
  constraint program_items_times check (ends_at is null or (starts_at is not null and ends_at > starts_at))
);
create index program_items_event_idx on booking.program_items (event_id, day, starts_at, position) where deleted_at is null;
create trigger program_items_forbid_reparent before update on booking.program_items
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'program_items', array['event_id','day','starts_at','ends_at','title','space_id','place_text',
  'public_note','internal_note','kind','optional','position']);

-- El día cae dentro de las fechas de la reserva y el espacio está vivo. En la fila y no en un hook de lote: cambiar después
-- las fechas de la reserva no debe bloquearse por el programa (la ficha avisa de lo que queda fuera).
create or replace function booking.program_item_check()
returns trigger language plpgsql as $$
declare v_r booking.reservations;
begin
  if new.deleted_at is not null then return new; end if;
  select r.* into v_r from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = new.event_id;
  if v_r.start_date is not null and v_r.end_date is not null and (new.day < v_r.start_date or new.day > v_r.end_date)
     and (tg_op = 'INSERT' or new.day is distinct from old.day) then
    perform core.fail('PROGRAM_DAY_OUT_OF_RANGE', 422, jsonb_build_object('table', 'booking.program_items', 'id', new.id, 'day', new.day));
  end if;
  if new.space_id is not null and not exists (select 1 from booking.spaces s where s.id = new.space_id and s.deleted_at is null and s.active) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.program_items', 'field', 'space_id'));
  end if;
  return new;
end $$;
create trigger program_items_check before insert or update on booking.program_items
  for each row execute function booking.program_item_check();

-- Reserva del ámbito del actor para lecturas comunes a los dos portales: el organizador por la reserva; el huésped, si
-- alguno de los huéspedes de esa reserva es suyo.
create or replace function booking.portal_scope_reservation(p jsonb)
returns booking.reservations language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations; v_actor uuid := (p->>'actor')::uuid; v_ok boolean;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if p->>'app' = 'guests' then
    v_ok := v_res is not null and exists (select 1 from booking.guests g join booking.events e on e.id = g.event_id
      where e.reservation_id = v_res and g.deleted_at is null and booking.portal_in_scope('guests', v_actor, v_res, g.id));
  else
    v_ok := v_res is not null and booking.portal_in_scope(p->>'app', v_actor, v_res, null);
  end if;
  if not coalesce(v_ok, false) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id')); end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  return v_r;
end $$;

-- `revision`: suma de las revisiones de todas las filas del programa (también las borradas), que crece con cada cambio.
create or replace function booking.portal_program(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_e booking.events; v_org boolean := p->>'app' = 'organizers';
begin
  v_r := booking.portal_scope_reservation(p);
  select * into v_e from booking.events where reservation_id = v_r.id and deleted_at is null;
  return jsonb_build_object(
    'revision', coalesce((select sum(i.revision) from booking.program_items i where i.event_id = v_e.id), 0),
    'confirmed', v_e.id is not null, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'revision', i.revision, 'day', i.day,
        'starts_at', to_char(i.starts_at, 'HH24:MI'), 'ends_at', to_char(i.ends_at, 'HH24:MI'), 'title', i.title,
        'place', coalesce(booking.space_public_name(s), i.place_text), 'space_id', i.space_id, 'place_text', i.place_text,
        'public_note', i.public_note, 'kind', i.kind, 'position', i.position)
        || case when v_org then jsonb_build_object('internal_note', i.internal_note) else '{}'::jsonb end
        order by i.day, i.starts_at nulls first, i.position)
      from booking.program_items i left join booking.spaces s on s.id = i.space_id
     where i.event_id = v_e.id and i.deleted_at is null), '[]'::jsonb))
    || case when v_org then jsonb_build_object('spaces', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', booking.space_public_name(s), 'kind', s.kind, 'zone', s.zone)
        order by s.kind <> 'sala', s.zone nulls last, s.position)
      from booking.spaces s where s.deleted_at is null and s.active and s.kind <> 'habitacion'), '[]'::jsonb)) else '{}'::jsonb end;
end $$;

create or replace function booking.portal_program_event(p jsonb)
returns booking.events language plpgsql stable as $$
declare v_r booking.reservations; v_e booking.events;
begin
  v_r := booking.portal_reservation_row(p);
  if v_r.status in ('cancelada','perdida') then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_r.id)); end if;
  select * into v_e from booking.events where reservation_id = v_r.id and deleted_at is null;
  if v_e.id is null then perform core.fail('EVENT_REQUIRED', 422, jsonb_build_object('reservation_id', v_r.id)); end if;
  return v_e;
end $$;

-- Alta o cambio de una actividad (guardado automático del organizador). Responde `{id, revision}`.
create or replace function booking.portal_program_save(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_item jsonb := coalesce(p->'args'->'item', '{}'::jsonb);
  v_id uuid; v_old booking.program_items; v_fields jsonb := '{}'::jsonb; v_key text; v_out jsonb;
begin
  begin v_id := (v_item->>'id')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'item.id debe ser un uuid')); end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'item.id es obligatorio (lo genera el cliente)')); end if;
  foreach v_key in array array['day','starts_at','ends_at','title','space_id','place_text','public_note','internal_note','kind','position'] loop
    if v_item ? v_key then v_fields := v_fields || jsonb_build_object(v_key, case when v_item->v_key = '""'::jsonb then 'null'::jsonb else v_item->v_key end); end if;
  end loop;
  select * into v_old from booking.program_items where id = v_id;
  if v_old.id is not null and (v_old.event_id <> v_e.id or v_old.deleted_at is not null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('id', v_id));
  end if;
  if v_old.id is null then
    v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.program_items', 'id', v_id,
      'fields', v_fields || jsonb_build_object('event_id', v_e.id))));
  else
    if v_fields = '{}'::jsonb then return jsonb_build_object('id', v_id, 'revision', v_old.revision, 'cursor', null); end if;
    v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.program_items', 'id', v_id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_old.revision), 'fields', v_fields)));
  end if;
  return jsonb_build_object('id', v_id, 'revision', (select revision from booking.program_items where id = v_id), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_program_remove(p jsonb)
returns jsonb language plpgsql as $$
declare v_e booking.events := booking.portal_program_event(p); v_old booking.program_items; v_out jsonb;
begin
  select * into v_old from booking.program_items where id = (p->'args'->>'id')::uuid and event_id = v_e.id;
  if v_old.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('id', p->'args'->>'id')); end if;
  if v_old.deleted_at is not null then return jsonb_build_object('id', v_old.id, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'delete', 'table', 'booking.program_items', 'id', v_old.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_old.revision))));
  return jsonb_build_object('id', v_old.id, 'cursor', v_out->'cursor');
end $$;

-- Orden de las actividades de un día (o de todo el programa): `ids` en el orden nuevo; posiciones 1..n.
create or replace function booking.portal_program_reorder(p jsonb)
returns jsonb language plpgsql as $$
declare v_e booking.events := booking.portal_program_event(p); v_ops jsonb := '[]'::jsonb; v_id text; v_pos int := 0; i booking.program_items; v_out jsonb;
begin
  if jsonb_typeof(p->'args'->'ids') <> 'array' or jsonb_array_length(p->'args'->'ids') > 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'ids debe ser una lista (como mucho 200)'));
  end if;
  for v_id in select jsonb_array_elements_text(p->'args'->'ids') loop
    v_pos := v_pos + 1;
    select * into i from booking.program_items where id = v_id::uuid and event_id = v_e.id and deleted_at is null;
    if i.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('id', v_id)); end if;
    if i.position <> v_pos then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.program_items', 'id', i.id, 'expectedRevision', i.revision, 'fields', jsonb_build_object('position', v_pos));
    end if;
  end loop;
  if v_ops = '[]'::jsonb then return jsonb_build_object('cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  return jsonb_build_object('cursor', v_out->'cursor');
end $$;

select core.allow_read('organizers', 'booking.portal_program', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_program', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_program_save', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_program_remove', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_program_reorder', 'action', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- BG11 · huésped de muestra: uno por reserva confirmada, para que el organizador vea Guests como un asistente. No cuenta en
-- totales ni en la completitud, no va a SES (nunca llega: no puede marcarse su llegada), no da restricciones a cocina ni
-- avisos, y no se puede escribir como huésped (`PREVIEW_READ_ONLY`). Se borra con la reserva, como los demás.
-- ---------------------------------------------------------------------------
alter table booking.guests add column preview boolean not null default false;
alter table booking.guests add constraint guests_preview_not_arrived check (not preview or arrived_at is null);
create unique index guests_one_preview_idx on booking.guests (event_id) where preview and deleted_at is null;
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview'],
  '{editor,owner}', '{editor,owner}');

create or replace function booking.guest_preview_guard()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.preview and coalesce(current_setting('booking.preview_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'preview', 'reason', 'solo con booking.portal_preview_guest'));
  end if;
  if tg_op = 'UPDATE' and new.preview is distinct from old.preview then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'preview', 'reason', 'no se cambia'));
  end if;
  if tg_op = 'UPDATE' and old.preview and booking.writer() = 'guest' then
    perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', old.id));
  end if;
  return new;
end $$;
create trigger guests_preview_guard before insert or update on booking.guests
  for each row execute function booking.guest_preview_guard();

create or replace function booking.restriction_preview_guard()
returns trigger language plpgsql as $$
begin
  if booking.writer() = 'guest' and exists (select 1 from booking.guests g where g.id = coalesce(new.guest_id, old.guest_id) and g.preview) then
    perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', coalesce(new.guest_id, old.guest_id)));
  end if;
  return new;
end $$;
create trigger dietary_restrictions_preview_guard before insert or update on booking.dietary_restrictions
  for each row execute function booking.restriction_preview_guard();

-- Crea (o devuelve) el huésped de muestra de la reserva. Para el organizador; el enlace de Guests lo emite el núcleo (C9).
create or replace function booking.portal_preview_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_e booking.events := booking.portal_program_event(p); v_id uuid; v_out jsonb;
begin
  select id into v_id from booking.guests where event_id = v_e.id and preview and deleted_at is null;
  if v_id is not null then return jsonb_build_object('guest_id', v_id, 'created', false); end if;
  v_id := gen_random_uuid();
  perform set_config('booking.preview_procedure', 'on', true);
  v_out := booking.portal_apply('organizer', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id,
    'fields', jsonb_build_object('event_id', v_e.id, 'first_name', 'Huésped', 'last_name_1', 'de muestra', 'preview', true))));
  perform set_config('booking.preview_procedure', '', true);
  return jsonb_build_object('guest_id', v_id, 'created', true, 'cursor', v_out->'cursor');
end $$;
select core.allow_read('organizers', 'booking.portal_preview_guest', 'action', '{editor,owner}');

-- Fuera de totales, completitud, listas del organizador y cocina:
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
          select data_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null and not preview group by 1) a), '{}'::jsonb),
      'sesStatus', coalesce((select jsonb_object_agg(b.ses_status, b.n) from (
          select ses_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null and not preview group by 1) b), '{}'::jsonb))
    into v_out
    from booking.guests g where g.event_id = v_event and g.deleted_at is null and not g.preview;
  return v_out;
end $$;

create or replace function booking.portal_reservations(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid;
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
      'expected_guests', r.expected_guests, 'status', r.status, 'confirmed', e.id is not null, 'mode', booking.guest_mode(r.id),
      'guests', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null and not g.preview),
      'complete', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null and not g.preview
                      and cardinality(booking.guest_missing(g, booking.guest_mode(r.id))) = 0)) order by r.start_date nulls last)
      from booking.reservations r
      left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
     where r.deleted_at is null and booking.portal_in_scope('organizers', v_actor, r.id, null)), '[]'::jsonb));
end $$;

create or replace function booking.portal_guests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_event uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select id into v_event from booking.events where reservation_id = v_res and deleted_at is null;
  if v_event is null then return jsonb_build_object('confirmed', false, 'mode', booking.guest_mode(v_res), 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', '[]'::jsonb); end if;
  if booking.guest_mode(v_res) = 'ninguno' then return jsonb_build_object('confirmed', true, 'mode', 'ninguno', 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', '[]'::jsonb); end if;
  return jsonb_build_object('confirmed', true, 'mode', booking.guest_mode(v_res), 'declared', exists (select 1 from booking.portal_declarations d where d.reservation_id = v_res and d.user_id = (p->>'actor')::uuid and d.deleted_at is null), 'items', coalesce((
    select jsonb_agg(booking.portal_organizer_guest(g) order by g.created_at)
      from booking.guests g where g.event_id = v_event and g.deleted_at is null and not g.preview), '[]'::jsonb));
end $$;

create or replace view booking.food_event_projection as
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
        and not exists (select 1 from booking.guests pg where pg.id = d.guest_id and pg.preview)
      group by 1, 2, 3, 4) x), '[]'::jsonb) as dietary_restrictions,
  s.revision as event_revision,
  r.status as reservation_status,
  (e.final_guests is not null) as guest_count_is_final,
  r.requires_meals,
  r.meal_notes,
  r.id as reservation_id
from booking.events e
join booking.reservations r on r.id = e.reservation_id
join booking.event_food_state s on s.id = e.id
where e.deleted_at is null and r.deleted_at is null;

revoke all on booking.food_event_projection from public, anon, authenticated;
grant select on booking.food_event_projection to service_role;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
