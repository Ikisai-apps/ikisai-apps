-- Ikisai Recursos · finca y decoración sobre el plano (encargo de VG del 27-10-2026; diseño en
-- MUELA/equipo/feedback/recursos/DECORACION_Y_FINCA.md; forma acordada con UI-kit y Central). Toca solo el schema resources.
--
-- 1. `resources.floor_plans` gana:
--    - `kind` ('building' | 'estate'): el plano de la finca es un dibujo `estate` colgado de un espacio raíz de tipo `exterior`
--      («Finca»); sus «estancias» son los edificios y exteriores (spaces.plan_id + plan_shape, como hoy);
--    - `grid` ({metersPerUnit, originX, originY}, en unidades del dibujo): la retícula; sin ella no se decora;
--    - `bands` ([{name, y0, y1}] en 0..1): las alturas como franjas;
--    - `contours` ([{spaceId, x, y}] en 0..1): dónde va la etiqueta de la curva de nivel de cada altura.
-- 2. Cada altura gana el atributo `elevation_m` (metros sobre el mar), que editan editor y owner como los demás datos.
-- 3. `resources.decor_icons`: los iconos (SVG, PNG o GIF de hasta 1 MB) que sube el owner, con su tamaño por defecto.
-- 4. `resources.decor_items`: la decoración por celdas. La capa `general` la escribe el owner por commands; la de un evento
--    (`event`: añadir, retirar o sustituir respecto a la general) solo `resources.set_event_decor`, que llama quien es editor
--    u owner de Booking.
-- 5. `resources.space_images`: siluetas, secciones y fotos de edificios y exteriores (hasta 5 MB), del owner.
-- 6. Lecturas: `resources.portal_plans` (0809) gana todo lo anterior, solo la capa general y nunca personas; y
--    `resources.plans_with_decor`, interna para Central y Booking, con las dos capas sin resolver.

-- ---------------------------------------------------------------------------
-- 1. Dibujos: tipo, retícula, franjas y curvas de nivel
-- ---------------------------------------------------------------------------
alter table resources.floor_plans add column kind text not null default 'building' check (kind in ('building', 'estate'));
alter table resources.floor_plans add column grid jsonb;
alter table resources.floor_plans add column bands jsonb;
alter table resources.floor_plans add column contours jsonb;

-- Retícula: {"metersPerUnit": >0, "originX": n, "originY": n}; el origen, opcional (0), en unidades del dibujo.
create or replace function resources.valid_plan_grid(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and jsonb_typeof(p->'metersPerUnit') = 'number' and (p->>'metersPerUnit')::numeric > 0 and (p->>'metersPerUnit')::numeric <= 1000
    and (p->'originX' is null or (jsonb_typeof(p->'originX') = 'number' and abs((p->>'originX')::numeric) <= 100000))
    and (p->'originY' is null or (jsonb_typeof(p->'originY') = 'number' and abs((p->>'originY')::numeric) <= 100000))
    and not exists (select 1 from jsonb_object_keys(p) k where k not in ('metersPerUnit', 'originX', 'originY')))
$$;

-- Franjas: de 1 a 10, cada una {name, y0, y1} con 0 <= y0 < y1 <= 1.
create or replace function resources.valid_plan_bands(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 10
    and not exists (
      select 1 from jsonb_array_elements(p) b
       where jsonb_typeof(b) <> 'object' or jsonb_typeof(b->'name') <> 'string' or length(btrim(b->>'name')) not between 1 and 40
          or jsonb_typeof(b->'y0') <> 'number' or jsonb_typeof(b->'y1') <> 'number'
          or (b->>'y0')::numeric < 0 or (b->>'y1')::numeric > 1 or (b->>'y0')::numeric >= (b->>'y1')::numeric))
$$;

-- Curvas: de 1 a 20, cada una {spaceId (uuid), x, y} con x e y en 0..1 (dónde va la etiqueta).
create or replace function resources.valid_plan_contours(p jsonb)
returns boolean language sql immutable as $$
  select p is null or (
    jsonb_typeof(p) = 'array' and jsonb_array_length(p) between 1 and 20
    and not exists (
      select 1 from jsonb_array_elements(p) c
       where jsonb_typeof(c) <> 'object' or jsonb_typeof(c->'spaceId') <> 'string'
          or (c->>'spaceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          or jsonb_typeof(c->'x') <> 'number' or jsonb_typeof(c->'y') <> 'number'
          or (c->>'x')::numeric not between 0 and 1 or (c->>'y')::numeric not between 0 and 1))
$$;

alter table resources.floor_plans add constraint floor_plans_grid_check check (resources.valid_plan_grid(grid));
alter table resources.floor_plans add constraint floor_plans_bands_check check (resources.valid_plan_bands(bands));
alter table resources.floor_plans add constraint floor_plans_contours_check check (resources.valid_plan_contours(contours));
select core.register_table('resources', 'resources', 'floor_plans',
  array['building_id', 'floor', 'position', 'file_id', 'width', 'height', 'notes', 'kind', 'grid', 'bands', 'contours'], '{reader,editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- 2. Cota de cada altura (atributo `elevation_m`)
-- ---------------------------------------------------------------------------
update resources.space_kinds set attribute_keys = array_append(attribute_keys, 'elevation_m')
where kind = 'altura' and not ('elevation_m' = any(attribute_keys));

-- La de 0801 con `elevation_m`: un número de metros sobre el mar, de -500 a 9000.
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
         or (v_key = 'storage' and not (jsonb_typeof(v_value) = 'string' and v_value #>> '{}' in ('ambiente', 'frio', 'congelado')))
         or (v_key = 'elevation_m' and not (jsonb_typeof(v_value) = 'number' and (v_value::text)::numeric between -500 and 9000)) then
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

-- ---------------------------------------------------------------------------
-- 3. Iconos de decoración
-- ---------------------------------------------------------------------------
create table resources.decor_icons (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 80),
  category text not null check (length(btrim(category)) between 1 and 40),
  file_id uuid not null,
  -- Tamaño por defecto: 1 = una celda (0,5 m a la escala fina) · 4 = 2×2 celdas.
  default_size smallint not null default 1 check (default_size in (1, 4)),
  created_by uuid references auth.users(id)
);
create index decor_icons_category_idx on resources.decor_icons (category, name) where deleted_at is null;
select core.register_table('resources', 'resources', 'decor_icons', array['name', 'category', 'file_id', 'default_size'], '{reader,editor,owner}', '{owner}');
select core.register_file_field('resources', 'resources', 'decor_icons', 'file_id', 'operational');

-- Quién lo subió: el autor del alta (no se escribe a mano ni cambia después).
create or replace function resources.decor_icon_author()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.created_by := new.updated_by; else new.created_by := old.created_by; end if;
  return new;
end $$;
create trigger decor_icons_author before insert or update on resources.decor_icons for each row execute function resources.decor_icon_author();

-- ---------------------------------------------------------------------------
-- 4. Decoración por celdas (capa general y capa de evento)
-- ---------------------------------------------------------------------------
create table resources.decor_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  plan_id uuid not null references resources.floor_plans(id),
  icon_id uuid references resources.decor_icons(id),
  -- Celda en la escala elegida (metros por celda), contada desde el origen de la retícula del dibujo.
  cell_x integer not null check (cell_x between 0 and 100000),
  cell_y integer not null check (cell_y between 0 and 100000),
  scale numeric not null default 1 check (scale in (0.5, 1, 5)),
  size smallint not null default 1 check (size in (1, 4)),
  rotation smallint not null default 0 check (rotation in (0, 90, 180, 270)),
  layer text not null default 'general' check (layer in ('general', 'event')),
  -- Id del evento de Booking (enlace tipado `booking.event`), solo en la capa de evento.
  event_id uuid,
  op text not null default 'add' check (op in ('add', 'remove', 'replace')),
  replaces_item_id uuid references resources.decor_items(id),
  constraint decor_items_layer check ((layer = 'general') = (event_id is null)),
  constraint decor_items_op check (
    (op = 'add' and replaces_item_id is null and icon_id is not null)
    or (op = 'remove' and replaces_item_id is not null)
    or (op = 'replace' and replaces_item_id is not null and icon_id is not null)),
  constraint decor_items_general_add check (layer = 'event' or op = 'add')
);
create index decor_items_plan_idx on resources.decor_items (plan_id, layer) where deleted_at is null;
create index decor_items_event_idx on resources.decor_items (event_id) where deleted_at is null and event_id is not null;
-- Escriben editor y owner; el hook deja la capa general al owner y la de evento solo a `set_event_decor`.
select core.register_table('resources', 'resources', 'decor_items',
  array['plan_id', 'icon_id', 'cell_x', 'cell_y', 'scale', 'size', 'rotation', 'layer', 'event_id', 'op', 'replaces_item_id'],
  '{reader,editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- 5. Imágenes de edificios y exteriores
-- ---------------------------------------------------------------------------
create table resources.space_images (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  space_id uuid not null references resources.spaces(id),
  kind text not null check (kind in ('silueta', 'seccion', 'foto')),
  title text check (title is null or length(btrim(title)) between 1 and 120),
  file_id uuid not null,
  position numeric not null default 0
);
create index space_images_space_idx on resources.space_images (space_id, position) where deleted_at is null;
select core.register_table('resources', 'resources', 'space_images', array['space_id', 'kind', 'title', 'file_id', 'position'], '{reader,editor,owner}', '{owner}');
select core.register_file_field('resources', 'resources', 'space_images', 'file_id', 'operational');

-- ---------------------------------------------------------------------------
-- 6. Reglas del lote
-- ---------------------------------------------------------------------------
create or replace function resources.check_decor(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_actor uuid := (p->>'actor')::uuid;
  v_role text;
  v_change record;
  v_item resources.decor_items;
  v_target resources.decor_items;
  v_plan resources.floor_plans;
  v_space resources.spaces;
  v_side int;
  v_mpu numeric;
  -- Las piezas de evento que escribió `set_event_decor` en esta transacción (solo esas pasan).
  v_event_ids text := ',' || coalesce(current_setting('resources.event_decor_ids', true), '') || ',';
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('floor_plans', 'decor_icons', 'decor_items', 'space_images', 'spaces')) then
    return;
  end if;
  select role into v_role from core.memberships where app = 'resources' and user_id = v_actor;

  -- Quién escribe cada capa: la general, el owner; la de evento, solo `set_event_decor`. Ninguna pieza cambia de capa.
  for v_change in select c.row_id, c.op, c.before, c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'decor_items' loop
    if (v_change.before->>'layer') is distinct from (v_change.after->>'layer') and v_change.before is not null and v_change.after is not null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'field', 'layer', 'reason', 'layer is fixed'));
    end if;
    if coalesce(v_change.after->>'layer', v_change.before->>'layer') = 'event' then
      if position(',' || v_change.row_id::text || ',' in v_event_ids) = 0 then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'reason', 'event layer is written with resources.set_event_decor'));
      end if;
    elsif v_role is distinct from 'owner' and v_actor is not null then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'reason', 'general decoration needs owner'));
    end if;
  end loop;

  -- Cada pieza viva tocada: dibujo vivo con retícula, icono vivo, dentro del dibujo y, si sustituye o retira, una pieza
  -- general viva del mismo dibujo (así no hay cadenas ni ciclos).
  for v_item in select d.* from resources.decor_items d
                 where d.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                 and c.schema_name = 'resources' and c.table_name = 'decor_items')
                   and d.deleted_at is null loop
    select * into v_plan from resources.floor_plans where id = v_item.plan_id;
    if v_plan.id is null or v_plan.deleted_at is not null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'id', v_item.id, 'field', 'plan_id', 'reason', 'plan deleted'));
    end if;
    if v_plan.grid is null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'id', v_item.id, 'field', 'plan_id', 'reason', 'plan has no grid'));
    end if;
    if v_item.icon_id is not null and not exists (select 1 from resources.decor_icons i where i.id = v_item.icon_id and i.deleted_at is null) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'id', v_item.id, 'field', 'icon_id', 'reason', 'icon deleted'));
    end if;
    v_side := case when v_item.size = 4 then 2 else 1 end;
    v_mpu := (v_plan.grid->>'metersPerUnit')::numeric;
    if (v_item.cell_x + v_side) * v_item.scale > v_plan.width * v_mpu or (v_item.cell_y + v_side) * v_item.scale > v_plan.height * v_mpu then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'id', v_item.id, 'field', 'cell_x', 'reason', 'outside the drawing'));
    end if;
    if v_item.replaces_item_id is not null then
      select * into v_target from resources.decor_items where id = v_item.replaces_item_id;
      if v_target.id is null or v_target.deleted_at is not null or v_target.layer <> 'general' or v_target.plan_id <> v_item.plan_id then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_items', 'id', v_item.id, 'field', 'replaces_item_id',
          'reason', 'replaces a live general piece of the same plan'));
      end if;
    end if;
  end loop;

  -- Nada vivo apunta a algo borrado: un dibujo o un icono con decoración no se borra, y una pieza general con cambios de
  -- evento encima tampoco.
  if exists (select 1 from resources.decor_items d join resources.floor_plans f on f.id = d.plan_id where d.deleted_at is null and f.deleted_at is not null) then
    perform core.fail('PLAN_HAS_DECOR', 422, jsonb_build_object('table', 'resources.floor_plans'));
  end if;
  if exists (select 1 from resources.decor_items d join resources.decor_icons i on i.id = d.icon_id where d.deleted_at is null and i.deleted_at is not null) then
    perform core.fail('ICON_IN_USE', 422, jsonb_build_object('table', 'resources.decor_icons'));
  end if;
  if exists (select 1 from resources.decor_items d join resources.decor_items t on t.id = d.replaces_item_id where d.deleted_at is null and t.deleted_at is not null) then
    perform core.fail('DECOR_REPLACED', 422, jsonb_build_object('table', 'resources.decor_items', 'reason', 'an event layer changes this piece'));
  end if;
  -- Una retícula no se quita de un dibujo decorado.
  if exists (select 1 from resources.floor_plans f where f.grid is null and f.deleted_at is null
               and exists (select 1 from resources.decor_items d where d.plan_id = f.id and d.deleted_at is null)) then
    perform core.fail('PLAN_HAS_DECOR', 422, jsonb_build_object('table', 'resources.floor_plans', 'field', 'grid'));
  end if;

  -- Archivos: icono SVG, PNG o GIF de hasta 1 MB; imagen PNG, JPG, WebP o SVG de hasta 5 MB. Del módulo y verificados.
  if exists (select 1 from resources.decor_icons i
               where i.deleted_at is null and i.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                                       and c.schema_name = 'resources' and c.table_name = 'decor_icons')
                 and not exists (select 1 from core.files f where f.id = i.file_id and f.app = 'resources' and f.status = 'verified'
                                   and f.mime in ('image/svg+xml', 'image/png', 'image/gif') and f.size <= 1048576)) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.decor_icons', 'field', 'file_id', 'reason', 'SVG, PNG or GIF up to 1 MB'));
  end if;
  for v_change in select s.id, s.space_id, s.file_id from resources.space_images s
                   where s.deleted_at is null and s.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                                           and c.schema_name = 'resources' and c.table_name = 'space_images') loop
    if not exists (select 1 from core.files f where f.id = v_change.file_id and f.app = 'resources' and f.status = 'verified'
                     and f.mime in ('image/svg+xml', 'image/png', 'image/jpeg', 'image/webp') and f.size <= 5242880) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.space_images', 'id', v_change.id, 'field', 'file_id', 'reason', 'PNG, JPG, WebP or SVG up to 5 MB'));
    end if;
    if not exists (select 1 from resources.spaces s where s.id = v_change.space_id and s.deleted_at is null and s.kind in ('edificio', 'exterior')) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.space_images', 'id', v_change.id, 'field', 'space_id', 'reason', 'a building or an outdoor space'));
    end if;
  end loop;

  -- Finca: un dibujo `estate` cuelga de un exterior raíz; solo lleva edificios y exteriores, y sus curvas son de alturas.
  -- Un dibujo `building` nunca cuelga de un espacio que tiene plano de finca.
  for v_plan in select f.* from resources.floor_plans f
                 where f.deleted_at is null and f.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                                         and c.schema_name = 'resources' and c.table_name = 'floor_plans') loop
    select * into v_space from resources.spaces where id = v_plan.building_id;
    if v_plan.kind = 'estate' and (v_space.kind <> 'exterior' or v_space.parent_id is not null) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.floor_plans', 'id', v_plan.id, 'field', 'building_id', 'reason', 'an estate hangs from a root outdoor space'));
    end if;
    if v_plan.kind = 'building' and exists (select 1 from resources.floor_plans e where e.building_id = v_plan.building_id and e.kind = 'estate' and e.deleted_at is null) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.floor_plans', 'id', v_plan.id, 'field', 'kind', 'reason', 'this space has an estate plan'));
    end if;
    if v_plan.contours is not null and exists (
         select 1 from jsonb_array_elements(v_plan.contours) c
          where not exists (select 1 from resources.spaces s where s.id = (c->>'spaceId')::uuid and s.kind = 'altura' and s.deleted_at is null)) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.floor_plans', 'id', v_plan.id, 'field', 'contours', 'reason', 'contours are of alturas'));
    end if;
  end loop;
  if exists (select 1 from resources.spaces s join resources.floor_plans f on f.id = s.plan_id
              where s.deleted_at is null and f.deleted_at is null and f.kind = 'estate' and s.kind not in ('edificio', 'exterior')) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.spaces', 'field', 'plan_id', 'reason', 'an estate plan holds buildings and outdoor spaces'));
  end if;
end $$;
select core.add_validate_hook('resources', 'resources.check_decor');

-- ---------------------------------------------------------------------------
-- 7. La capa de un evento (Booking)
-- ---------------------------------------------------------------------------
-- Quien es editor u owner de Booking cambia la decoración de un evento respecto a la general: `put` crea o cambia piezas de
-- esa capa (`op` add, remove o replace; con `id` y `expectedRevision` si ya existe) y `delete` quita las suyas. Se llama
-- desde booking-api con el token de la persona: `POST /api/v1/resources/commands` con `{op: 'call', procedure:
-- 'resources.set_event_decor', args: {event_id, put?, delete?}}`. Devuelve los ids escritos.
create or replace function resources.set_event_decor(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_event uuid; v_item jsonb; v_id uuid; v_row resources.decor_items; v_fields jsonb; v_out jsonb := '[]'::jsonb;
begin
  if v_actor is null or not exists (select 1 from core.memberships m where m.app = 'booking' and m.user_id = v_actor and m.role in ('editor', 'owner')) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'event decoration is set from Booking'));
  end if;
  begin v_event := (a->>'event_id')::uuid; exception when others then v_event := null; end;
  -- Que el evento exista lo comprueba booking-api antes de llamar (Recursos no lee tablas ni vistas de Booking).
  if v_event is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'event_id'));
  end if;
  if (a->'put' is not null and jsonb_typeof(a->'put') <> 'array') or (a->'delete' is not null and jsonb_typeof(a->'delete') <> 'array')
     or coalesce(jsonb_array_length(a->'put'), 0) + coalesce(jsonb_array_length(a->'delete'), 0) not between 1 and 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'put/delete', 'reason', 'between 1 and 200 changes'));
  end if;

  for v_item in select value from jsonb_array_elements(coalesce(a->'put', '[]'::jsonb)) loop
    v_fields := jsonb_strip_nulls(jsonb_build_object(
      'plan_id', v_item->'plan_id', 'icon_id', v_item->'icon_id', 'cell_x', v_item->'cell_x', 'cell_y', v_item->'cell_y',
      'scale', v_item->'scale', 'size', v_item->'size', 'rotation', v_item->'rotation', 'op', v_item->'op',
      'replaces_item_id', v_item->'replaces_item_id'));
    begin v_id := (v_item->>'id')::uuid; exception when others then v_id := null; end;
    select * into v_row from resources.decor_items where id = v_id;
    if v_row.id is not null then
      if v_row.layer <> 'event' or v_row.event_id <> v_event then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'id', v_id, 'reason', 'not a piece of this event'));
      end if;
      perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'update', 'table', 'resources.decor_items', 'id', v_id,
        'expectedRevision', coalesce(v_item->'expectedRevision', to_jsonb(v_row.revision)), 'fields', v_fields));
    else
      v_id := coalesce(v_id, gen_random_uuid());
      perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.decor_items', 'id', v_id,
        'fields', v_fields || jsonb_build_object('layer', 'event', 'event_id', v_event)));
    end if;
    v_out := v_out || to_jsonb(v_id);
  end loop;
  for v_item in select value from jsonb_array_elements(coalesce(a->'delete', '[]'::jsonb)) loop
    begin v_id := (v_item #>> '{}')::uuid; exception when others then v_id := null; end;
    select * into v_row from resources.decor_items where id = v_id and deleted_at is null;
    if v_row.id is null or v_row.layer <> 'event' or v_row.event_id <> v_event then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.decor_items', 'id', v_id, 'reason', 'not a piece of this event'));
    end if;
    perform set_config('resources.event_decor_ids', concat_ws(',', nullif(current_setting('resources.event_decor_ids', true), ''), v_id::text), true);
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'delete', 'table', 'resources.decor_items', 'id', v_id,
      'expectedRevision', to_jsonb(v_row.revision)));
    v_out := v_out || to_jsonb(v_id);
  end loop;
  return jsonb_build_object('eventId', v_event, 'ids', v_out);
end $$;
select core.allow_procedure('resources', 'resources.set_event_decor');

-- ---------------------------------------------------------------------------
-- 8. Lecturas
-- ---------------------------------------------------------------------------
-- Lo común de las dos lecturas: dibujos con retícula, franjas y curvas (con la cota de cada altura), espacios, iconos e
-- imágenes. Nunca personas, notas ni datos internos. Los archivos los firma la Edge del portal o de la app.
create or replace function resources.plans_base()
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'plans', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', f.id, 'buildingId', f.building_id, 'floor', f.floor, 'position', f.position, 'kind', f.kind,
               'width', f.width, 'height', f.height, 'grid', f.grid, 'bands', f.bands,
               'contours', (select jsonb_agg(jsonb_build_object('spaceId', s.id, 'label', coalesce(s.public_name, s.name),
                                    'elevationM', s.attributes->'elevation_m', 'x', c->'x', 'y', c->'y'))
                              from jsonb_array_elements(f.contours) c join resources.spaces s on s.id = (c->>'spaceId')::uuid and s.deleted_at is null),
               'file', case when cf.id is null then null else jsonb_build_object(
                 'id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider) end)
             order by f.position, f.floor)
        from resources.floor_plans f
        left join core.files cf on cf.id = f.file_id and cf.app = 'resources' and cf.status = 'verified' and cf.mime like 'image/%'
       where f.deleted_at is null), '[]'::jsonb),
    'spaces', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'parentId', s.parent_id, 'kind', s.kind, 'name', coalesce(s.public_name, s.name),
               'planId', s.plan_id, 'planShape', s.plan_shape, 'position', s.position)
             order by s.position, s.name)
        from resources.spaces s
       where s.deleted_at is null and s.active), '[]'::jsonb),
    'icons', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', i.id, 'name', i.name, 'category', i.category, 'defaultSize', i.default_size,
               'file', jsonb_build_object('id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider))
             order by i.category, i.name)
        from resources.decor_icons i
        join core.files cf on cf.id = i.file_id and cf.app = 'resources' and cf.status = 'verified'
       where i.deleted_at is null), '[]'::jsonb),
    'images', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'spaceId', m.space_id, 'kind', m.kind, 'title', m.title, 'position', m.position,
               'file', jsonb_build_object('id', cf.id, 'bucket', cf.bucket, 'path', cf.path, 'mime', cf.mime, 'sha256', cf.sha256, 'provider', cf.storage_provider))
             order by m.space_id, m.position)
        from resources.space_images m
        join core.files cf on cf.id = m.file_id and cf.app = 'resources' and cf.status = 'verified'
       where m.deleted_at is null), '[]'::jsonb))
$$;

create or replace function resources.decor_json(p_layer text, p_event uuid)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', d.id, 'planId', d.plan_id, 'iconId', d.icon_id, 'cellX', d.cell_x, 'cellY', d.cell_y, 'scale', d.scale,
           'size', d.size, 'rotation', d.rotation, 'layer', d.layer, 'eventId', d.event_id, 'op', d.op, 'replacesItemId', d.replaces_item_id)
         order by d.plan_id, d.created_at), '[]'::jsonb)
    from resources.decor_items d
   where d.deleted_at is null and (p_layer is null or d.layer = p_layer) and (p_event is null or d.layer = 'general' or d.event_id = p_event)
$$;

-- Portales (Guests y Organizers): lo de 0809 más la finca, los iconos, las imágenes y solo la decoración general.
create or replace function resources.portal_plans(p jsonb)
returns jsonb language sql stable as $$
  select resources.plans_base() || jsonb_build_object('decor', resources.decor_json('general', null))
$$;
select core.allow_read('organizers', 'resources.portal_plans', 'function', '{editor,owner}');

-- Central y Booking (miembros de Recursos): las dos capas sin resolver; con `event_id`, la general y la de ese evento.
create or replace function resources.plans_with_decor(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid;
begin
  begin v_event := nullif(p->'args'->>'event_id', '')::uuid; exception when others then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'event_id'));
  end;
  return resources.plans_base() || jsonb_build_object('decor', resources.decor_json(null, v_event));
end $$;
select core.allow_read('resources', 'resources.plans_with_decor', 'function', '{reader,editor,owner}');

revoke all on function resources.valid_plan_grid(jsonb), resources.valid_plan_bands(jsonb), resources.valid_plan_contours(jsonb),
  resources.check_spaces(jsonb), resources.decor_icon_author(), resources.check_decor(jsonb), resources.set_event_decor(jsonb),
  resources.plans_base(), resources.decor_json(text, uuid), resources.portal_plans(jsonb), resources.plans_with_decor(jsonb)
  from public, anon, authenticated;
grant execute on function resources.valid_plan_grid(jsonb), resources.valid_plan_bands(jsonb), resources.valid_plan_contours(jsonb),
  resources.check_spaces(jsonb), resources.decor_icon_author(), resources.check_decor(jsonb), resources.set_event_decor(jsonb),
  resources.plans_base(), resources.decor_json(text, uuid), resources.portal_plans(jsonb), resources.plans_with_decor(jsonb)
  to service_role;
