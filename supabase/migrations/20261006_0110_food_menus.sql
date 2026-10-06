-- Food · menú por evento: menús, servicios y platos, con sus reglas de fila (docs/food/API.md §2.2, §4.2),
-- y una proyección de pruebas de eventos mientras Booking no publica la suya. Toca solo el schema food.

-- ---------------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------------
create table food.menus (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id) on delete restrict,
  source_event_revision bigint not null check (source_event_revision >= 1),
  source_event_snapshot jsonb,
  status text not null default 'borrador' check (status in ('borrador','revisar','validado','cerrado')),
  validated_at timestamptz,
  validated_by uuid references auth.users(id),
  validated_warnings jsonb,
  preparation_generated_at timestamptz,
  preparation_source_revisions jsonb,
  notes text,
  closing_notes text
);
create unique index menus_event_key on food.menus (event_id) where deleted_at is null;

create table food.menu_services (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete cascade,
  service_date date not null,
  service_type text not null check (service_type in ('desayuno','comida','cena','picnic','merienda','otro')),
  service_time time,
  position numeric not null default 0,
  notes text
);
create index menu_services_menu_idx on food.menu_services (menu_id, service_date, position);

create table food.menu_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  service_id uuid not null references food.menu_services(id) on delete cascade,
  recipe_id uuid not null references food.recipes(id) on delete restrict,
  servings numeric(8,2) not null check (servings > 0),
  position numeric not null default 0,
  notes text
);
create index menu_items_service_idx on food.menu_items (service_id);
create index menu_items_recipe_idx on food.menu_items (recipe_id);

-- ---------------------------------------------------------------------------
-- Reglas de fila (422)
-- ---------------------------------------------------------------------------
-- Menú: event_id inmutable, un menú vivo por evento y no se borra un menú validado o cerrado.
create or replace function food.guard_menu()
returns trigger language plpgsql as $$
declare v_other uuid;
begin
  if tg_op = 'UPDATE' then
    if new.event_id <> old.event_id then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'event_id'));
    end if;
    if new.deleted_at is not null and old.deleted_at is null and old.status in ('validado','cerrado') then
      perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', new.id, 'status', old.status));
    end if;
  end if;
  if new.deleted_at is null then
    select m.id into v_other from food.menus m where m.event_id = new.event_id and m.id <> new.id and m.deleted_at is null limit 1;
    if v_other is not null then
      perform core.fail('MENU_EXISTS', 422, jsonb_build_object('menuId', v_other, 'event_id', new.event_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_menu before insert or update on food.menus
  for each row execute function food.guard_menu();

-- Servicios: menu_id inmutable; el menú validado o cerrado no admite cambios; nada cuelga de un menú borrado.
create or replace function food.guard_menu_service()
returns trigger language plpgsql as $$
declare v_menu food.menus;
begin
  if tg_op = 'UPDATE' and new.menu_id <> old.menu_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id'));
  end if;
  select * into v_menu from food.menus where id = new.menu_id;
  if v_menu.id is null then return new; end if;
  if v_menu.status in ('validado','cerrado') then
    perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', v_menu.id, 'status', v_menu.status));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) and v_menu.deleted_at is not null then
    perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menus', 'id', v_menu.id));
  end if;
  return new;
end $$;
create trigger food_guard_menu_service before insert or update on food.menu_services
  for each row execute function food.guard_menu_service();

-- Platos: service_id inmutable; mismo bloqueo; ni servicio ni receta borrados.
create or replace function food.guard_menu_item()
returns trigger language plpgsql as $$
declare v_service food.menu_services; v_menu food.menus;
begin
  if tg_op = 'UPDATE' and new.service_id <> old.service_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'service_id'));
  end if;
  select * into v_service from food.menu_services where id = new.service_id;
  if v_service.id is null then return new; end if;
  select * into v_menu from food.menus where id = v_service.menu_id;
  if v_menu.status in ('validado','cerrado') then
    perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', v_menu.id, 'status', v_menu.status));
  end if;
  if new.deleted_at is null then
    if (tg_op = 'INSERT' or old.deleted_at is not null) and v_service.deleted_at is not null then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menu_services', 'id', v_service.id));
    end if;
    if (tg_op = 'INSERT' or old.deleted_at is not null or new.recipe_id <> old.recipe_id)
       and exists (select 1 from food.recipes r where r.id = new.recipe_id and r.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'recipes', 'id', new.recipe_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_menu_item before insert or update on food.menu_items
  for each row execute function food.guard_menu_item();

-- Una receta con platos vivos no se borra: se archiva.
create or replace function food.guard_recipe_in_use()
returns trigger language plpgsql as $$
declare v_uses int;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    select count(*) into v_uses
      from food.menu_items mi
      join food.menu_services s on s.id = mi.service_id
      join food.menus m on m.id = s.menu_id
      where mi.recipe_id = new.id and mi.deleted_at is null and s.deleted_at is null and m.deleted_at is null;
    if v_uses > 0 then
      perform core.fail('RECIPE_IN_USE', 422, jsonb_build_object('id', new.id, 'uses', v_uses));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_recipe_in_use before update on food.recipes
  for each row execute function food.guard_recipe_in_use();

-- ---------------------------------------------------------------------------
-- Registro en el núcleo. Las columnas de estado, validación y preparación solo las escriben los procedimientos;
-- figuran aquí porque core.apply_row_op valida contra esta lista y la Edge las rechaza en operaciones de fila.
-- ---------------------------------------------------------------------------
select core.register_table('food', 'food', 'menus', array[
  'event_id','source_event_revision','source_event_snapshot','status','validated_at','validated_by','validated_warnings',
  'preparation_generated_at','preparation_source_revisions','notes','closing_notes']);
select core.register_table('food', 'food', 'menu_services', array['menu_id','service_date','service_type','service_time','position','notes']);
select core.register_table('food', 'food', 'menu_items', array['service_id','recipe_id','servings','position','notes']);

-- ---------------------------------------------------------------------------
-- Proyección de pruebas de eventos. Mismas columnas que booking.food_event_projection (docs/booking/API.md §7.1,
-- con su ampliación propuesta). Cada fila describe un evento real de Booking, de modo que los menús conservan su FK.
-- food-api la usa solo mientras Booking no registre su proyección para Food; después se retira en otra migración.
-- ---------------------------------------------------------------------------
create table food.stub_events (
  id uuid primary key references booking.events(id) on delete cascade,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_code text,
  reservation_code text,
  title text not null,
  event_type text,
  start_date date not null,
  end_date date not null,
  arrival_time time,
  departure_time time,
  guest_count integer check (guest_count is null or guest_count >= 0),
  minors_count integer not null default 0,
  meal_plan text,
  menu_style text,
  dietary_restrictions jsonb not null default '[]'::jsonb,
  event_revision bigint not null default 1 check (event_revision >= 1),
  reservation_status text,
  guest_count_is_final boolean not null default false,
  requires_meals boolean not null default true,
  meal_notes text
);
select core.register_table('food', 'food', 'stub_events', array[
  'event_code','reservation_code','title','event_type','start_date','end_date','arrival_time','departure_time','guest_count',
  'minors_count','meal_plan','menu_style','dietary_restrictions','event_revision','reservation_status','guest_count_is_final',
  'requires_meals','meal_notes'], '{owner}', '{owner}');

create view food.event_projection_stub as
  select s.id as event_id, s.event_code, s.reservation_code, s.title, s.event_type, s.start_date, s.end_date,
         s.arrival_time, s.departure_time, s.guest_count, s.minors_count, s.meal_plan, s.menu_style,
         s.dietary_restrictions, s.event_revision, s.reservation_status, s.guest_count_is_final, s.requires_meals, s.meal_notes
  from food.stub_events s where s.deleted_at is null;
revoke all on food.event_projection_stub from public, anon, authenticated;
grant select on food.event_projection_stub to service_role;
select core.allow_read('food', 'food.event_projection_stub', 'view');
