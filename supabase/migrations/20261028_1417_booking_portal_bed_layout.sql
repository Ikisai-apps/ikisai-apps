-- Ikisai Booking · la posición de las camas en las lecturas de portal (petición de Guests, 27-10-2026). VG decidió un solo
-- modelo de colocación: el de Booking (`spaces.layout` y `beds.cell`, 0477; `bed_layout_projection`, 1416). Las formas de
-- cama de Recursos se anularán después de que Guests cambie.
-- - `booking.portal_lodging` (huésped, por `booking.portal_room_json`) y `booking_public_beds` (visitante) llevan:
--   - `layout: {cols, rows} | null` en cada habitación;
--   - `layout: {x, y, rot} | null` en cada cama.
--   Es la misma forma en las dos lecturas. Sin disposición, `null`, y Guests sigue con la lista. `resource_space_id` y
--   `resource_bed_id` no cambian.
-- Toca solo el schema booking.

create or replace function booking.portal_room_json(p_space uuid, p_event uuid, p_guest uuid, p_org boolean)
returns jsonb language sql stable as $$
  with extras as (select id from booking.event_extra_bed_ids(p_event, p_space) id),
  shown as (
    select b.* from booking.beds b where b.space_id = p_space and b.deleted_at is null and b.active and (b.kind <> 'supletoria' or b.id in (select id from extras))
      -- camas de equipo: solo para las fichas de equipo (y el organizador las ve todas)
      and (p_org or b.team_bed = booking.guest_is_team(p_guest)))
  select jsonb_build_object('space_id', s.id, 'resource_space_id', booking.resource_twin('booking.space', s.id), 'name', booking.space_public_name(s), 'layout', s.layout, 'zone', s.zone, 'kind', s.kind, 'capacity', s.capacity,
    'en_suite', s.en_suite, 'small_en_suite', s.en_suite and coalesce(s.capacity, 0) between 2 and 4,
    'option_key', o.option_key, 'open', o.id is not null, 'supplement', coalesce(o.supplement, false),
    'beds_total', (select count(*) from shown b where b.kind <> 'supletoria'),
    'beds_free', (select count(*) from shown b where b.kind <> 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'extra_total', (select count(*) from shown b where b.kind = 'supletoria'),
    'extra_free', (select count(*) from shown b where b.kind = 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'beds', coalesce((select jsonb_agg(jsonb_build_object('bed_id', b.id, 'resource_bed_id', booking.resource_twin('booking.bed', b.id), 'label', b.label, 'layout', b.cell, 'kind', b.kind, 'free', booking.bed_free(b.id, p_event, p_guest),
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
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', coalesce(s.public_name, s.name), 'layout', s.layout, 'beds', (
        select jsonb_agg(jsonb_build_object('id', b.id, 'label', b.label, 'layout', b.cell, 'kind', b.kind, 'places', greatest(coalesce(b.capacity, 1), 1),
                 'free', exists (select 1 from booking.free_beds(v_from, v_to) x where x.bed_id = b.id), 'resource_bed_id', b.resource_id)
                 order by b.position, b.label)
          from booking.beds b
         where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria' and not b.team_bed))
      order by s.position, coalesce(s.public_name, s.name))
      from booking.spaces s
     where s.deleted_at is null and s.active and s.bookable
       and exists (select 1 from booking.beds b where b.space_id = s.id and b.deleted_at is null and b.active and b.kind <> 'supletoria' and not b.team_bed)), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
