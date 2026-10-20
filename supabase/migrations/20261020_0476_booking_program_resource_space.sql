-- Ikisai Booking · Guests (petición en su SALIDA, Core: «sí»): `resource_space_id` en cada actividad de `portal_program`, para
-- enlazar el lugar con el espacio de Recursos (y su plano). La columna ya existe (0464). Es la de 0475 con ese campo.

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
        'place', coalesce(booking.space_public_name(s), i.place_text), 'space_id', i.space_id, 'resource_space_id', i.resource_space_id, 'place_text', i.place_text,
        'public_note', i.public_note, 'kind', i.kind, 'position', i.position,
        'audience', i.audience, 'audience_guest_ids', to_jsonb(a.ids))
        || case when v_org then jsonb_build_object('internal_note', i.internal_note) else '{}'::jsonb end
        order by i.day, i.starts_at nulls first, i.position)
      from booking.program_items i left join booking.spaces s on s.id = i.space_id
      cross join lateral (select booking.program_audience_for(p, v_r.id, i) ids) a
     where i.event_id = v_e.id and i.deleted_at is null
       and (v_org or i.audience <> 'personas' or cardinality(a.ids) > 0)), '[]'::jsonb))
    || case when v_org then jsonb_build_object('spaces', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'name', booking.space_public_name(s), 'kind', s.kind, 'zone', s.zone)
        order by s.kind <> 'sala', s.zone nulls last, s.position)
      from booking.spaces s where s.deleted_at is null and s.active and s.kind <> 'habitacion'), '[]'::jsonb)) else '{}'::jsonb end;
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
