-- Ikisai Booking · «También para todos los eventos» (VG 06-11-2026, booking-U1). Desde la marca de un espacio en un
-- evento (1430), el personal pide a Central que el espacio sea de alojamiento para todos los eventos. Booking no escribe en
-- Recursos: booking-api llama a la ruta de worker de Central (`worker/space-use`, `central.add_space_use`) y Central añade
-- el uso general; el espejo lo trae después. Esta lectura da a la Edge lo que necesita de la marca. Toca solo el schema booking.

create or replace function booking.event_space_for_use(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v jsonb;
begin
  begin v_id := (p->'args'->>'id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object('id', m.id, 'event_id', m.event_id, 'reservation_id', e.reservation_id, 'space_id', s.id, 'resource_id', s.resource_id,
      'name', coalesce(s.public_name, s.name), 'uses', to_jsonb(s.uses))
    into v
    from booking.event_spaces m
    join booking.events e on e.id = m.event_id
    join booking.spaces s on s.id = m.space_id and s.deleted_at is null
   where m.id = v_id and m.deleted_at is null;
  return jsonb_build_object('mark', v);
end $$;
select core.allow_read('booking', 'booking.event_space_for_use', 'function', '{editor,owner}');
