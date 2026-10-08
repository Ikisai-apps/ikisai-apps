-- Ikisai Booking · fases 4 y 5 de los portales, parte 2: alojamiento delegable (Organizers B17, Guests BG10).
-- El inventario del retiro son las habitaciones que el personal le ha asignado (cualquier asignación viva del evento en ese
-- espacio, también la de grupo sin cama). El organizador abre algunas a elección y reparte camas; el huésped elige cama
-- (o la pide, con aprobación) con una reserva atómica. Decisión del usuario (8-10-2026): el
-- huésped solo elige entre las camas con baño que el organizador ya contrató, así que elegir no factura nada nuevo (el
-- suplemento de las de 2–4 plazas con baño ya va en la propuesta). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Columnas nuevas
-- ---------------------------------------------------------------------------
alter table booking.spaces add column en_suite boolean not null default false;
select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','bookable','position','notes','public_name','en_suite']);

alter table booking.room_assignments add column source text not null default 'staff' check (source in ('guest','organizer','staff'));
alter table booking.room_assignments add column status text not null default 'confirmed' check (status in ('confirmed','requested'));
select core.register_table('booking', 'booking', 'room_assignments', array['event_id','space_id','bed_id','guest_id','group_label','persons','from_date','to_date','notes','status']);

alter table booking.guests add column room_preference text check (room_preference is null or length(room_preference) <= 200);
alter table booking.guests add column needs_ground_floor boolean not null default false;
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview',
  'room_preference','needs_ground_floor'],
  '{editor,owner}', '{editor,owner}');

-- Quién hizo la asignación sale de quién escribe (nunca del cliente). La muestra no ocupa camas.
create or replace function booking.room_assignment_source()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.source := booking.writer(); end if;
  if tg_op = 'UPDATE' then new.source := old.source; end if;
  if new.deleted_at is null and new.guest_id is not null and exists (select 1 from booking.guests g where g.id = new.guest_id and g.preview) then
    perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', new.guest_id));
  end if;
  return new;
end $$;
create trigger room_assignments_source before insert or update on booking.room_assignments
  for each row execute function booking.room_assignment_source();

-- ---------------------------------------------------------------------------
-- Ajustes del alojamiento de un retiro (los escribe el organizador con su acción; el personal los ve y los corrige)
-- ---------------------------------------------------------------------------
create table booking.lodging_settings (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  -- off: nadie elige · choose: el huésped elige y queda confirmada · request: queda pendiente de que la apruebe el organizador
  choice text not null default 'off' check (choice in ('off','choose','request')),
  choose_until date,
  preferences boolean not null default false
);
create unique index lodging_settings_event_idx on booking.lodging_settings (event_id) where deleted_at is null;
create trigger lodging_settings_forbid_reparent before update on booking.lodging_settings
  for each row execute function booking.forbid_reparent('event_id');
select core.register_table('booking', 'booking', 'lodging_settings', array['event_id','choice','choose_until','preferences']);

create table booking.open_rooms (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  space_id uuid not null references booking.spaces(id),
  option_key text check (option_key is null or option_key ~ '^[a-z0-9_-]{1,40}$'),
  supplement boolean not null default false
);
create unique index open_rooms_event_space_idx on booking.open_rooms (event_id, space_id) where deleted_at is null;
create trigger open_rooms_forbid_reparent before update on booking.open_rooms
  for each row execute function booking.forbid_reparent('event_id');
select core.register_table('booking', 'booking', 'open_rooms', array['event_id','space_id','option_key','supplement']);

-- ---------------------------------------------------------------------------
-- Ayudas
-- ---------------------------------------------------------------------------
-- Habitaciones del retiro: las que el personal le ha asignado.
create or replace function booking.event_rooms(p_event uuid)
returns setof uuid language sql stable as $$
  select distinct a.space_id from booking.room_assignments a join booking.spaces s on s.id = a.space_id
   where a.event_id = p_event and a.deleted_at is null and s.deleted_at is null and s.kind = 'habitacion';
$$;

-- ¿Está libre la cama en las noches de la reserva? Sin contar las asignaciones de `p_guest` (la que va a sustituir).
create or replace function booking.bed_free(p_bed uuid, p_event uuid, p_guest uuid)
returns boolean language sql stable as $$
  with mine as (
    select r.start_date d_from, r.end_date d_to from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = p_event)
  select not exists (
    select 1 from booking.room_assignments a
      join booking.events e on e.id = a.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
      cross join mine
     where a.bed_id = p_bed and a.deleted_at is null and a.guest_id is distinct from p_guest
       and coalesce(a.from_date, r.start_date) < mine.d_to and mine.d_from < coalesce(a.to_date, r.end_date));
$$;

create or replace function booking.lodging_settings_of(p_event uuid)
returns booking.lodging_settings language sql stable as $$
  select * from booking.lodging_settings where event_id = p_event and deleted_at is null;
$$;

create or replace function booking.lodging_choice_open(s booking.lodging_settings)
returns boolean language sql stable as $$
  select s.id is not null and s.choice <> 'off' and (s.choose_until is null or (now() at time zone 'Europe/Madrid')::date <= s.choose_until);
$$;

-- Habitación con sus camas para un portal. Al huésped, solo libre u ocupada; al organizador, también de quién es.
create or replace function booking.portal_room_json(p_space uuid, p_event uuid, p_guest uuid, p_org boolean)
returns jsonb language sql stable as $$
  select jsonb_build_object('space_id', s.id, 'name', booking.space_public_name(s), 'zone', s.zone, 'kind', s.kind, 'capacity', s.capacity,
    'en_suite', s.en_suite, 'small_en_suite', s.en_suite and coalesce(s.capacity, 0) between 2 and 4,
    'option_key', o.option_key, 'open', o.id is not null, 'supplement', coalesce(o.supplement, false),
    'beds_total', (select count(*) from booking.beds b where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria'),
    'beds_free', (select count(*) from booking.beds b where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'beds', coalesce((select jsonb_agg(jsonb_build_object('bed_id', b.id, 'label', b.label, 'kind', b.kind, 'free', booking.bed_free(b.id, p_event, p_guest),
        'mine', exists (select 1 from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.guest_id = p_guest and a.deleted_at is null))
        || case when p_org then coalesce((select jsonb_build_object('assignment_id', a.id, 'guest_id', a.guest_id, 'group_label', a.group_label, 'status', a.status, 'source', a.source)
              from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.deleted_at is null limit 1), '{}'::jsonb) else '{}'::jsonb end
        order by b.position, b.label)
      from booking.beds b where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria'), '[]'::jsonb))
  from booking.spaces s left join booking.open_rooms o on o.space_id = s.id and o.event_id = p_event and o.deleted_at is null
  where s.id = p_space;
$$;

-- ---------------------------------------------------------------------------
-- Guests (BG10)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_lodging(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_s booking.lodging_settings; v_a booking.room_assignments;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_s := booking.lodging_settings_of(v_g.event_id);
  select * into v_a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null order by created_at desc limit 1;
  return jsonb_build_object(
    'choice', coalesce(v_s.choice, 'off'), 'choose_until', v_s.choose_until, 'open', booking.lodging_choice_open(v_s), 'preferences', coalesce(v_s.preferences, false),
    'mine', case when v_a.id is null then null else (select jsonb_build_object('space_name', booking.space_public_name(s), 'zone', s.zone,
        'bed_label', (select b.label from booking.beds b where b.id = v_a.bed_id), 'status', v_a.status, 'source', v_a.source)
      from booking.spaces s where s.id = v_a.space_id) end,
    'preference', case when v_g.room_preference is null and not v_g.needs_ground_floor then null
      else jsonb_build_object('text', v_g.room_preference, 'ground_floor', v_g.needs_ground_floor) end,
    'rooms', case when coalesce(v_s.choice, 'off') = 'off' then '[]'::jsonb else coalesce((
      select jsonb_agg(booking.portal_room_json(o.space_id, v_g.event_id, v_g.id, false) order by s.zone nulls last, s.position)
        from booking.open_rooms o join booking.spaces s on s.id = o.space_id and s.deleted_at is null and s.active
       where o.event_id = v_g.event_id and o.deleted_at is null and o.space_id in (select booking.event_rooms(v_g.event_id))), '[]'::jsonb) end);
end $$;

-- Reserva atómica de una cama: se bloquea la fila de la cama, se comprueba que está libre en las noches de la reserva y,
-- en el mismo lote, se sustituye la asignación anterior del huésped. La invariante `BED_OVERBOOKED` sigue al final del lote.
create or replace function booking.portal_choose_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_g booking.guests; v_s booking.lodging_settings; v_b booking.beds; v_ops jsonb := '[]'::jsonb; a booking.room_assignments;
  v_id uuid := gen_random_uuid(); v_status text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  v_s := booking.lodging_settings_of(v_g.event_id);
  if v_s.id is null or v_s.choice = 'off' then perform core.fail('NOT_OFFERED', 422, jsonb_build_object('guest_id', v_g.id)); end if;
  if not booking.lodging_choice_open(v_s) then perform core.fail('CHOICE_CLOSED', 422, jsonb_build_object('choose_until', v_s.choose_until)); end if;
  begin
    select * into v_b from booking.beds where id = (p->'args'->>'bed_id')::uuid and deleted_at is null and active for update;
  exception when invalid_text_representation then v_b := null; end;
  if v_b.id is null or v_b.kind = 'supletoria'
     or not exists (select 1 from booking.open_rooms o where o.event_id = v_g.event_id and o.space_id = v_b.space_id and o.deleted_at is null)
     or v_b.space_id not in (select booking.event_rooms(v_g.event_id)) then
    perform core.fail('NOT_OFFERED', 422, jsonb_build_object('bed_id', p->'args'->>'bed_id'));
  end if;
  if not booking.bed_free(v_b.id, v_g.event_id, v_g.id) then perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_id', v_b.id)); end if;
  -- ya es suya: nada que hacer
  select * into a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and bed_id = v_b.id and deleted_at is null;
  if a.id is not null then return jsonb_build_object('assignment_id', a.id, 'revision', a.revision, 'status', a.status, 'cursor', null); end if;
  for a in select * from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  v_status := case when v_s.choice = 'request' then 'requested' else 'confirmed' end;
  v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_id,
    'fields', jsonb_build_object('event_id', v_g.event_id, 'space_id', v_b.space_id, 'bed_id', v_b.id, 'guest_id', v_g.id, 'persons', 1, 'status', v_status));
  v_out := booking.portal_apply('guest', v_ops);
  return jsonb_build_object('assignment_id', v_id, 'revision', (select revision from booking.room_assignments where id = v_id), 'status', v_status, 'cursor', v_out->'cursor');
end $$;

-- Suelta la cama que eligió el propio huésped mientras la elección siga abierta (las del organizador o del personal, no).
create or replace function booking.portal_release_bed(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_s booking.lodging_settings; v_ops jsonb := '[]'::jsonb; a booking.room_assignments; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  v_s := booking.lodging_settings_of(v_g.event_id);
  if not booking.lodging_choice_open(v_s) then perform core.fail('CHOICE_CLOSED', 422, jsonb_build_object('choose_until', v_s.choose_until)); end if;
  for a in select * from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null and source = 'guest' loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  if v_ops = '[]'::jsonb then return jsonb_build_object('released', 0, 'cursor', null); end if;
  v_out := booking.portal_apply('guest', v_ops);
  return jsonb_build_object('released', jsonb_array_length(v_ops), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_room_preference(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_text text := nullif(btrim(coalesce(p->'args'->>'text', '')), ''); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if length(v_text) > 200 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'room_preference')); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision),
    'fields', jsonb_build_object('room_preference', v_text, 'needs_ground_floor', coalesce((p->'args'->>'ground_floor')::boolean, false)))));
  return jsonb_build_object('guest_id', v_g.id, 'revision', (select revision from booking.guests where id = v_g.id), 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Organizers (B17)
-- ---------------------------------------------------------------------------
-- (a) inventario del retiro: habitaciones, camas libres y de quién es cada una (por `guest_id`: el nombre lo toma
-- Organizers de `portal_guests`), ajustes y preferencias de los huéspedes.
create or replace function booking.portal_rooms(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_e booking.events := booking.portal_program_event(p); v_s booking.lodging_settings := booking.lodging_settings_of(v_e.id);
begin
  return jsonb_build_object(
    'settings', jsonb_build_object('revision', v_s.revision, 'choice', coalesce(v_s.choice, 'off'), 'choose_until', v_s.choose_until,
      'preferences', coalesce(v_s.preferences, false), 'open', booking.lodging_choice_open(v_s)),
    'rooms', coalesce((select jsonb_agg(booking.portal_room_json(x.id, v_e.id, null, true) order by s.zone nulls last, s.position)
      from (select booking.event_rooms(v_e.id) id) x join booking.spaces s on s.id = x.id), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', a.id, 'revision', a.revision, 'guest_id', a.guest_id, 'space_id', a.space_id, 'bed_id', a.bed_id) order by a.created_at)
      from booking.room_assignments a where a.event_id = v_e.id and a.deleted_at is null and a.status = 'requested'), '[]'::jsonb),
    'preferences', coalesce((select jsonb_agg(jsonb_build_object('guest_id', g.id, 'text', g.room_preference, 'ground_floor', g.needs_ground_floor) order by g.created_at)
      from booking.guests g where g.event_id = v_e.id and g.deleted_at is null and not g.preview and (g.room_preference is not null or g.needs_ground_floor)), '[]'::jsonb));
end $$;

-- (b) asignar o quitar la cama de un huésped (`bed_id` null la quita). Solo camas de las habitaciones del retiro.
create or replace function booking.portal_assign_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_g booking.guests; v_b booking.beds; v_ops jsonb := '[]'::jsonb;
  a booking.room_assignments; v_id uuid; v_out jsonb;
begin
  select * into v_g from booking.guests where id = (p->'args'->>'guest_id')::uuid and event_id = v_e.id and deleted_at is null;
  if v_g.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p->'args'->>'guest_id')); end if;
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  if nullif(p->'args'->>'bed_id', '') is not null then
    select * into v_b from booking.beds where id = (p->'args'->>'bed_id')::uuid and deleted_at is null and active for update;
    if v_b.id is null or v_b.kind = 'supletoria' or v_b.space_id not in (select booking.event_rooms(v_e.id)) then
      perform core.fail('NOT_OFFERED', 422, jsonb_build_object('bed_id', p->'args'->>'bed_id'));
    end if;
    if not booking.bed_free(v_b.id, v_e.id, v_g.id) then perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_id', v_b.id)); end if;
  end if;
  for a in select * from booking.room_assignments where event_id = v_e.id and guest_id = v_g.id and deleted_at is null loop
    if v_b.id is not null and a.bed_id = v_b.id and a.status = 'confirmed' then return jsonb_build_object('assignment_id', a.id, 'cursor', null); end if;
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  if v_b.id is not null then
    v_id := gen_random_uuid();
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_id,
      'fields', jsonb_build_object('event_id', v_e.id, 'space_id', v_b.space_id, 'bed_id', v_b.id, 'guest_id', v_g.id, 'persons', 1, 'status', 'confirmed'));
  end if;
  if v_ops = '[]'::jsonb then return jsonb_build_object('assignment_id', null, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  return jsonb_build_object('assignment_id', v_id, 'cursor', v_out->'cursor');
end $$;

-- (c) ajustes: modo de elección, fecha límite, preferencias y habitaciones abiertas (sustituye la lista). Solo habitaciones
-- del retiro.
create or replace function booking.portal_room_settings(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_a jsonb := p->'args'; v_s booking.lodging_settings := booking.lodging_settings_of(v_e.id);
  v_ops jsonb := '[]'::jsonb; v_fields jsonb := '{}'::jsonb; v_room jsonb; o booking.open_rooms; v_space uuid; v_wanted uuid[] := '{}'; v_out jsonb;
begin
  if v_a ? 'choice' then
    if coalesce(v_a->>'choice', '') not in ('off','choose','request') then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.lodging_settings', 'field', 'choice')); end if;
    v_fields := v_fields || jsonb_build_object('choice', v_a->>'choice');
  end if;
  if v_a ? 'choose_until' then v_fields := v_fields || jsonb_build_object('choose_until', nullif(v_a->>'choose_until', '')); end if;
  if v_a ? 'preferences' then v_fields := v_fields || jsonb_build_object('preferences', coalesce((v_a->>'preferences')::boolean, false)); end if;
  if v_s.id is null then
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.lodging_settings', 'id', gen_random_uuid(), 'fields', v_fields || jsonb_build_object('event_id', v_e.id));
  elsif v_fields <> '{}'::jsonb then
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.lodging_settings', 'id', v_s.id,
      'expectedRevision', coalesce((v_a->>'expectedRevision')::bigint, v_s.revision), 'fields', v_fields);
  end if;
  if v_a ? 'rooms' then
    if jsonb_typeof(v_a->'rooms') <> 'array' or jsonb_array_length(v_a->'rooms') > 100 then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'rooms debe ser una lista (como mucho 100)'));
    end if;
    for v_room in select * from jsonb_array_elements(v_a->'rooms') loop
      begin v_space := (v_room->>'space_id')::uuid; exception when others then v_space := null; end;
      -- decisión del usuario (8-10-2026): solo habitaciones con baño ya contratadas (las del retiro)
      if v_space is null or v_space not in (select booking.event_rooms(v_e.id))
         or not exists (select 1 from booking.spaces sp where sp.id = v_space and sp.en_suite) then
        perform core.fail('NOT_OFFERED', 422, jsonb_build_object('space_id', v_room->>'space_id'));
      end if;
      v_wanted := v_wanted || v_space;
      select * into o from booking.open_rooms where event_id = v_e.id and space_id = v_space and deleted_at is null;
      if o.id is null then
        v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.open_rooms', 'id', gen_random_uuid(), 'fields', jsonb_build_object('event_id', v_e.id,
          'space_id', v_space, 'option_key', nullif(v_room->>'option_key', ''), 'supplement', coalesce((v_room->>'supplement')::boolean, false)));
      elsif o.option_key is distinct from nullif(v_room->>'option_key', '') or o.supplement is distinct from coalesce((v_room->>'supplement')::boolean, false) then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.open_rooms', 'id', o.id, 'expectedRevision', o.revision,
          'fields', jsonb_build_object('option_key', nullif(v_room->>'option_key', ''), 'supplement', coalesce((v_room->>'supplement')::boolean, false)));
      end if;
    end loop;
    for o in select * from booking.open_rooms where event_id = v_e.id and deleted_at is null and not (space_id = any(v_wanted)) loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.open_rooms', 'id', o.id, 'expectedRevision', o.revision);
    end loop;
  end if;
  if v_ops = '[]'::jsonb then return jsonb_build_object('cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  return jsonb_build_object('revision', (select revision from booking.lodging_settings where event_id = v_e.id and deleted_at is null), 'cursor', v_out->'cursor');
end $$;

-- (d) aprobar o rechazar una plaza pendiente (`approve`: true la confirma; false la quita).
create or replace function booking.portal_approve_bed(p jsonb)
returns jsonb language plpgsql as $$
declare v_e booking.events := booking.portal_program_event(p); a booking.room_assignments; v_approve boolean := coalesce((p->'args'->>'approve')::boolean, false); v_out jsonb;
begin
  select * into a from booking.room_assignments where id = (p->'args'->>'assignment_id')::uuid and event_id = v_e.id and deleted_at is null;
  if a.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('assignment_id', p->'args'->>'assignment_id')); end if;
  if a.status <> 'requested' then return jsonb_build_object('assignment_id', a.id, 'status', a.status, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', jsonb_build_array(case when v_approve
    then jsonb_build_object('op', 'update', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, a.revision), 'fields', jsonb_build_object('status', 'confirmed'))
    else jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, a.revision)) end));
  return jsonb_build_object('assignment_id', a.id, 'status', case when v_approve then 'confirmed' else 'rejected' end, 'cursor', v_out->'cursor');
end $$;

select core.allow_read('guests', 'booking.portal_lodging', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_choose_bed', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_release_bed', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_room_preference', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_rooms', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_assign_bed', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_room_settings', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_approve_bed', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
