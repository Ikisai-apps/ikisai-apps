-- Ikisai Booking · los usos de cada espacio en el espejo (decisión de VG del 06-11-2026, booking-U1). Recursos tiene
-- `resources.spaces.uses` (0825: alojamiento, eventos, trabajo, almacen, cocina, comedor, ocio, servicio, exterior) y
-- Central lo edita. Booking lo copia en `booking.spaces.uses` y enseña en montaje, árbol y asignación los espacios con uso
-- «alojamiento», los que tienen camas y los marcados en el evento (1430). Lo que ya existía lo copia la primera pasada del
-- tick del espejo (compara campo a campo; no depende de core.changes). Toca solo el schema booking.

alter table booking.spaces add column uses text[] not null default '{}';
select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','bookable','position','notes','public_name','en_suite','resource_id','layout','uses']);

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
      'en_suite', coalesce((s.attributes->>'en_suite')::boolean, false), 'active', s.active, 'position', s.position, 'notes', s.notes, 'resource_id', s.id,
      'uses', to_jsonb(coalesce(s.uses, '{}'::text[])));
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

