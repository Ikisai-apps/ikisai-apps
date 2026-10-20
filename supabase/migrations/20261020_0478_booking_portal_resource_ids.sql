-- Ikisai Booking · petición de Guests (Core, 20-10-2026): ids de Recursos en las lecturas de alojamiento de los portales,
-- para casar habitaciones y camas con el mapa de zonas por id y no por nombre. Solo se añaden `resource_space_id` y
-- `resource_bed_id` (la pareja en Recursos, o null si no la hay); ningún dato de otros huéspedes.
--   portal_room_json (habitaciones de `portal_lodging` y del organizador, y cada cama), `portal_lodging.mine`,
--   portal_stay_json (`portal_my_stays` y las estancias) y `portal_my_stays.default_bed`.
-- Son las de 0466, 0460 y 0467 con esos campos.

create or replace function booking.portal_room_json(p_space uuid, p_event uuid, p_guest uuid, p_org boolean)
returns jsonb language sql stable as $$
  with extras as (select id from booking.event_extra_bed_ids(p_event, p_space) id),
  shown as (
    select b.* from booking.beds b where b.space_id = p_space and b.deleted_at is null and b.active and (b.kind <> 'supletoria' or b.id in (select id from extras)))
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
        'resource_space_id', coalesce(v_a.resource_space_id, booking.resource_twin('booking.space', s.id)),
        'resource_bed_id', coalesce(v_a.resource_bed_id, booking.resource_twin('booking.bed', v_a.bed_id)),
        'bed_label', (select b.label from booking.beds b where b.id = v_a.bed_id), 'status', v_a.status, 'source', v_a.source)
      from booking.spaces s where s.id = v_a.space_id) end,
    'preference', case when v_g.room_preference is null and not v_g.needs_ground_floor then null
      else jsonb_build_object('text', v_g.room_preference, 'ground_floor', v_g.needs_ground_floor) end,
    'rooms', case when coalesce(v_s.choice, 'off') = 'off' then '[]'::jsonb else coalesce((
      select jsonb_agg(booking.portal_room_json(o.space_id, v_g.event_id, v_g.id, false) order by s.zone nulls last, s.position)
        from booking.open_rooms o join booking.spaces s on s.id = o.space_id and s.deleted_at is null and s.active
       where o.event_id = v_g.event_id and o.deleted_at is null and o.space_id in (select booking.event_rooms(v_g.event_id))), '[]'::jsonb) end);
end $$;

create or replace function booking.portal_stay_json(s booking.stays)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'revision', s.revision, 'from', s.from_date, 'to', s.to_date, 'source', s.source,
    'persons', booking.stay_persons_json(s.id),
    'space_name', (select booking.space_public_name(x) from booking.spaces x where x.id = s.space_id),
    'zone', (select x.zone from booking.spaces x where x.id = s.space_id),
    'bed_label', (select b.label from booking.beds b where b.id = s.bed_id),
    'resource_space_id', coalesce(s.resource_space_id, booking.resource_twin('booking.space', s.space_id)),
    'resource_bed_id', coalesce(s.resource_bed_id, booking.resource_twin('booking.bed', s.bed_id)),
    'clash', jsonb_array_length(booking.stay_clashes(s)) > 0);
$$;

create or replace function booking.portal_my_stays(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := booking.portal_outsider(p); v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(booking.portal_stay_json(s) order by s.from_date, s.created_at)
      from booking.stays s
     where s.deleted_at is null and s.kind = 'outsider' and s.account_id = v_actor
       and s.from_date < v_range.d_to and v_range.d_from < s.to_date), '[]'::jsonb),
    'default_bed', (select jsonb_build_object('space_name', (select booking.space_public_name(x) from booking.spaces x where x.id = d.space_id),
        'bed_label', (select b.label from booking.beds b where b.id = d.bed_id),
        'resource_space_id', booking.resource_twin('booking.space', d.space_id), 'resource_bed_id', booking.resource_twin('booking.bed', d.bed_id))
      from booking.outsider_defaults d where d.account_id = v_actor and d.deleted_at is null));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
