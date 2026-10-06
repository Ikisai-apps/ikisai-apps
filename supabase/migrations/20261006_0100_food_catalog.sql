-- Food · app registrada y catálogo: recetas, ingredientes y maquinaria (docs/food/API.md §2.1, §4.2, §7.2).
-- Toca solo el schema food.
select core.ensure_app('food', 'Ikisai Food', 'food.ikisai.com');

create schema if not exists food;
revoke all on schema food from public;
revoke all on schema food from anon, authenticated;
grant usage on schema food to service_role;

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table food.recipes (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 160),
  public_name text check (public_name is null or length(public_name) <= 160),
  public_description text check (public_description is null or length(public_description) <= 600),
  category text not null check (category in ('desayuno','entrante','principal','guarnicion','postre','picnic','merienda','bebida','base','otro')),
  base_servings numeric(8,2) not null check (base_servings > 0),
  method text,
  conservation text,
  freezable boolean not null default false,
  regeneration text,
  service_notes text,
  prep_minutes integer check (prep_minutes is null or prep_minutes between 0 and 2880),
  status text not null default 'en_prueba' check (status in ('en_prueba','validada','archivada')),
  diet_tags text[] not null default '{}' check (diet_tags <@ array['vegetariano','vegano','sin_gluten','sin_lactosa']::text[]),
  allergens text[] not null default '{}' check (allergens <@ array['gluten','crustaceos','huevos','pescado','cacahuetes','soja','lacteos','frutos_de_cascara','apio','mostaza','sesamo','sulfitos','altramuces','moluscos']::text[]),
  allergens_checked boolean not null default false,
  photo_file_id uuid references core.files(id),
  photo_thumb_file_id uuid references core.files(id)
);
create index recipes_name_idx on food.recipes (lower(name)) where deleted_at is null;
create index recipes_status_idx on food.recipes (status) where deleted_at is null;

create table food.ingredients (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 120),
  preferred_unit text not null default 'g' check (preferred_unit in ('g','kg','ml','l','unidad','paquete','manojo','otro')),
  preferred_supplier text check (preferred_supplier is null or length(preferred_supplier) <= 120),
  active boolean not null default true
);
create unique index ingredients_name_key on food.ingredients (lower(btrim(name))) where deleted_at is null;

create table food.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  recipe_id uuid not null references food.recipes(id) on delete cascade,
  ingredient_id uuid not null references food.ingredients(id) on delete restrict,
  quantity numeric(12,3) not null check (quantity > 0),
  unit text not null check (unit in ('g','kg','ml','l','unidad','paquete','manojo','otro')),
  position numeric not null default 0,
  notes text
);
create index recipe_ingredients_recipe_idx on food.recipe_ingredients (recipe_id) where deleted_at is null;
create index recipe_ingredients_ingredient_idx on food.recipe_ingredients (ingredient_id);

create table food.equipment (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 120),
  category text check (category is null or length(category) <= 60),
  quantity integer not null default 1 check (quantity >= 0),
  capacity text,
  location text,
  status text not null default 'operativo' check (status in ('operativo','limitado','averiado','fuera_de_servicio')),
  notes text
);

create table food.recipe_equipment (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  recipe_id uuid not null references food.recipes(id) on delete cascade,
  equipment_id uuid not null references food.equipment(id) on delete restrict,
  quantity_required integer not null default 1 check (quantity_required >= 1),
  notes text
);
create index recipe_equipment_recipe_idx on food.recipe_equipment (recipe_id) where deleted_at is null;
create index recipe_equipment_equipment_idx on food.recipe_equipment (equipment_id);

-- ---------------------------------------------------------------------------
-- Reglas de fila. Fallan con 422 para que el cliente offline aparte el lote en vez de reintentarlo.
-- Los commits de una app están serializados por core.app_state, así que estas comprobaciones no tienen carreras.
-- ---------------------------------------------------------------------------
create or replace function food.guard_recipe()
returns trigger language plpgsql as $$
begin
  if new.status = 'validada' and not new.allergens_checked then
    perform core.fail('ALLERGENS_UNCHECKED', 422, jsonb_build_object('id', new.id));
  end if;
  return new;
end $$;
create trigger food_guard_recipe before insert or update on food.recipes
  for each row execute function food.guard_recipe();

create or replace function food.guard_ingredient()
returns trigger language plpgsql as $$
declare v_other uuid; v_uses int;
begin
  if new.deleted_at is null then
    select i.id into v_other from food.ingredients i
      where i.id <> new.id and i.deleted_at is null and lower(btrim(i.name)) = lower(btrim(new.name)) limit 1;
    if v_other is not null then
      perform core.fail('DUPLICATE_NAME', 422, jsonb_build_object('existingId', v_other, 'name', new.name));
    end if;
  elsif tg_op = 'UPDATE' and old.deleted_at is null then
    select count(*) into v_uses from food.recipe_ingredients ri join food.recipes r on r.id = ri.recipe_id
      where ri.ingredient_id = new.id and ri.deleted_at is null and r.deleted_at is null;
    if v_uses > 0 then
      perform core.fail('INGREDIENT_IN_USE', 422, jsonb_build_object('id', new.id, 'uses', v_uses));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_ingredient before insert or update on food.ingredients
  for each row execute function food.guard_ingredient();

create or replace function food.guard_equipment()
returns trigger language plpgsql as $$
declare v_uses int;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    select count(*) into v_uses from food.recipe_equipment re join food.recipes r on r.id = re.recipe_id
      where re.equipment_id = new.id and re.deleted_at is null and r.deleted_at is null;
    if v_uses > 0 then
      perform core.fail('EQUIPMENT_IN_USE', 422, jsonb_build_object('id', new.id, 'uses', v_uses));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_equipment before update on food.equipment
  for each row execute function food.guard_equipment();

-- Líneas de receta: recipe_id inmutable; no se inserta ni se restaura bajo una receta borrada ni con un ingrediente borrado.
create or replace function food.guard_recipe_ingredient()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.recipe_id <> old.recipe_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'recipe_id'));
  end if;
  if new.deleted_at is null then
    if (tg_op = 'INSERT' or old.deleted_at is not null)
       and exists (select 1 from food.recipes r where r.id = new.recipe_id and r.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'recipes', 'id', new.recipe_id));
    end if;
    if (tg_op = 'INSERT' or old.deleted_at is not null or new.ingredient_id <> old.ingredient_id)
       and exists (select 1 from food.ingredients i where i.id = new.ingredient_id and i.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'ingredients', 'id', new.ingredient_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_recipe_ingredient before insert or update on food.recipe_ingredients
  for each row execute function food.guard_recipe_ingredient();

create or replace function food.guard_recipe_equipment()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.recipe_id <> old.recipe_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'recipe_id'));
  end if;
  if new.deleted_at is null then
    if (tg_op = 'INSERT' or old.deleted_at is not null)
       and exists (select 1 from food.recipes r where r.id = new.recipe_id and r.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'recipes', 'id', new.recipe_id));
    end if;
    if (tg_op = 'INSERT' or old.deleted_at is not null or new.equipment_id <> old.equipment_id)
       and exists (select 1 from food.equipment e where e.id = new.equipment_id and e.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'equipment', 'id', new.equipment_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_recipe_equipment before insert or update on food.recipe_equipment
  for each row execute function food.guard_recipe_equipment();

-- ---------------------------------------------------------------------------
-- Registro en el núcleo
-- ---------------------------------------------------------------------------
select core.register_table('food', 'food', 'recipes', array[
  'name','public_name','public_description','category','base_servings','method','conservation','freezable','regeneration',
  'service_notes','prep_minutes','status','diet_tags','allergens','allergens_checked','photo_file_id','photo_thumb_file_id']);
select core.register_table('food', 'food', 'ingredients', array['name','preferred_unit','preferred_supplier','active']);
select core.register_table('food', 'food', 'recipe_ingredients', array['recipe_id','ingredient_id','quantity','unit','position','notes']);
select core.register_table('food', 'food', 'equipment', array['name','category','quantity','capacity','location','status','notes']);
select core.register_table('food', 'food', 'recipe_equipment', array['recipe_id','equipment_id','quantity_required','notes']);

-- ---------------------------------------------------------------------------
-- Proyecciones para Invoices: destinos de asignación food:ingredient y food:equipment. Sin datos personales.
-- ---------------------------------------------------------------------------
create view food.invoices_ingredient_projection as
  select i.id as ingredient_id, i.name, i.preferred_unit, i.active, i.revision as ingredient_revision
  from food.ingredients i where i.deleted_at is null;

create view food.invoices_equipment_projection as
  select e.id as equipment_id, e.name, e.category, e.status, e.revision as equipment_revision
  from food.equipment e where e.deleted_at is null;

revoke all on food.invoices_ingredient_projection, food.invoices_equipment_projection from public, anon, authenticated;
grant select on food.invoices_ingredient_projection, food.invoices_equipment_projection to service_role;

select core.allow_read('invoices', 'food.invoices_ingredient_projection', 'view');
select core.allow_read('invoices', 'food.invoices_equipment_projection', 'view');
