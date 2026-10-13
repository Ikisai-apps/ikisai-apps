-- Ikisai Recursos · espacios: un solo árbol de sitios para todas las apps (Booking, Tasks, Food, inventario).
-- Diseño aprobado por el usuario el 13-10-2026: coordinacion/ampliacion/RECURSOS.md §4 y §11.1; docs/resources/API.md.
-- Toca solo el schema resources. El módulo `resources` lo registra el núcleo (0091_core_resources_module).
--
-- Árbol de cuatro niveles como mucho: Altura (1–5) › Edificio o Exterior › Espacio › Subespacio (cama, ubicación).
-- Editar nombre, datos y notas, y ordenar entre hermanos: editor. Crear, mover, cambiar el tipo o archivar: owner.

create schema if not exists resources;
revoke all on schema resources from public;
revoke all on schema resources from anon, authenticated;
grant usage on schema resources to service_role;

-- ---------------------------------------------------------------------------
-- Tipos de espacio: ampliables sin tocar el código (los gestiona el owner)
-- ---------------------------------------------------------------------------
create table resources.space_kinds (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (length(btrim(label)) between 1 and 40),
  level smallint not null check (level between 1 and 4),
  -- De qué tipos puede colgar; `root` = de la raíz.
  parents text[] not null default '{}' check (cardinality(parents) between 1 and 20),
  -- Datos propios que admite (`attributes` de cada espacio): bookable, capacity, accessible, en_suite, bed_kind, storage.
  attribute_keys text[] not null default '{}',
  position numeric not null default 0,
  active boolean not null default true
);
create unique index space_kinds_kind_idx on resources.space_kinds (kind) where deleted_at is null;

select core.register_table('resources', 'resources', 'space_kinds',
  array['kind', 'label', 'level', 'parents', 'attribute_keys', 'position', 'active'],
  '{reader,editor,owner}', '{owner}');

insert into resources.space_kinds (kind, label, level, parents, attribute_keys, position) values
  ('altura', 'Altura', 1, '{root}', '{}', 10),
  ('edificio', 'Edificio', 2, '{altura,root}', '{accessible}', 20),
  ('exterior', 'Exterior', 2, '{altura,root}', '{bookable,capacity,accessible}', 30),
  ('habitacion', 'Habitación', 3, '{edificio,exterior}', '{bookable,capacity,accessible,en_suite}', 40),
  ('sala', 'Sala', 3, '{edificio,exterior}', '{bookable,capacity,accessible}', 50),
  ('bano', 'Baño', 3, '{edificio,exterior}', '{accessible}', 60),
  ('cocina', 'Cocina', 3, '{edificio,exterior}', '{capacity,accessible}', 70),
  ('comedor', 'Comedor', 3, '{edificio,exterior}', '{bookable,capacity,accessible}', 80),
  ('oficina', 'Oficina', 3, '{edificio,exterior}', '{capacity,accessible}', 90),
  ('zona_paso', 'Zona de paso', 3, '{edificio,exterior}', '{accessible}', 100),
  ('instalacion', 'Instalación técnica', 3, '{edificio,exterior}', '{}', 110),
  ('almacen', 'Almacén', 3, '{edificio,exterior}', '{storage}', 120),
  ('otro', 'Otro', 3, '{edificio,exterior}', '{bookable,capacity,accessible}', 130),
  ('cama', 'Cama', 4, '{habitacion}', '{bed_kind,capacity}', 140),
  ('ubicacion', 'Ubicación', 4, '{almacen,cocina,comedor,instalacion,otro}', '{storage}', 150);

-- ---------------------------------------------------------------------------
-- Espacios
-- ---------------------------------------------------------------------------
create table resources.spaces (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  parent_id uuid references resources.spaces(id),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  name text not null check (length(btrim(name)) between 1 and 80),
  -- Nombre para huéspedes y organizadores; sin él, se usa `name`.
  public_name text check (public_name is null or length(btrim(public_name)) between 1 and 80),
  code text check (code is null or code ~ '^[A-Za-z0-9._-]{1,20}$'),
  position numeric not null default 0,
  active boolean not null default true,
  notes text check (notes is null or length(notes) <= 1000),
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  check (parent_id is null or parent_id <> id)
);
create index spaces_parent_idx on resources.spaces (parent_id) where deleted_at is null;
create unique index spaces_sibling_name_idx on resources.spaces
  (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(name))) where deleted_at is null;
create unique index spaces_code_idx on resources.spaces (lower(code)) where deleted_at is null and code is not null;

select core.register_table('resources', 'resources', 'spaces',
  array['parent_id', 'kind', 'name', 'public_name', 'code', 'position', 'active', 'notes', 'attributes']);

-- Las cinco alturas (usuario, 13-10-2026): el nombre es el número; la descripción, en las notas.
insert into resources.spaces (kind, name, position, notes) values
  ('altura', 'Altura 1', 1, 'Edificio de salas'),
  ('altura', 'Altura 2', 2, 'Entre edificios'),
  ('altura', 'Altura 3', 3, 'Albergue'),
  ('altura', 'Altura 4', 4, 'Piscina'),
  ('altura', 'Altura 5', 5, 'Depósito');

-- ---------------------------------------------------------------------------
-- Invariantes y permisos, al final de cada lote
-- ---------------------------------------------------------------------------
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
                                       or (v_change.before->>'active') is distinct from (v_change.after->>'active'))) then
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
         or (v_key = 'capacity' and not (jsonb_typeof(v_value) = 'number' and (v_value::text)::numeric between 0 and 999 and (v_value::text)::numeric = trunc((v_value::text)::numeric)))
         or (v_key = 'bed_kind' and not (jsonb_typeof(v_value) = 'string' and v_value #>> '{}' in ('individual', 'doble', 'litera')))
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

select core.add_validate_hook('resources', 'resources.check_spaces');
