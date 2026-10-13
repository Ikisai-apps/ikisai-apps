-- Ikisai Booking · fase R2 de Recursos, paso 2: con el interruptor en `resources`, `booking.spaces` y `beds` pasan a ser un
-- **espejo** de `resources.spaces`. Lo escribe un tick del sistema (y la app del owner, con la misma planificación, para no
-- esperar), y cualquier otro cambio que se aparte de Recursos se rechaza (`SPACES_IN_RESOURCES`). Así todas las lecturas
-- de hoy (portales, alojamiento, disponibilidad, indicadores, invariante de camas) siguen igual, solo cambia de dónde sale
-- el dato. Apagar el interruptor deja las tablas como estén y vuelve a la edición en Booking.
--
-- Camas (decisión del usuario, Recursos #479): plazas fijas `capacity` y supletorias `extra_capacity`. En el espejo, cada
-- cama de Recursos da una cama de Booking por parte: la fija (su tipo) y la supletoria (`supletoria`, que no cuenta en las
-- plazas y se cobra como extra, como hoy). Toca solo el schema booking.

alter table booking.spaces add column resource_id uuid;
create unique index spaces_resource_idx on booking.spaces (resource_id) where resource_id is not null and deleted_at is null;
alter table booking.beds add column resource_id uuid;
alter table booking.beds add column resource_part text check (resource_part is null or resource_part in ('fija','supletoria'));
create unique index beds_resource_idx on booking.beds (resource_id, resource_part) where resource_id is not null and deleted_at is null;
select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','bookable','position','notes','public_name','en_suite','resource_id']);
select core.register_table('booking', 'booking', 'beds', array['space_id','label','kind','capacity','active','position','resource_id','resource_part']);

-- Parejas: ahora también por el enlace del espejo (además de `source_refs`).
create or replace function booking.resource_twin(p_kind text, p_id uuid)
returns uuid language plpgsql stable as $$
begin
  if p_id is null then return null; end if;
  return coalesce(
    case when p_kind = 'booking.space' then (select resource_id from booking.spaces where id = p_id) else (select resource_id from booking.beds where id = p_id) end,
    (select s.id from resources.spaces s where (p_kind || ':' || p_id::text) = any(s.source_refs) and s.deleted_at is null order by s.created_at limit 1));
end $$;

create or replace function booking.booking_twin(p_kind text, p_resource uuid)
returns uuid language plpgsql stable as $$
declare v_ref text; v_id uuid;
begin
  if p_resource is null then return null; end if;
  if p_kind = 'booking.space' then
    v_id := (select id from booking.spaces where resource_id = p_resource and deleted_at is null);
  else
    -- de una cama de Recursos, la parte fija si la hay; si no, la supletoria
    v_id := (select id from booking.beds where resource_id = p_resource and deleted_at is null order by resource_part = 'supletoria' limit 1);
  end if;
  if v_id is not null then return v_id; end if;
  select r into v_ref from resources.spaces s, unnest(s.source_refs) r where s.id = p_resource and r like p_kind || ':%' limit 1;
  if v_ref is null then return null; end if;
  begin v_id := substr(v_ref, length(p_kind) + 2)::uuid; exception when others then return null; end;
  if p_kind = 'booking.space' then return (select id from booking.spaces where id = v_id and deleted_at is null); end if;
  return (select id from booking.beds where id = v_id and deleted_at is null);
end $$;

-- ---------------------------------------------------------------------------
-- Planificación del espejo: operaciones para que Booking quede como Recursos (vacía si ya está)
-- ---------------------------------------------------------------------------
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
      v_cap := case when v_part = 'fija' then coalesce((b.attributes->>'capacity')::int, 0) else coalesce((b.attributes->>'extra_capacity')::int, 0) end;
      if v_cap <= 0 then continue; end if;
      v_wanted_beds := v_wanted_beds || (b.id::text || ':' || v_part);
      v_kind := case when v_part = 'supletoria' then 'supletoria' else coalesce(b.attributes->>'bed_kind', 'individual') end;
      v_label := left(case when v_part = 'supletoria' and coalesce((b.attributes->>'capacity')::int, 0) > 0 then b.name || ' (supletoria)' else b.name end, 80);
      v_fields := jsonb_build_object('space_id', v_space, 'label', v_label, 'kind', v_kind, 'capacity', least(v_cap, 2), 'active', b.active,
        'position', b.position + case when v_part = 'supletoria' then 0.5 else 0 end, 'resource_id', b.id, 'resource_part', v_part);
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

-- Para la app del owner: las operaciones que faltan, para mandarlas con su propio lote tras tocar Recursos.
create or replace function booking.spaces_mirror_pending(p jsonb)
returns jsonb language plpgsql stable as $$
begin
  return jsonb_build_object('source', booking.spaces_source(), 'operations', case when booking.spaces_source() = 'resources' then booking.spaces_mirror_plan() else '[]'::jsonb end);
end $$;

-- Tick del sistema (red de seguridad: cambios hechos desde otras apps).
create or replace function booking.spaces_mirror_apply(p jsonb)
returns jsonb language plpgsql as $$
declare v_ops jsonb; v_out jsonb;
begin
  if booking.spaces_source() <> 'resources' then return jsonb_build_object('applied', 0); end if;
  v_ops := booking.spaces_mirror_plan();
  if jsonb_array_length(v_ops) = 0 then return jsonb_build_object('applied', 0); end if;
  perform set_config('booking.writer', 'mirror', true);
  v_out := core.apply_system_operations('booking', (select jsonb_agg(o) from (select o from jsonb_array_elements(v_ops) o limit 500) x));
  perform set_config('booking.writer', '', true);
  return jsonb_build_object('applied', least(jsonb_array_length(v_ops), 500), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.spaces_mirror_has_work()
returns boolean language plpgsql stable as $$
begin
  return booking.spaces_source() = 'resources' and jsonb_array_length(booking.spaces_mirror_plan()) > 0;
end $$;

-- Con el interruptor encendido, `booking.spaces` y `beds` solo cambian para parecerse a Recursos.
create or replace function booking.check_spaces_mirror(p jsonb)
returns void language plpgsql as $$
declare v_cursor bigint := (p->>'cursor')::bigint; v_plan jsonb; v_touched uuid[];
begin
  if booking.spaces_source() <> 'resources' then return; end if;
  select array_agg(c.row_id) into v_touched from core.changes c
   where c.app = 'booking' and c.cursor = v_cursor and c.schema_name = 'booking' and c.table_name in ('spaces','beds');
  if v_touched is null then return; end if;
  v_plan := booking.spaces_mirror_plan();
  if exists (select 1 from jsonb_array_elements(v_plan) o where (o->>'id')::uuid = any(v_touched))
     or exists (select 1 from booking.spaces where id = any(v_touched) and resource_id is null and deleted_at is null)
     or exists (select 1 from booking.beds where id = any(v_touched) and resource_id is null and deleted_at is null)
     -- quitar a mano algo enlazado que Recursos sigue teniendo: el plan querría volver a crearlo
     or exists (select 1 from jsonb_array_elements(v_plan) o
                 where o->>'op' = 'insert' and (o->'fields'->>'resource_id')::uuid in (
                   select resource_id from booking.spaces where id = any(v_touched) and resource_id is not null
                   union select resource_id from booking.beds where id = any(v_touched) and resource_id is not null)) then
    perform core.fail('SPACES_IN_RESOURCES', 422, jsonb_build_object('reason', 'los espacios y las camas se editan en Recursos'));
  end if;
end $$;
select core.add_validate_hook('booking', 'booking.check_spaces_mirror');

select core.allow_read('booking', 'booking.spaces_mirror_pending', 'function', '{owner}');
select core.allow_read('booking', 'booking.spaces_mirror_apply', 'action', '{}');
select core.schedule_tick('booking', 'spaces/tick', '* * * * *', 'booking.spaces_mirror_has_work');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
