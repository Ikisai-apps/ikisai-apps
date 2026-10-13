-- Ikisai Recursos · camas con plazas fijas y supletorias (usuario, 13-10-2026; RECURSOS.md §4 y docs/resources/API.md §2.3).
-- - `bed_kind` admite también `sofa_cama`.
-- - `extra_capacity`: plazas supletorias que se pueden activar (la de arriba de una litera «partida», una litera o un sofá cama
--   que se monta solo si hace falta). `capacity` son las fijas. Ejemplos: litera normal 2 + 0; litera partida 1 + 1;
--   litera o sofá cama supletorio 0 + 2 o 0 + 1.
-- - Una cama puede colgar también de una sala (sofás cama de la Sala multiusos).
-- Crear, cambiar o quitar camas sigue siendo del owner (dirección); activar supletorias por retiro lo hará Booking.
-- Toca solo el schema resources.

create or replace function resources.check_spaces(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_actor uuid := (p->>'actor')::uuid;
  v_role text;
  v_change record;
  v_row resources.spaces;
  v_parent resources.spaces;
  v_kind resources.space_kinds;
  v_depth int;
  v_cur uuid;
  v_key text;
  v_value jsonb;
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('spaces', 'space_kinds')) then
    return;
  end if;
  select role into v_role from core.memberships where app = 'resources' and user_id = v_actor;

  -- Estructura (crear, mover, cambiar el tipo, archivar o borrar): solo el owner. El editor cambia datos y orden.
  if v_role is distinct from 'owner' and v_actor is not null then
    for v_change in select c.op, c.before, c.after from core.changes c
                     where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'spaces' loop
      if v_change.op in ('insert', 'delete', 'restore')
         or (v_change.op = 'update' and ((v_change.before->>'parent_id') is distinct from (v_change.after->>'parent_id')
                                       or (v_change.before->>'kind') is distinct from (v_change.after->>'kind')
                                       or (v_change.before->>'active') is distinct from (v_change.after->>'active')
                                       or (v_change.before->'source_refs') is distinct from (v_change.after->'source_refs'))) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.spaces', 'reason', 'structure changes need owner'));
      end if;
    end loop;
  end if;

  -- Cada espacio tocado en el lote: tipo válido, padre permitido, profundidad, sin ciclos y datos propios del tipo.
  for v_row in select s.* from resources.spaces s
                where s.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                and c.schema_name = 'resources' and c.table_name = 'spaces')
                  and s.deleted_at is null loop
    select * into v_kind from resources.space_kinds where kind = v_row.kind and deleted_at is null;
    if v_kind.id is null then
      perform core.fail('INVALID_SPACE_KIND', 422, jsonb_build_object('id', v_row.id, 'kind', v_row.kind));
    end if;
    if v_row.parent_id is null then
      if not ('root' = any(v_kind.parents)) then
        perform core.fail('INVALID_SPACE_PARENT', 422, jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'parent', 'root'));
      end if;
    else
      select * into v_parent from resources.spaces where id = v_row.parent_id;
      if v_parent.id is null or v_parent.deleted_at is not null then
        perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'resources.spaces', 'id', v_row.id));
      end if;
      if not (v_parent.kind = any(v_kind.parents)) then
        perform core.fail('INVALID_SPACE_PARENT', 422, jsonb_build_object('id', v_row.id, 'kind', v_row.kind, 'parent', v_parent.kind));
      end if;
    end if;
    -- Ancestros: sin ciclos y como mucho cuatro niveles.
    v_depth := 1; v_cur := v_row.parent_id;
    while v_cur is not null loop
      v_depth := v_depth + 1;
      if v_cur = v_row.id or v_depth > 4 then
        perform core.fail('INVALID_SPACE_PARENT', 422, jsonb_build_object('id', v_row.id, 'reason', case when v_cur = v_row.id then 'cycle' else 'depth' end));
      end if;
      select parent_id into v_cur from resources.spaces where id = v_cur;
    end loop;
    if v_row.kind = 'altura' and v_row.name !~ '^Altura [1-5]$' then
      perform core.fail('INVALID_SPACE_NAME', 422, jsonb_build_object('id', v_row.id, 'reason', 'altura is named Altura 1 to Altura 5'));
    end if;
    for v_key, v_value in select key, value from jsonb_each(v_row.attributes) loop
      if not (v_key = any(v_kind.attribute_keys)) then
        perform core.fail('INVALID_SPACE_ATTRIBUTE', 422, jsonb_build_object('id', v_row.id, 'attribute', v_key));
      end if;
      if (v_key in ('bookable', 'accessible', 'en_suite') and jsonb_typeof(v_value) <> 'boolean')
         or (v_key in ('capacity', 'extra_capacity') and not (jsonb_typeof(v_value) = 'number' and (v_value::text)::numeric between 0 and 999 and (v_value::text)::numeric = trunc((v_value::text)::numeric)))
         or (v_key = 'bed_kind' and not (jsonb_typeof(v_value) = 'string' and v_value #>> '{}' in ('individual', 'doble', 'litera', 'sofa_cama')))
         or (v_key = 'storage' and not (jsonb_typeof(v_value) = 'string' and v_value #>> '{}' in ('ambiente', 'frio', 'congelado'))) then
        perform core.fail('INVALID_SPACE_ATTRIBUTE', 422, jsonb_build_object('id', v_row.id, 'attribute', v_key));
      end if;
    end loop;
  end loop;

  -- Nada vivo ni activo dentro de algo borrado o archivado: se archiva o se borra «con todo lo de dentro» en el mismo lote.
  select s.* into v_row from resources.spaces s join resources.spaces parent on parent.id = s.parent_id
   where s.deleted_at is null and (parent.deleted_at is not null or (s.active and not parent.active)) limit 1;
  if v_row.id is not null then
    perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'resources.spaces', 'id', v_row.id));
  end if;
  -- Un tipo en uso no se borra ni se archiva.
  if exists (select 1 from resources.space_kinds k where (k.deleted_at is not null or not k.active)
               and exists (select 1 from resources.spaces s where s.kind = k.kind and s.deleted_at is null and s.active)
               and not exists (select 1 from resources.space_kinds k2 where k2.kind = k.kind and k2.deleted_at is null and k2.active)) then
    perform core.fail('SPACE_KIND_IN_USE', 422, jsonb_build_object('table', 'resources.space_kinds'));
  end if;
end $$;


do $$
declare v_ops jsonb;
begin
  select jsonb_agg(jsonb_build_object('op', 'update', 'table', 'resources.space_kinds', 'id', k.id, 'expectedRevision', k.revision,
           'fields', jsonb_build_object('parents', to_jsonb(array['habitacion', 'sala']), 'attribute_keys', to_jsonb(array['bed_kind', 'capacity', 'extra_capacity']))))
    into v_ops
    from resources.space_kinds k where k.kind = 'cama' and k.deleted_at is null;
  if v_ops is not null then
    perform core.apply_migration_operations('resources', 'migration:resources-0801-camas', v_ops);
  end if;
end $$;
