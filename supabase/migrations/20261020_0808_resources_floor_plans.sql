-- Ikisai Recursos · mapa de zonas, bloque B (MUELA-024, aprobado por VG el 15-10-2026; arranque autorizado el 20-10-2026).
-- - `resources.floor_plans`: el dibujo de fondo de cada edificio y planta (SVG, PNG o JPG subido al bucket privado
--   `resources-plans`), con su tamaño en unidades de la imagen. Lo gestiona el owner; lo leen todos los miembros.
-- - `resources.spaces.plan_id` + `plan_shape`: en qué dibujo está cada estancia y su forma, como puntos relativos a la
--   imagen (0..1). Sin forma, la estancia sale solo en la lista equivalente. Colocar es cosa del owner.
-- - El dibujo no lleva ids, textos ni colores: la capa de estancias la pinta el kit (`createSpaceMap`) encima.
-- Decisiones de Core Sevilla (20-10-2026): las literas siguen siendo camas con su capacidad (no cambia Booking); la planta
-- es un dato del dibujo (`floor`). Toca solo el schema resources.

create table resources.floor_plans (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  building_id uuid not null references resources.spaces(id),
  floor text check (floor is null or length(btrim(floor)) between 1 and 40),
  position numeric not null default 0,
  file_id uuid,
  width numeric not null check (width > 0 and width <= 100000),
  height numeric not null check (height > 0 and height <= 100000),
  notes text check (notes is null or length(notes) <= 1000)
);
create unique index floor_plans_building_floor_idx on resources.floor_plans (building_id, lower(coalesce(btrim(floor), '')))
  where deleted_at is null;
select core.register_table('resources', 'resources', 'floor_plans',
  array['building_id', 'floor', 'position', 'file_id', 'width', 'height', 'notes'], '{reader,editor,owner}', '{owner}');
select core.register_file_field('resources', 'resources', 'floor_plans', 'file_id', 'operational');

alter table resources.spaces add column plan_id uuid references resources.floor_plans(id);
alter table resources.spaces add column plan_shape jsonb;
select core.register_table('resources', 'resources', 'spaces',
  array['parent_id', 'kind', 'name', 'public_name', 'code', 'position', 'active', 'notes', 'attributes', 'source_refs', 'plan_id', 'plan_shape']);

-- Forma válida: {"points": [[x, y], …]} con 3 a 200 puntos, cada coordenada entre 0 y 1.
create or replace function resources.valid_plan_shape(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'object' and jsonb_typeof(p->'points') = 'array'
    and jsonb_array_length(p->'points') between 3 and 200
    and not exists (
      select 1 from jsonb_array_elements(p->'points') pt
       where jsonb_typeof(pt) <> 'array' or jsonb_array_length(pt) <> 2
          or jsonb_typeof(pt->0) <> 'number' or jsonb_typeof(pt->1) <> 'number'
          or (pt->>0)::numeric not between 0 and 1 or (pt->>1)::numeric not between 0 and 1))
$$;
alter table resources.spaces add constraint spaces_plan_shape_check check (resources.valid_plan_shape(plan_shape));

-- Colocar en el plano es del owner (el editor sigue cambiando nombre, datos y orden, como hasta ahora).
create or replace function resources.check_plans(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_actor uuid := (p->>'actor')::uuid;
  v_role text;
  v_change record;
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('spaces', 'floor_plans')) then
    return;
  end if;
  select role into v_role from core.memberships where app = 'resources' and user_id = v_actor;
  if v_role is distinct from 'owner' and v_actor is not null then
    for v_change in select c.op, c.before, c.after from core.changes c
                     where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'spaces' loop
      if v_change.op = 'update' and ((v_change.before->>'plan_id') is distinct from (v_change.after->>'plan_id')
                                     or (v_change.before->'plan_shape') is distinct from (v_change.after->'plan_shape')) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.spaces', 'reason', 'placing on the plan needs owner'));
      end if;
    end loop;
  end if;
  -- Un dibujo borrado no se queda con estancias colocadas encima.
  if exists (select 1 from resources.spaces s join resources.floor_plans f on f.id = s.plan_id
              where f.deleted_at is not null and s.deleted_at is null) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.spaces', 'field', 'plan_id', 'reason', 'plan deleted'));
  end if;
end $$;
select core.add_validate_hook('resources', 'resources.check_plans');

revoke all on function resources.valid_plan_shape(jsonb), resources.check_plans(jsonb) from public, anon, authenticated;
grant execute on function resources.valid_plan_shape(jsonb), resources.check_plans(jsonb) to service_role;
