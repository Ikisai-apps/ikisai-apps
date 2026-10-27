-- Ikisai Booking · la posición de la cama propia en las lecturas de portal (petición de Guests, acordada con Core,
-- 27-10-2026; MUELA/equipo/feedback/guests/CAMA_PROPIA_PLANO.md). Misma forma que la 1417 (`spaces.layout` y `beds.cell`):
-- - `booking.portal_lodging.mine`, `booking.portal_my_stays.items[]` (`booking.portal_stay_json`) y
--   `portal_my_stays.default_bed` llevan `room_layout: {cols, rows} | null` y `bed_layout: {x, y, rot} | null`.
-- Solo la cama propia: nunca la de otras personas. Sin disposición, `null`, y Guests pone «Aquí» en la habitación.
-- Toca solo el schema booking.

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
        'bed_label', (select b.label from booking.beds b where b.id = v_a.bed_id), 'status', v_a.status, 'source', v_a.source,
        'room_layout', s.layout, 'bed_layout', (select b.cell from booking.beds b where b.id = v_a.bed_id))
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

create or replace function booking.portal_stay_json(s booking.stays)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', s.id, 'revision', s.revision, 'from', s.from_date, 'to', s.to_date, 'source', s.source,
    'persons', booking.stay_persons_json(s.id),
    'space_name', (select booking.space_public_name(x) from booking.spaces x where x.id = s.space_id),
    'zone', (select x.zone from booking.spaces x where x.id = s.space_id),
    'bed_label', (select b.label from booking.beds b where b.id = s.bed_id),
    'resource_space_id', coalesce(s.resource_space_id, booking.resource_twin('booking.space', s.space_id)),
    'resource_bed_id', coalesce(s.resource_bed_id, booking.resource_twin('booking.bed', s.bed_id)),
    'room_layout', (select x.layout from booking.spaces x where x.id = s.space_id),
    'bed_layout', (select b.cell from booking.beds b where b.id = s.bed_id),
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
        'resource_space_id', booking.resource_twin('booking.space', d.space_id), 'resource_bed_id', booking.resource_twin('booking.bed', d.bed_id),
        'room_layout', (select x.layout from booking.spaces x where x.id = d.space_id), 'bed_layout', (select b.cell from booking.beds b where b.id = d.bed_id))
      from booking.outsider_defaults d where d.account_id = v_actor and d.deleted_at is null));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
