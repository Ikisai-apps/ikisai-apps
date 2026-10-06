-- Food · lista de compra y plan de preparación derivados del menú (docs/food/API.md §2.3, §2.4, §3.2, §3.3).
-- Toca solo el schema food. Todo error de dominio es 422; las escrituras van por core.apply_row_op.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table food.shopping_lists (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete cascade,
  status text not null default 'borrador' check (status in ('borrador','revisada','cerrada')),
  generated_at timestamptz not null default now(),
  source_revisions jsonb not null default '{}'::jsonb,
  notes text
);
create unique index shopping_lists_menu_key on food.shopping_lists (menu_id) where deleted_at is null;

create table food.shopping_list_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  shopping_list_id uuid not null references food.shopping_lists(id) on delete cascade,
  ingredient_id uuid not null references food.ingredients(id) on delete restrict,
  required_quantity numeric(12,3) not null default 0 check (required_quantity >= 0),
  unit text not null check (unit in ('g','kg','ml','l','unidad','paquete','manojo','otro')),
  stock_quantity numeric(12,3) check (stock_quantity is null or stock_quantity >= 0),
  purchase_quantity numeric(12,3) not null check (purchase_quantity >= 0),
  supplier text check (supplier is null or length(supplier) <= 120),
  status text not null default 'pendiente' check (status in ('pendiente','comprado','recibido')),
  manual_override boolean not null default false,
  manual boolean not null default false,
  notes text
);
create index shopping_list_items_list_idx on food.shopping_list_items (shopping_list_id) where deleted_at is null;
create index shopping_list_items_ingredient_idx on food.shopping_list_items (ingredient_id);
create unique index shopping_list_items_calc_key on food.shopping_list_items (shopping_list_id, ingredient_id, unit)
  where deleted_at is null and not manual;

create table food.preparation_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete cascade,
  menu_item_id uuid references food.menu_items(id) on delete set null,
  recipe_id uuid references food.recipes(id) on delete set null,
  scheduled_date date,
  scheduled_time time,
  text text not null check (length(btrim(text)) between 1 and 300),
  responsible text check (responsible is null or length(responsible) <= 120),
  done boolean not null default false,
  position numeric not null default 0,
  manual boolean not null default false
);
create index preparation_items_menu_idx on food.preparation_items (menu_id, scheduled_date, scheduled_time, position);

-- ---------------------------------------------------------------------------
-- Unidades: solo se convierte dentro de masa (g↔kg) y de volumen (ml↔l). Mismo criterio que _domain/food/units.ts.
-- ---------------------------------------------------------------------------
create or replace function food.unit_family(p_unit text)
returns text language sql immutable as $$
  select case when p_unit in ('g','kg') then 'masa' when p_unit in ('ml','l') then 'volumen' else p_unit end;
$$;

create or replace function food.unit_factor(p_unit text)
returns numeric language sql immutable as $$
  select case when p_unit in ('kg','l') then 1000 else 1 end::numeric;
$$;

-- Unidad de salida de un total: la preferida del ingrediente si es de la familia; si no, kg o l desde 1000 y g o ml por debajo.
create or replace function food.output_unit(p_family text, p_base_total numeric, p_preferred text)
returns text language sql immutable as $$
  select case
    when p_family not in ('masa','volumen') then p_family
    when food.unit_family(p_preferred) = p_family then p_preferred
    when p_family = 'masa' then case when p_base_total >= 1000 then 'kg' else 'g' end
    else case when p_base_total >= 1000 then 'l' else 'ml' end
  end;
$$;

-- ---------------------------------------------------------------------------
-- Reglas de fila (422)
-- ---------------------------------------------------------------------------
create or replace function food.guard_shopping_list()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.menu_id <> old.menu_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id'));
  end if;
  return new;
end $$;
create trigger food_guard_shopping_list before update on food.shopping_lists
  for each row execute function food.guard_shopping_list();

-- Líneas: lista inmutable; una lista cerrada no admite cambios en sus líneas; ni lista ni ingrediente borrados.
create or replace function food.guard_shopping_item()
returns trigger language plpgsql as $$
declare v_list food.shopping_lists;
begin
  if tg_op = 'UPDATE' and new.shopping_list_id <> old.shopping_list_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'shopping_list_id'));
  end if;
  select * into v_list from food.shopping_lists where id = new.shopping_list_id;
  if v_list.id is null then return new; end if;
  if v_list.status = 'cerrada' then
    perform core.fail('LIST_CLOSED', 422, jsonb_build_object('list_id', v_list.id));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    if v_list.deleted_at is not null then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'shopping_lists', 'id', v_list.id));
    end if;
    if exists (select 1 from food.ingredients i where i.id = new.ingredient_id and i.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'ingredients', 'id', new.ingredient_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_shopping_item before insert or update on food.shopping_list_items
  for each row execute function food.guard_shopping_item();

create or replace function food.guard_preparation_item()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.menu_id <> old.menu_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id'));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and exists (select 1 from food.menus m where m.id = new.menu_id and m.deleted_at is not null) then
    perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menus', 'id', new.menu_id));
  end if;
  return new;
end $$;
create trigger food_guard_preparation_item before insert or update on food.preparation_items
  for each row execute function food.guard_preparation_item();

-- ---------------------------------------------------------------------------
-- Registro en el núcleo (las columnas calculadas solo las escriben los procedimientos; la Edge las rechaza en operaciones de fila)
-- ---------------------------------------------------------------------------
select core.register_table('food', 'food', 'shopping_lists', array['menu_id','status','generated_at','source_revisions','notes']);
select core.register_table('food', 'food', 'shopping_list_items', array[
  'shopping_list_id','ingredient_id','required_quantity','unit','stock_quantity','purchase_quantity','supplier','status','manual_override','manual','notes']);
select core.register_table('food', 'food', 'preparation_items', array[
  'menu_id','menu_item_id','recipe_id','scheduled_date','scheduled_time','text','responsible','done','position','manual']);

-- ---------------------------------------------------------------------------
-- Conjuntos de revisiones de origen (obsolescencia, §2.4): {"<id de fila>": revisión}
-- ---------------------------------------------------------------------------
create or replace function food.shopping_sources(p_menu uuid)
returns jsonb language sql stable as $$
  with i as (select mi.* from food.menu_items mi join food.menu_services s on s.id = mi.service_id
             where s.menu_id = p_menu and s.deleted_at is null and mi.deleted_at is null),
       r as (select * from food.recipes where id in (select recipe_id from i)),
       l as (select * from food.recipe_ingredients where recipe_id in (select id from r) and deleted_at is null),
       g as (select * from food.ingredients where id in (select ingredient_id from l))
  select coalesce(jsonb_object_agg(x.id::text, x.revision), '{}'::jsonb) from (
    select id, revision from i union all select id, revision from r union all select id, revision from l union all select id, revision from g) x;
$$;

create or replace function food.preparation_sources(p_menu uuid)
returns jsonb language sql stable as $$
  with s as (select * from food.menu_services where menu_id = p_menu and deleted_at is null),
       i as (select * from food.menu_items where service_id in (select id from s) and deleted_at is null),
       r as (select * from food.recipes where id in (select recipe_id from i))
  select coalesce(jsonb_object_agg(x.id::text, x.revision), '{}'::jsonb) from (
    select id, revision from s union all select id, revision from i union all select id, revision from r) x;
$$;

-- ---------------------------------------------------------------------------
-- food.regenerate_shopping: raciones × cantidad ÷ raciones base, agrupado por ingrediente y familia de unidad.
-- Conserva lo que el usuario tocó: «en casa», «comprar» fijado a mano, proveedor, estado, notas y líneas manuales.
-- ---------------------------------------------------------------------------
create or replace function food.regenerate_shopping(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_list food.shopping_lists; v_item food.shopping_list_items; v_created boolean := false;
  v_sources jsonb; r record; v_required numeric; v_fields jsonb; v_seen uuid[] := '{}'; v_new uuid; v_ratio numeric;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_status text;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;
  v_sources := food.shopping_sources(v_menu.id);

  select * into v_list from food.shopping_lists where menu_id = v_menu.id and deleted_at is null for update;
  if v_list.id is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.shopping_lists', 'id', a->>'list_id',
      'fields', jsonb_build_object('menu_id', v_menu.id, 'generated_at', now(), 'source_revisions', v_sources)));
    select * into v_list from food.shopping_lists where id = (a->>'list_id')::uuid;
    v_created := true;
  elsif v_list.status = 'cerrada' then
    perform core.fail('LIST_CLOSED', 422, jsonb_build_object('list_id', v_list.id));
  end if;

  for r in
    with lines as (
      select ri.ingredient_id, food.unit_family(ri.unit) as family,
             sum(ri.quantity * food.unit_factor(ri.unit) * mi.servings / rc.base_servings) as base_total
      from food.menu_items mi
      join food.menu_services s on s.id = mi.service_id
      join food.recipes rc on rc.id = mi.recipe_id
      join food.recipe_ingredients ri on ri.recipe_id = rc.id
      where s.menu_id = v_menu.id and s.deleted_at is null and mi.deleted_at is null and ri.deleted_at is null
      group by 1, 2)
    select l.ingredient_id, l.family, l.base_total, g.preferred_supplier, food.output_unit(l.family, l.base_total, g.preferred_unit) as unit
    from lines l join food.ingredients g on g.id = l.ingredient_id
    order by l.ingredient_id, l.family
  loop
    v_required := round(r.base_total / food.unit_factor(r.unit), 3);
    select * into v_item from food.shopping_list_items i
      where i.shopping_list_id = v_list.id and i.ingredient_id = r.ingredient_id and not i.manual and i.deleted_at is null
        and food.unit_family(i.unit) = r.family
      order by i.created_at, i.id limit 1;
    if v_item.id is null then
      v_new := gen_random_uuid();
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.shopping_list_items', 'id', v_new,
        'fields', jsonb_build_object('shopping_list_id', v_list.id, 'ingredient_id', r.ingredient_id, 'required_quantity', v_required,
          'unit', r.unit, 'purchase_quantity', v_required, 'supplier', r.preferred_supplier)));
      v_seen := v_seen || v_new;
      v_inserted := v_inserted + 1;
    else
      v_seen := v_seen || v_item.id;
      v_fields := '{}'::jsonb;
      if v_item.unit <> r.unit then
        -- Misma familia, otra unidad de salida: lo que el usuario anotó se convierte.
        v_ratio := food.unit_factor(v_item.unit) / food.unit_factor(r.unit);
        v_item.stock_quantity := round(v_item.stock_quantity * v_ratio, 3);
        v_item.purchase_quantity := round(v_item.purchase_quantity * v_ratio, 3);
        v_fields := jsonb_build_object('unit', r.unit, 'stock_quantity', v_item.stock_quantity, 'purchase_quantity', v_item.purchase_quantity);
      end if;
      if v_item.required_quantity <> v_required then v_fields := v_fields || jsonb_build_object('required_quantity', v_required); end if;
      if not v_item.manual_override and v_item.purchase_quantity <> greatest(v_required - coalesce(v_item.stock_quantity, 0), 0) then
        v_fields := v_fields || jsonb_build_object('purchase_quantity', greatest(v_required - coalesce(v_item.stock_quantity, 0), 0));
      end if;
      if v_fields = '{}'::jsonb then
        v_kept := v_kept + 1;
      else
        perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
          'op', 'update', 'table', 'food.shopping_list_items', 'id', v_item.id, 'expectedRevision', v_item.revision, 'fields', v_fields));
        v_updated := v_updated + 1;
      end if;
    end if;
  end loop;

  -- Líneas calculadas que ya no hacen falta: fuera si nadie las tocó; si no, se conservan con necesidad 0.
  for v_item in
    select * from food.shopping_list_items i
    where i.shopping_list_id = v_list.id and not i.manual and i.deleted_at is null and not (i.id = any(v_seen))
  loop
    if v_item.status = 'pendiente' and not v_item.manual_override then
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'delete', 'table', 'food.shopping_list_items', 'id', v_item.id, 'expectedRevision', v_item.revision));
      v_deleted := v_deleted + 1;
    elsif v_item.required_quantity <> 0 then
      v_fields := jsonb_build_object('required_quantity', 0);
      if not v_item.manual_override then v_fields := v_fields || jsonb_build_object('purchase_quantity', 0); end if;
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'update', 'table', 'food.shopping_list_items', 'id', v_item.id, 'expectedRevision', v_item.revision, 'fields', v_fields));
      v_updated := v_updated + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;

  v_status := case when v_list.status = 'revisada' then 'borrador' else v_list.status end;
  if not v_created then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'update', 'table', 'food.shopping_lists', 'id', v_list.id, 'expectedRevision', v_list.revision,
      'fields', jsonb_build_object('generated_at', now(), 'source_revisions', v_sources, 'status', v_status)));
  end if;
  return jsonb_build_object('list_id', v_list.id, 'created', v_created, 'inserted', v_inserted, 'updated', v_updated,
    'deleted', v_deleted, 'kept', v_kept, 'status', v_status);
end $$;

-- ---------------------------------------------------------------------------
-- food.regenerate_preparation: una propuesta por plato vivo, «Preparar <receta>», a la hora del servicio menos la
-- antelación de la receta (120 minutos por defecto). No toca lo que el cocinero reescribió ni lo ya hecho.
-- ---------------------------------------------------------------------------
create or replace function food.regenerate_preparation(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_prep food.preparation_items; r record; v_when timestamp; v_date date; v_time time; v_text text;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null for update;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;

  for r in
    select mi.id as item_id, mi.recipe_id, rc.name, rc.prep_minutes, s.service_date, s.service_time
    from food.menu_items mi
    join food.menu_services s on s.id = mi.service_id
    join food.recipes rc on rc.id = mi.recipe_id
    where s.menu_id = v_menu.id and s.deleted_at is null and mi.deleted_at is null
    order by s.service_date, s.service_time nulls last, s.position, mi.position, mi.id
  loop
    v_text := left('Preparar ' || r.name, 300);
    if r.service_time is null then
      v_date := r.service_date; v_time := null;
    else
      v_when := (r.service_date + r.service_time) - make_interval(mins => coalesce(r.prep_minutes, 120));
      v_date := v_when::date; v_time := v_when::time;
    end if;
    select * into v_prep from food.preparation_items x
      where x.menu_id = v_menu.id and x.menu_item_id = r.item_id and x.deleted_at is null
      order by x.created_at, x.id limit 1;
    if v_prep.id is null then
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.preparation_items', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('menu_id', v_menu.id, 'menu_item_id', r.item_id, 'recipe_id', r.recipe_id,
          'scheduled_date', v_date, 'scheduled_time', v_time, 'text', v_text)));
      v_inserted := v_inserted + 1;
    elsif not v_prep.manual and not v_prep.done
          and (v_prep.text, v_prep.scheduled_date, v_prep.scheduled_time) is distinct from (v_text, v_date, v_time) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'update', 'table', 'food.preparation_items', 'id', v_prep.id, 'expectedRevision', v_prep.revision,
        'fields', jsonb_build_object('scheduled_date', v_date, 'scheduled_time', v_time, 'text', v_text)));
      v_updated := v_updated + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;

  -- Propuestas de platos que ya no están en el menú: fuera, salvo que estén hechas o el cocinero las hiciera suyas.
  for v_prep in
    select x.* from food.preparation_items x
    where x.menu_id = v_menu.id and x.deleted_at is null and not x.manual and not x.done and x.menu_item_id is not null
      and not exists (
        select 1 from food.menu_items mi join food.menu_services s on s.id = mi.service_id
        where mi.id = x.menu_item_id and mi.deleted_at is null and s.deleted_at is null)
  loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'delete', 'table', 'food.preparation_items', 'id', v_prep.id, 'expectedRevision', v_prep.revision));
    v_deleted := v_deleted + 1;
  end loop;

  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
    'op', 'update', 'table', 'food.menus', 'id', v_menu.id, 'expectedRevision', v_menu.revision,
    'fields', jsonb_build_object('preparation_generated_at', now(), 'preparation_source_revisions', food.preparation_sources(v_menu.id))));
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted, 'kept', v_kept);
end $$;

select core.allow_procedure('food', 'food.regenerate_shopping');
select core.allow_procedure('food', 'food.regenerate_preparation');
