-- Ikisai Booking · camas de equipo (respuesta de VG del 26-10-2026 y Core): las fichas de equipo (organizador, personal y
-- dirección, `guests.portal_role`) solo eligen entre las camas reservadas para el equipo, y los huéspedes nunca las ven.
-- - `booking.beds.team_bed`: en modo Booking se edita aquí; con los espacios en Recursos lo copia el espejo desde
--   `attributes.team_bed` de la cama (lo añade Core al tipo «cama», 0812).
-- - Fichas de equipo: eligen cualquier cama de equipo libre de las habitaciones del evento, sin «Habitaciones abiertas» ni
--   plazo, confirmada al momento. Sin ninguna marcada, no eligen (la asigna el personal).
-- Toca solo el schema booking.

alter table booking.beds add column team_bed boolean not null default false;
select core.register_table('booking', 'booking', 'beds', array['space_id','label','kind','capacity','active','position','resource_id','resource_part','cell','team_bed']);

create or replace function booking.guest_is_team(p_guest uuid)
returns boolean language sql stable as $$
  select coalesce((select portal_role is not null from booking.guests where id = p_guest), false);
$$;

-- El espejo de 0479, que copia también `team_bed`.
create or replace function booking.spaces_mirror_plan()
returns jsonb language plpgsql stable as $$
declare
  v_ops jsonb := '[]'::jsonb; s record; b record; v_fields jsonb; v_cur record; v_id uuid; v_space uuid; v_part text; v_cap int; v_kind text; v_label text;
  v_wanted_spaces uuid[] := '{}'; v_wanted_beds text[] := '{}';
begin
  -- espacios: edificios reservables, habitaciones, salas y exteriores
  for s in select x.*, p.kind parent_kind, p.name parent_name, p.notes parent_notes
             from resources.spaces x left join resources.spaces p on p.id = x.parent_id
            where x.deleted_at is null and x.kind in ('edificio','habitacion','sala','exterior')
              -- un edificio solo si se reserva entero (el Albergue); si no, es solo la zona de lo que tiene dentro
              and (x.kind <> 'edificio' or coalesce((x.attributes->>'bookable')::boolean, false))
            order by x.kind <> 'edificio', x.position loop
    v_wanted_spaces := v_wanted_spaces || s.id;
    v_fields := jsonb_build_object(
      'name', left(s.name, 120), 'public_name', s.public_name,
      'kind', case s.kind when 'habitacion' then 'habitacion' when 'sala' then 'sala' when 'exterior' then 'zona_exterior' else 'otro' end,
      'zone', case when s.parent_kind = 'altura' then coalesce(s.parent_notes, s.parent_name) else s.parent_name end,
      'capacity', case when s.kind = 'habitacion' then null else (s.attributes->>'capacity')::int end,
      'accessible', coalesce((s.attributes->>'accessible')::boolean, false), 'bookable', coalesce((s.attributes->>'bookable')::boolean, false),
      'en_suite', coalesce((s.attributes->>'en_suite')::boolean, false), 'active', s.active, 'position', s.position, 'notes', s.notes, 'resource_id', s.id);
    v_id := booking.booking_twin('booking.space', s.id);
    if v_id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.spaces', 'id', gen_random_uuid(), 'fields', v_fields);
    else
      select * into v_cur from booking.spaces where id = v_id;
      v_fields := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_fields) e(k, v) where (to_jsonb(v_cur) -> k) is distinct from v);
      if v_fields <> '{}'::jsonb then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.spaces', 'id', v_id, 'expectedRevision', v_cur.revision, 'fields', v_fields);
      end if;
    end if;
  end loop;

  -- camas: una por parte (fija y supletoria) de cada cama de Recursos colgada de un espacio del espejo
  for b in select x.* from resources.spaces x join resources.spaces p on p.id = x.parent_id and p.deleted_at is null and p.kind in ('habitacion','sala')
            where x.deleted_at is null and x.kind = 'cama' order by x.position loop
    v_space := booking.booking_twin('booking.space', b.parent_id);
    if v_space is null then continue; end if; -- el espacio aún no existe en el espejo: en la siguiente pasada
    foreach v_part in array array['fija','supletoria'] loop
      v_cap := case when v_part = 'fija' then booking.resource_seats(b.attributes, 'capacity', 1) else booking.resource_seats(b.attributes, 'extra_capacity', 0) end;
      if v_cap <= 0 then continue; end if;
      v_wanted_beds := v_wanted_beds || (b.id::text || ':' || v_part);
      v_kind := case when v_part = 'supletoria' then 'supletoria' else coalesce(b.attributes->>'bed_kind', 'individual') end;
      v_label := left(case when v_part = 'supletoria' and booking.resource_seats(b.attributes, 'capacity', 1) > 0 then b.name || ' (supletoria)' else b.name end, 80);
      v_fields := jsonb_build_object('space_id', v_space, 'label', v_label, 'kind', v_kind, 'capacity', least(v_cap, 2), 'active', b.active,
        'position', b.position + case when v_part = 'supletoria' then 0.5 else 0 end, 'resource_id', b.id, 'resource_part', v_part,
        'team_bed', coalesce(b.attributes -> 'team_bed' = 'true'::jsonb, false));
      select * into v_cur from booking.beds where resource_id = b.id and resource_part = v_part and deleted_at is null;
      if v_cur.id is null and v_part = 'fija' then
        -- cama que ya existía en Booking (`booking.bed:<uuid>` en Recursos): se enlaza
        select * into v_cur from booking.beds where id = booking.booking_twin('booking.bed', b.id) and resource_id is null;
      end if;
      if v_cur.id is null then
        v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.beds', 'id', gen_random_uuid(), 'fields', v_fields);
      elsif v_cur.space_id <> v_space then
        -- una cama no cambia de habitación en Booking: se quita y se crea en la nueva
        v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.beds', 'id', v_cur.id, 'expectedRevision', v_cur.revision)
                       || jsonb_build_object('op', 'insert', 'table', 'booking.beds', 'id', gen_random_uuid(), 'fields', v_fields);
      else
        v_fields := (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from jsonb_each(v_fields - 'space_id') e(k, v) where (to_jsonb(v_cur) -> k) is distinct from v);
        if v_fields <> '{}'::jsonb then
          v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.beds', 'id', v_cur.id, 'expectedRevision', v_cur.revision, 'fields', v_fields);
        end if;
      end if;
    end loop;
  end loop;

  -- lo enlazado que ya no está en Recursos se quita (primero las camas)
  for v_cur in select * from booking.beds where resource_id is not null and deleted_at is null
                and not ((resource_id::text || ':' || resource_part) = any(v_wanted_beds)) loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.beds', 'id', v_cur.id, 'expectedRevision', v_cur.revision);
  end loop;
  for v_cur in select * from booking.spaces where resource_id is not null and deleted_at is null and not (resource_id = any(v_wanted_spaces)) loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.spaces', 'id', v_cur.id, 'expectedRevision', v_cur.revision, 'fields', jsonb_build_object('active', false));
  end loop;
  return v_ops;
end $$;

-- La de 0478: las camas de equipo, solo para las fichas de equipo (el organizador las ve todas).
create or replace function booking.portal_room_json(p_space uuid, p_event uuid, p_guest uuid, p_org boolean)
returns jsonb language sql stable as $$
  with extras as (select id from booking.event_extra_bed_ids(p_event, p_space) id),
  shown as (
    select b.* from booking.beds b where b.space_id = p_space and b.deleted_at is null and b.active and (b.kind <> 'supletoria' or b.id in (select id from extras))
      -- camas de equipo: solo para las fichas de equipo (y el organizador las ve todas)
      and (p_org or b.team_bed = booking.guest_is_team(p_guest)))
  select jsonb_build_object('space_id', s.id, 'resource_space_id', booking.resource_twin('booking.space', s.id), 'name', booking.space_public_name(s), 'zone', s.zone, 'kind', s.kind, 'capacity', s.capacity,
    'en_suite', s.en_suite, 'small_en_suite', s.en_suite and coalesce(s.capacity, 0) between 2 and 4,
    'option_key', o.option_key, 'open', o.id is not null, 'supplement', coalesce(o.supplement, false),
    'beds_total', (select count(*) from shown b where b.kind <> 'supletoria'),
    'beds_free', (select count(*) from shown b where b.kind <> 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'extra_total', (select count(*) from shown b where b.kind = 'supletoria'),
    'extra_free', (select count(*) from shown b where b.kind = 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'beds', coalesce((select jsonb_agg(jsonb_build_object('bed_id', b.id, 'resource_bed_id', booking.resource_twin('booking.bed', b.id), 'label', b.label, 'kind', b.kind, 'free', booking.bed_free(b.id, p_event, p_guest),
        'mine', exists (select 1 from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.guest_id = p_guest and a.deleted_at is null))
        || case when p_org then coalesce((select jsonb_build_object('assignment_id', a.id, 'guest_id', a.guest_id, 'group_label', a.group_label, 'status', a.status, 'source', a.source)
              from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.deleted_at is null limit 1), '{}'::jsonb) else '{}'::jsonb end
        order by b.kind = 'supletoria', b.position, b.label)
      from shown b), '[]'::jsonb))
    -- al organizador, el contador (y, planos, lo que pinta Organizers: `extra_max` posibles, ocupadas y pendientes de Ikisai)
    || case when p_org then (select jsonb_build_object('extra', c, 'extra_max', c->'possible', 'extra_occupied', c->'occupied', 'extra_requested', c->'requested')
         from (select booking.portal_extra_counts(p_event, p_space) c) z) else '{}'::jsonb end
  from booking.spaces s left join booking.open_rooms o on o.space_id = s.id and o.event_id = p_event and o.deleted_at is null
  where s.id = p_space;
$$;

-- Las de 0481, con camas de equipo.
create or replace function booking.portal_lodging(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_s booking.lodging_settings; v_a booking.room_assignments; v_team boolean; v_teambeds boolean;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_team := v_g.portal_role is not null;
  v_teambeds := v_team and exists (select 1 from booking.beds b where b.team_bed and b.active and b.deleted_at is null and b.space_id in (select booking.event_rooms(v_g.event_id)));
  v_s := booking.lodging_settings_of(v_g.event_id);
  select * into v_a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null order by created_at desc limit 1;
  return jsonb_build_object(
    'choice', case when v_team then (case when v_teambeds then 'choose' else 'off' end) else coalesce(v_s.choice, 'off') end, 'choose_until', case when v_team then null else v_s.choose_until end,
    'open', case when v_team then v_teambeds else booking.lodging_choice_open(v_s) end, 'preferences', coalesce(v_s.preferences, false), 'team', v_team,
    'mine', case when v_a.id is null then null else (select jsonb_build_object('space_name', booking.space_public_name(s), 'zone', s.zone,
        'resource_space_id', coalesce(v_a.resource_space_id, booking.resource_twin('booking.space', s.id)),
        'resource_bed_id', coalesce(v_a.resource_bed_id, booking.resource_twin('booking.bed', v_a.bed_id)),
        'bed_label', (select b.label from booking.beds b where b.id = v_a.bed_id), 'status', v_a.status, 'source', v_a.source)
      from booking.spaces s where s.id = v_a.space_id) end,
    'preference', case when v_g.room_preference is null and not v_g.needs_ground_floor then null
      else jsonb_build_object('text', v_g.room_preference, 'ground_floor', v_g.needs_ground_floor) end,
    'rooms', case
      when v_team then coalesce((
        select jsonb_agg(booking.portal_room_json(s.id, v_g.event_id, v_g.id, false) order by s.zone nulls last, s.position)
          from booking.spaces s where s.deleted_at is null and s.active and s.id in (select booking.event_rooms(v_g.event_id))
           and exists (select 1 from booking.beds b where b.space_id = s.id and b.team_bed and b.active and b.deleted_at is null)), '[]'::jsonb)
      when coalesce(v_s.choice, 'off') = 'off' then '[]'::jsonb else coalesce((
      select jsonb_agg(booking.portal_room_json(o.space_id, v_g.event_id, v_g.id, false) order by s.zone nulls last, s.position)
        from booking.open_rooms o join booking.spaces s on s.id = o.space_id and s.deleted_at is null and s.active
       where o.event_id = v_g.event_id and o.deleted_at is null and o.space_id in (select booking.event_rooms(v_g.event_id))), '[]'::jsonb) end);
end $$;

create or replace function booking.portal_choose_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_g booking.guests; v_s booking.lodging_settings; v_b booking.beds; v_ops jsonb := '[]'::jsonb; a booking.room_assignments;
  v_id uuid := gen_random_uuid(); v_status text; v_out jsonb; v_team boolean;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  v_team := v_g.portal_role is not null;
  v_s := booking.lodging_settings_of(v_g.event_id);
  if not v_team then
    if v_s.id is null or v_s.choice = 'off' then perform core.fail('NOT_OFFERED', 422, jsonb_build_object('guest_id', v_g.id)); end if;
    if not booking.lodging_choice_open(v_s) then perform core.fail('CHOICE_CLOSED', 422, jsonb_build_object('choose_until', v_s.choose_until)); end if;
  end if;
  begin
    select * into v_b from booking.beds where id = (p->'args'->>'bed_id')::uuid and deleted_at is null and active for update;
  exception when invalid_text_representation then v_b := null; end;
  -- una ficha de equipo, solo camas de equipo del evento; un huésped, nunca una de equipo (y solo en habitaciones abiertas)
  if v_b.id is null or not booking.extra_bed_usable(v_b, v_g.event_id) or v_b.team_bed is distinct from v_team
     or (not v_team and not exists (select 1 from booking.open_rooms o where o.event_id = v_g.event_id and o.space_id = v_b.space_id and o.deleted_at is null))
     or v_b.space_id not in (select booking.event_rooms(v_g.event_id)) then
    perform core.fail('NOT_OFFERED', 422, jsonb_build_object('bed_id', p->'args'->>'bed_id'));
  end if;
  if not booking.bed_free(v_b.id, v_g.event_id, v_g.id) then perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_id', v_b.id)); end if;
  select * into a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and bed_id = v_b.id and deleted_at is null;
  if a.id is not null then return jsonb_build_object('assignment_id', a.id, 'revision', a.revision, 'status', a.status, 'cursor', null); end if;
  for a in select * from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  v_status := case when not v_team and v_s.choice = 'request' then 'requested' else 'confirmed' end;
  v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_id,
    'fields', jsonb_build_object('event_id', v_g.event_id, 'space_id', v_b.space_id, 'bed_id', v_b.id, 'guest_id', v_g.id, 'persons', 1, 'status', v_status));
  v_out := booking.portal_apply('guest', v_ops);
  return jsonb_build_object('assignment_id', v_id, 'revision', (select revision from booking.room_assignments where id = v_id), 'status', v_status, 'cursor', v_out->'cursor');
end $$;


-- Bk1 de Guests: `portal_role` en la ficha propia y en «Mis retiros». Son las de 0451 y 0467 con ese campo.
create or replace function booking.portal_my_guest(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_r booking.reservations; v_e booking.events; v_field text; v_fields jsonb := '{}'::jsonb; v_row jsonb; v_res uuid;
begin
  begin v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid); exception when invalid_text_representation then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p->'args'->>'guest_id')); end;
  v_res := booking.portal_reservation_of(v_g);
  select * into v_r from booking.reservations where id = v_res;
  select * into v_e from booking.events where id = v_g.event_id;
  v_row := to_jsonb(v_g);
  foreach v_field in array booking.portal_guest_fields() loop v_fields := v_fields || jsonb_build_object(v_field, v_row -> v_field); end loop;
  return jsonb_build_object('id', v_g.id, 'revision', v_g.revision, 'portal_role', v_g.portal_role, 'fields', v_fields, 'mode', booking.guest_mode(v_res),
    'missing', to_jsonb(booking.guest_missing(v_g, booking.guest_mode(v_res))), 'signed', v_g.signed_at is not null,
    'allergies_visible_to_organizer', v_g.allergies_visible_to_organizer, 'privacy_ack_at', v_g.privacy_ack_at, 'privacy_ack_version', v_g.privacy_ack_version,
    'reservation', jsonb_build_object('title', v_r.title, 'start_date', v_r.start_date, 'end_date', v_r.end_date, 'status', v_r.status,
      'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time),
    'sources', coalesce((select jsonb_object_agg(key, value->>'by') from jsonb_each(v_g.field_sources)), '{}'::jsonb),
    'diet_reviewed_at', v_g.diet_reviewed_at, 'signature_text_version', v_g.signature_text_version,
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'restriction_type', d.restriction_type, 'subject', d.subject,
        'severity', d.severity, 'kitchen_notes', d.kitchen_notes, 'source', d.source) order by d.created_at)
      from booking.dietary_restrictions d where d.guest_id = v_g.id and d.deleted_at is null), '[]'::jsonb));
end $$;

create or replace function booking.portal_my_retreats(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid;
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('reservation_id', r.id, 'guest_id', g.id, 'person_key', g.person_key, 'name', g.first_name,
             'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date, 'status', r.status, 'mode', booking.guest_mode(r.id),
             'portal_role', g.portal_role)
             order by r.start_date nulls last, g.created_at)
      from booking.account_guests(v_actor) g
      join booking.events e on e.id = g.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
     where booking.portal_in_scope('guests', v_actor, r.id, g.id)), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
