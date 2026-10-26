-- Food · la carta (decisión de VG del 26-10-2026, encargo de Core para el servicio del sábado 31; docs/food/API.md §2.10).
-- Toca solo el schema food; lee resources (módulo común) y registra una lectura cruzada para Flow.
--
-- Food tiene dos tipos de menú: el «cerrado» de siempre (`kind` 'retiro' o 'casa') y la **carta** (`kind = 'carta'`).
-- - Una carta tiene nombre, puede estar ligada a un evento o guardada sin él, y se reutiliza copiándola en otro evento
--   (así cada evento conserva sus precios y sus ventas). No tiene servicios ni platos: tiene **líneas**.
-- - `food.carta_lines`: una receta (montaditos) o un artículo de Recursos (bebidas, palomitas), con ámbito
--   ('clasico', 'gourmet', 'barra'), código (A–D, α–δ; único por carta y ámbito entre las vivas), precio de venta en
--   céntimos, activa o no, posición e imagen (`<categoria>/<slug>`). Los cambios de precio y de disponibilidad quedan en
--   core.changes con su autor.
-- - `food.carta_sales`: lo vendido por línea y día. Solo lo escribe `food.record_carta_sales`, idempotente por
--   (carta, día): otra llamada el mismo día sustituye, no suma. El stock lo ajusta después food-api en Recursos
--   (`food.carta_stock_plan`), con la cuenta de servicio `food` y `source_ref = 'carta:<menu>:<día>'`.
-- - `food.carta_projection`: la carta para Flow (nombres acordados con Flow el 26-10), con el coste por unidad desde el
--   inventario (coste medio de Recursos) y los alérgenos de la receta, con si están revisados.

-- ---------------------------------------------------------------------------
-- 1. El tipo de menú «carta» y su nombre
-- ---------------------------------------------------------------------------
do $$
declare v_name text;
begin
  -- El check de `kind` se creó en línea en 0194 (sin nombre propio): se busca por su definición.
  for v_name in select c.conname from pg_constraint c
                 where c.conrelid = 'food.menus'::regclass and c.contype = 'c'
                   and pg_get_constraintdef(c.oid) ilike '%kind%retiro%casa%' and c.conname <> 'menus_kind_event' loop
    execute format('alter table food.menus drop constraint %I', v_name);
  end loop;
end $$;
alter table food.menus add constraint menus_kind_check check (kind in ('retiro', 'casa', 'carta'));
alter table food.menus drop constraint menus_kind_event;
alter table food.menus add constraint menus_kind_event check (
  (kind = 'retiro' and event_id is not null and source_event_revision is not null)
  or (kind = 'casa' and event_id is null and source_event_revision is null and source_event_snapshot is null)
  or (kind = 'carta' and source_event_revision is null and source_event_snapshot is null));
alter table food.menus add column name text check (name is null or length(btrim(name)) between 1 and 120);
alter table food.menus add constraint menus_carta_name check (kind <> 'carta' or name is not null);

-- Un menú cerrado vivo por evento (como hasta ahora) y, aparte, como mucho una carta viva por evento.
drop index food.menus_event_key;
create unique index menus_event_key on food.menus (event_id) where deleted_at is null and kind <> 'carta';
create unique index menus_carta_event_key on food.menus (event_id) where deleted_at is null and kind = 'carta' and event_id is not null;

-- Menú: kind inmutable; event_id inmutable salvo en una carta (se liga o se desliga de un evento); un menú cerrado vivo
-- por evento y una carta viva por evento; un solo menú de casa, que ni se borra ni cambia de estado; no se borra un
-- retiro validado o cerrado. La carta no pasa por los estados del menú cerrado: siempre «borrador».
create or replace function food.guard_menu()
returns trigger language plpgsql as $$
declare v_other uuid;
begin
  if tg_op = 'UPDATE' then
    if new.kind <> old.kind then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'kind'));
    end if;
    if new.event_id is distinct from old.event_id and new.kind <> 'carta' then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'event_id'));
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      if old.kind = 'casa' then
        perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'delete'));
      end if;
      if old.status in ('validado','cerrado') then
        perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', new.id, 'status', old.status));
      end if;
    end if;
    if new.kind = 'casa' and new.status <> old.status then
      perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'status'));
    end if;
  end if;
  if new.kind = 'carta' and new.status <> 'borrador' then
    perform core.fail('CARTA_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'status'));
  end if;
  if tg_op = 'INSERT' and new.kind = 'casa' and new.status <> 'borrador' then
    perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'status'));
  end if;
  if new.deleted_at is null then
    if new.event_id is not null then
      select m.id into v_other from food.menus m
       where m.event_id = new.event_id and m.id <> new.id and m.deleted_at is null and (m.kind = 'carta') = (new.kind = 'carta') limit 1;
      if v_other is not null then
        perform core.fail('MENU_EXISTS', 422, jsonb_build_object('menuId', v_other, 'event_id', new.event_id, 'kind', new.kind));
      end if;
    elsif new.kind = 'casa' then
      select m.id into v_other from food.menus m where m.kind = 'casa' and m.id <> new.id and m.deleted_at is null limit 1;
      if v_other is not null then
        perform core.fail('MENU_EXISTS', 422, jsonb_build_object('menuId', v_other, 'kind', 'casa'));
      end if;
    end if;
  end if;
  return new;
end $$;

-- Servicios (0110, más la carta): menu_id inmutable; el menú validado o cerrado no admite cambios; nada cuelga de un
-- menú borrado; una carta no tiene servicios.
create or replace function food.guard_menu_service()
returns trigger language plpgsql as $$
declare v_menu food.menus;
begin
  if tg_op = 'UPDATE' and new.menu_id <> old.menu_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id'));
  end if;
  select * into v_menu from food.menus where id = new.menu_id;
  if v_menu.id is null then return new; end if;
  if v_menu.kind = 'carta' then
    perform core.fail('CARTA_MENU', 422, jsonb_build_object('menu_id', v_menu.id, 'action', 'services'));
  end if;
  if v_menu.status in ('validado','cerrado') then
    perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', v_menu.id, 'status', v_menu.status));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) and v_menu.deleted_at is not null then
    perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menus', 'id', v_menu.id));
  end if;
  return new;
end $$;

select core.register_table('food', 'food', 'menus', array[
  'kind','event_id','source_event_revision','source_event_snapshot','status','validated_at','validated_by','validated_warnings',
  'preparation_generated_at','preparation_source_revisions','notes','closing_notes','organizer_shared','house_servings','name']);

-- ---------------------------------------------------------------------------
-- 2. Líneas de la carta
-- ---------------------------------------------------------------------------
create table food.carta_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete restrict,
  recipe_id uuid references food.recipes(id) on delete restrict,
  -- Artículo de Recursos (sin clave foránea entre schemas, como ingredients.item_id): lo comprueba la guarda.
  item_id uuid,
  scope text not null check (scope in ('clasico', 'gourmet', 'barra')),
  code text not null check (code in ('A', 'B', 'C', 'D', 'α', 'β', 'γ', 'δ')),
  -- Nombre y descripción públicos propios de la línea; si faltan, los de la receta o el nombre del artículo.
  name text check (name is null or length(btrim(name)) between 1 and 120),
  description text check (description is null or length(description) <= 300),
  sale_price_cents integer not null check (sale_price_cents between 0 and 1000000),
  active boolean not null default true,
  position numeric not null default 0,
  image_key text check (image_key is null or image_key ~ '^[a-z0-9]+(-[a-z0-9]+)*/[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint carta_lines_source check ((recipe_id is null) <> (item_id is null))
);
create unique index carta_lines_code_key on food.carta_lines (menu_id, scope, code) where deleted_at is null;
create index carta_lines_menu_idx on food.carta_lines (menu_id, scope, position) where deleted_at is null;
create index carta_lines_recipe_idx on food.carta_lines (recipe_id) where recipe_id is not null;

-- Línea: menu_id y origen (receta o artículo) inmutables; la carta existe, es una carta y está viva; la receta está viva;
-- el artículo existe en Recursos y está vivo.
create or replace function food.guard_carta_line()
returns trigger language plpgsql as $$
declare v_menu food.menus;
begin
  if tg_op = 'UPDATE' then
    if new.menu_id <> old.menu_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id')); end if;
    if new.recipe_id is distinct from old.recipe_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'recipe_id')); end if;
    if new.item_id is distinct from old.item_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'item_id')); end if;
  end if;
  select * into v_menu from food.menus where id = new.menu_id;
  if v_menu.id is null or v_menu.kind <> 'carta' then
    perform core.fail('CARTA_NOT_FOUND', 422, jsonb_build_object('menu_id', new.menu_id));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    if v_menu.deleted_at is not null then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menus', 'id', v_menu.id));
    end if;
    if new.recipe_id is not null and exists (select 1 from food.recipes r where r.id = new.recipe_id and r.deleted_at is not null) then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'recipes', 'id', new.recipe_id));
    end if;
    if new.item_id is not null and not exists (select 1 from resources.items i where i.id = new.item_id and i.deleted_at is null) then
      perform core.fail('INVALID_ITEM', 422, jsonb_build_object('field', 'item_id', 'item_id', new.item_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_carta_line before insert or update on food.carta_lines
  for each row execute function food.guard_carta_line();

-- Una receta con líneas de carta vivas tampoco se borra (como con los platos): se archiva.
create or replace function food.guard_recipe_in_carta()
returns trigger language plpgsql as $$
declare v_uses int;
begin
  if new.deleted_at is not null and old.deleted_at is null then
    select count(*) into v_uses from food.carta_lines l join food.menus m on m.id = l.menu_id
     where l.recipe_id = new.id and l.deleted_at is null and m.deleted_at is null;
    if v_uses > 0 then
      perform core.fail('RECIPE_IN_USE', 422, jsonb_build_object('id', new.id, 'uses', v_uses, 'in', 'carta'));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_recipe_in_carta before update on food.recipes
  for each row execute function food.guard_recipe_in_carta();

select core.register_table('food', 'food', 'carta_lines', array[
  'menu_id','recipe_id','item_id','scope','code','name','description','sale_price_cents','active','position','image_key']);

-- ---------------------------------------------------------------------------
-- 3. Ventas por línea y día (solo las escribe food.record_carta_sales)
-- ---------------------------------------------------------------------------
create table food.carta_sales (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_id uuid not null references food.menus(id) on delete restrict,
  line_id uuid not null references food.carta_lines(id) on delete restrict,
  day date not null,
  quantity integer not null check (quantity between 0 and 100000)
);
create unique index carta_sales_key on food.carta_sales (line_id, day) where deleted_at is null;
create index carta_sales_menu_day_idx on food.carta_sales (menu_id, day) where deleted_at is null;

-- Solo el procedimiento: pone y quita la marca de transacción `food.carta_proc`. Desde el cliente, PROCEDURE_ONLY.
create or replace function food.guard_carta_sale()
returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('food.carta_proc', true), '') <> '1' then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'food.carta_sales', 'procedure', 'food.record_carta_sales'));
  end if;
  return new;
end $$;
create trigger food_guard_carta_sale before insert or update on food.carta_sales
  for each row execute function food.guard_carta_sale();

select core.register_table('food', 'food', 'carta_sales', array['menu_id','line_id','day','quantity']);

-- Uuid estable de una venta (línea + día): la misma fila en cada llamada, sin depender de lo que haya.
create or replace function food.carta_sale_id(p_line uuid, p_day date)
returns uuid language sql immutable as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' ||
          substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int % 4) + 1, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    from (select md5('food-carta-sale:' || p_line || ':' || p_day) as h) x;
$$;

-- Ventas de un día de una carta: {menu_id, day, lines: [{line_id, quantity}]}. Sustituye lo de ese día: cada línea que
-- llega queda con su cantidad y las que no llegan, a 0. No toca el stock (lo hace food-api después: §6).
create or replace function food.record_carta_sales(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); v_menu food.menus; v_day date; v_line record; v_qty int;
  v_sale food.carta_sales; v_given jsonb := '{}'::jsonb; v_out jsonb := '[]'::jsonb; v_total int := 0;
begin
  begin v_menu.id := (a->>'menu_id')::uuid; exception when others then v_menu.id := null; end;
  select * into v_menu from food.menus where id = v_menu.id and deleted_at is null and kind = 'carta' for update;
  if v_menu.id is null then perform core.fail('CARTA_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;
  begin v_day := (a->>'day')::date; exception when others then v_day := null; end;
  if v_day is null or a->>'day' !~ '^\d{4}-\d{2}-\d{2}$' then perform core.fail('INVALID_DAY', 422, jsonb_build_object('day', a->>'day')); end if;
  if coalesce(jsonb_typeof(a->'lines'), '') <> 'array' or jsonb_array_length(a->'lines') > 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'lines'));
  end if;
  for v_line in select value as v from jsonb_array_elements(a->'lines') loop
    if jsonb_typeof(v_line.v->'quantity') <> 'number' or (v_line.v->>'quantity')::numeric <> trunc((v_line.v->>'quantity')::numeric)
       or (v_line.v->>'quantity')::numeric < 0 or (v_line.v->>'quantity')::numeric > 100000 then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'quantity', 'line_id', v_line.v->>'line_id'));
    end if;
    if not exists (select 1 from food.carta_lines l where l.id::text = v_line.v->>'line_id' and l.menu_id = v_menu.id) then
      perform core.fail('LINE_NOT_IN_CARTA', 422, jsonb_build_object('line_id', v_line.v->>'line_id', 'menu_id', v_menu.id));
    end if;
    if v_given ? (v_line.v->>'line_id') then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'lines', 'reason', 'duplicate', 'line_id', v_line.v->>'line_id'));
    end if;
    v_given := v_given || jsonb_build_object(v_line.v->>'line_id', (v_line.v->>'quantity')::int);
  end loop;

  perform set_config('food.carta_proc', '1', true);
  -- Lo que llega y lo que ya había ese día (las que no llegan pasan a 0).
  for v_line in
    select l.id from food.carta_lines l where l.menu_id = v_menu.id and (v_given ? l.id::text
      or exists (select 1 from food.carta_sales s where s.line_id = l.id and s.day = v_day and s.deleted_at is null))
     order by l.scope, l.position, l.code
  loop
    v_qty := coalesce((v_given->>(v_line.id::text))::int, 0);
    select * into v_sale from food.carta_sales s where s.line_id = v_line.id and s.day = v_day and s.deleted_at is null;
    if v_sale.id is null then
      if v_qty > 0 then
        perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
          jsonb_build_object('op', 'insert', 'table', 'food.carta_sales', 'id', food.carta_sale_id(v_line.id, v_day),
            'fields', jsonb_build_object('menu_id', v_menu.id, 'line_id', v_line.id, 'day', v_day, 'quantity', v_qty)));
      end if;
    elsif v_sale.quantity <> v_qty then
      perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'food.carta_sales', 'id', v_sale.id, 'expectedRevision', v_sale.revision,
          'fields', jsonb_build_object('quantity', v_qty)));
    end if;
    v_sale := null;
    if v_qty > 0 then v_out := v_out || jsonb_build_object('line_id', v_line.id, 'quantity', v_qty); v_total := v_total + v_qty; end if;
  end loop;
  perform set_config('food.carta_proc', '', true);
  return jsonb_build_object('menu_id', v_menu.id, 'day', v_day, 'lines', v_out, 'units', v_total);
end $$;
select core.allow_procedure('food', 'food.record_carta_sales');

-- ---------------------------------------------------------------------------
-- 4. Lo que la carta gasta del inventario
-- ---------------------------------------------------------------------------
-- Cantidad de un artículo de Recursos, en su unidad base, que gasta UNA unidad vendida de una línea. Receta: cada
-- ingrediente enlazado ÷ raciones base, con las mismas conversiones que el consumo (1100): misma familia de unidad o una
-- conversión del artículo sin proveedor. Artículo: una unidad («ud») en su base, o su conversión de «ud».
create or replace function food.carta_line_usage(p_line uuid)
returns table (item_id uuid, quantity numeric) language plpgsql stable as $$
begin
  return query
  select it.id,
         case
           when food.food_unit(it.base_unit) is not null and food.unit_family(food.food_unit(it.base_unit)) = food.unit_family(ri.unit)
             then ri.quantity / rc.base_servings * food.unit_factor(ri.unit) / food.unit_factor(food.food_unit(it.base_unit))
           else ri.quantity / rc.base_servings * (select u.factor from resources.item_units u
                                                    where u.item_id = it.id and u.deleted_at is null and u.supplier_id is null
                                                      and lower(btrim(u.unit)) in (ri.unit, case ri.unit when 'unidad' then 'ud' end) limit 1)
         end
    from food.carta_lines l
    join food.recipes rc on rc.id = l.recipe_id
    join food.recipe_ingredients ri on ri.recipe_id = rc.id and ri.deleted_at is null
    join food.ingredients g on g.id = ri.ingredient_id
    join resources.items it on it.id = g.item_id and it.deleted_at is null
   where l.id = p_line
  union all
  select it.id,
         case when food.food_unit(it.base_unit) = 'unidad' then 1::numeric
              else (select u.factor from resources.item_units u
                     where u.item_id = it.id and u.deleted_at is null and u.supplier_id is null and lower(btrim(u.unit)) in ('ud', 'unidad') limit 1) end
    from food.carta_lines l
    join resources.items it on it.id = l.item_id and it.deleted_at is null
   where l.id = p_line;
end $$;

-- Coste por unidad vendida en céntimos: lo que gasta × coste medio de Recursos. Null si algo no tiene coste o conversión.
create or replace function food.carta_line_cost_cents(p_line uuid)
returns integer language plpgsql stable as $$
declare v_cost numeric; v_missing boolean; v_any boolean;
begin
  select sum(u.quantity * c.average_cost), bool_or(u.quantity is null or c.average_cost is null), count(*) > 0
    into v_cost, v_missing, v_any
    from food.carta_line_usage(p_line) u left join resources.item_costs c on c.item_id = u.item_id;
  if not v_any or v_missing then return null; end if;
  -- Una receta con ingredientes sin artículo enlazado tampoco tiene coste completo.
  if exists (select 1 from food.carta_lines l join food.recipe_ingredients ri on ri.recipe_id = l.recipe_id and ri.deleted_at is null
              join food.ingredients g on g.id = ri.ingredient_id
             where l.id = p_line and g.item_id is null) then
    return null;
  end if;
  return round(v_cost * 100)::int;
end $$;

-- Plan de stock de un día de una carta para food-api (§6): por artículo, lo que deberían haber restado las ventas
-- (`target`, en su base, negativo) y lo que ya llevan los movimientos con la referencia del día (`current`). Las líneas
-- que no se pueden convertir salen en `unconverted`.
create or replace function food.carta_stock_plan(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); v_menu uuid; v_day date; v_ref text; v_out jsonb; v_unconverted jsonb;
begin
  begin v_menu := (a->>'menu_id')::uuid; v_day := (a->>'day')::date; exception when others then v_menu := null; end;
  if v_menu is null or v_day is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'menu_id/day')); end if;
  v_ref := 'carta:' || v_menu || ':' || v_day;
  with sold as (
    select s.line_id, s.quantity from food.carta_sales s where s.menu_id = v_menu and s.day = v_day and s.deleted_at is null and s.quantity > 0),
  used as (
    select u.item_id, sum(-(u.quantity * s.quantity)) as target
      from sold s cross join lateral food.carta_line_usage(s.line_id) u
     where u.quantity is not null and u.quantity > 0
     group by u.item_id),
  moved as (
    select m.item_id, sum(m.quantity) as current from resources.movements m
     where m.source_app = 'food' and m.source_ref = v_ref and m.deleted_at is null group by m.item_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', coalesce(u.item_id, mv.item_id), 'target', round(coalesce(u.target, 0), 6), 'current', round(coalesce(mv.current, 0), 6),
           'default_space_id', it.default_space_id) order by coalesce(u.item_id, mv.item_id)), '[]'::jsonb)
    into v_out
    from used u full join moved mv on mv.item_id = u.item_id
    left join resources.items it on it.id = coalesce(u.item_id, mv.item_id);
  select coalesce(jsonb_agg(distinct s.line_id), '[]'::jsonb) into v_unconverted
    from food.carta_sales s
   where s.menu_id = v_menu and s.day = v_day and s.deleted_at is null and s.quantity > 0
     and (not exists (select 1 from food.carta_line_usage(s.line_id) u where u.quantity is not null)
          or exists (select 1 from food.carta_line_usage(s.line_id) u where u.quantity is null));
  return jsonb_build_object('menu_id', v_menu, 'day', v_day, 'source_ref', v_ref, 'items', v_out, 'unconverted', v_unconverted,
    'kitchen', (select coalesce(jsonb_agg(k.space_id), '[]'::jsonb) from food.kitchen_spaces() k));
end $$;
select core.allow_read('food', 'food.carta_stock_plan', 'function', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- 5. La carta para Flow (nombres acordados con Flow el 26-10-2026)
-- ---------------------------------------------------------------------------
-- En plpgsql, como las lecturas de Recursos de 0197: el cuerpo se comprueba al ejecutarse.
create or replace function food.carta_rows()
returns table (menu_id uuid, menu_name text, event_id uuid, line_id uuid, scope text, code text, name text, description text,
               sale_price_cents integer, active boolean, allergens text[], allergens_checked boolean, image_key text,
               cost_cents integer, "position" numeric, line_revision bigint, menu_revision bigint)
language plpgsql stable as $$
begin
  return query
  select m.id, m.name, m.event_id, l.id, l.scope, l.code,
         coalesce(l.name, nullif(btrim(rc.public_name), ''), rc.name, it.name)::text,
         coalesce(l.description, rc.public_description)::text,
         l.sale_price_cents, l.active,
         coalesce(rc.allergens, '{}'::text[]),
         -- Un artículo no lleva receta: sus alérgenos son los de su etiqueta, que Food no guarda (sin revisar).
         coalesce(rc.allergens_checked, false),
         l.image_key, food.carta_line_cost_cents(l.id), l.position, l.revision, m.revision
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    left join food.recipes rc on rc.id = l.recipe_id
    left join resources.items it on it.id = l.item_id
   where l.deleted_at is null;
end $$;

create view food.carta_projection as select * from food.carta_rows();
select core.allow_read('flow', 'food.carta_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_projection', 'view', '{reader,editor,owner}');

-- ---------------------------------------------------------------------------
-- 6. Semilla: «Barra · Evento de octubre» (§8 del documento de Flow de VG, 26-10-2026)
-- ---------------------------------------------------------------------------
-- Los artículos de Recursos los crea Core con ids fijos en 20261026_0811_resources_barra_items.sql («Tomate» es el que ya
-- existía). Las 8 recetas llevan pan y sus componentes con cantidades de partida (§8 no las da: «en prueba», se
-- ajustan en el recetario), las estaciones como pasos (1 Untar · 2 Colocar · 3 Dosificar · 4 Acabados) y los alérgenos
-- vacíos y sin revisar: se confirman con las etiquetas reales (§8.4; decisión de Core del 26-10). La carta queda sin
-- evento: Flow la enlaza desde su proyecto (`flow.projects.food_menu_id`). Solo la imagen del Serrano existe hoy.
--
-- Va en una función: la migración la ejecuta solo si Food ya tiene miembros y están los artículos (producción). En una
-- base de pruebas no siembra; las pruebas la llaman.
create or replace function food.station_label(p_station int)
returns text language sql immutable as $$
  select case p_station when 1 then 'Untar' when 2 then 'Colocar' when 3 then 'Dosificar' else 'Acabados' end;
$$;

create or replace function food.seed_carta_octubre()
returns int language plpgsql as $$
declare
  v_menu constant uuid := 'f00dca7a-0000-4000-8000-000000000001';
  v_ops jsonb := '[]'::jsonb; v_ing jsonb := '{}'::jsonb; r record; v_id uuid; v_ing_row food.ingredients; v_n int;
  v_steps jsonb; v_method text; v_desc text;
begin
  if exists (select 1 from food.menus where id = v_menu) then return 0; end if;

  -- Ingredientes de Food enlazados a sus artículos: el que ya tiene ese artículo, o el del mismo nombre (y se enlaza),
  -- o uno nuevo.
  for r in select * from (values
      ('3a3d080c-417e-4174-a87f-9f28fc62ec90'::uuid, 'Tomate', 'kg', 'f00dca7a-0000-4000-8000-000000000300'::uuid),
      ('74545d77-5a6d-45c8-bced-3c23cabdb31f', 'Pan de montadito', 'unidad', 'f00dca7a-0000-4000-8000-000000000301'),
      ('1adffdcf-2981-409e-9341-42f2f9a965b1', 'Jamón serrano', 'kg', 'f00dca7a-0000-4000-8000-000000000302'),
      ('ff5b3629-2241-451d-a4d2-e3930b02a60b', 'Aceite de oliva', 'l', 'f00dca7a-0000-4000-8000-000000000303'),
      ('5520b406-e3d9-4fd3-aa9b-d8ead2dcc0b5', 'Atún preparado', 'kg', 'f00dca7a-0000-4000-8000-000000000304'),
      ('3dfb175a-c610-4218-be00-a12faaf1490a', 'Mayonesa', 'kg', 'f00dca7a-0000-4000-8000-000000000305'),
      ('4517133e-aa0f-44c6-abf0-e5cf90f51453', 'Hummus', 'kg', 'f00dca7a-0000-4000-8000-000000000306'),
      ('014ad81f-fa01-4f85-b580-e402b1ab5d4d', 'Tomate seco en aceite', 'kg', 'f00dca7a-0000-4000-8000-000000000307'),
      ('6866fc2f-c9fb-4481-a1a6-cf967a83fb9e', 'Rúcula', 'kg', 'f00dca7a-0000-4000-8000-000000000308'),
      ('073894c4-5a8e-4315-8726-7efb86b0d07b', 'Queso crema', 'kg', 'f00dca7a-0000-4000-8000-000000000309'),
      ('75db942c-7514-42a8-98fb-5bf3cc3f9959', 'Pesto', 'kg', 'f00dca7a-0000-4000-8000-000000000310'),
      ('fbd2d944-9aec-4263-9bfc-bca1bdb8d8b8', 'Albahaca fresca', 'kg', 'f00dca7a-0000-4000-8000-000000000311'),
      ('0bf532b6-eb3f-4a0e-bb86-84541e81a6d5', 'Paté de campaña', 'kg', 'f00dca7a-0000-4000-8000-000000000312'),
      ('00656f8a-8d68-424c-8b94-efc2ac0c0320', 'Cebolla caramelizada', 'kg', 'f00dca7a-0000-4000-8000-000000000313'),
      ('34d445e9-e9f2-4b0c-a126-d936d1e64642', 'Tomillo', 'kg', 'f00dca7a-0000-4000-8000-000000000314'),
      ('1f4cabf9-29ed-4fee-a033-cdf2947443f8', 'Queso payoyo', 'kg', 'f00dca7a-0000-4000-8000-000000000315'),
      ('b090e0e8-1195-40cf-af82-4e55b7f17eb1', 'Miel', 'kg', 'f00dca7a-0000-4000-8000-000000000316'),
      ('8955a89a-e23c-4d4c-b493-0c441aaa9f66', 'Nueces troceadas', 'kg', 'f00dca7a-0000-4000-8000-000000000317'),
      ('330baf65-1bc3-4d90-be95-b4517865e8c4', 'Queso de cabra', 'kg', 'f00dca7a-0000-4000-8000-000000000318'),
      ('15c1535b-164c-4f8d-9d0d-90e74c058bbb', 'Mermelada de tomate', 'kg', 'f00dca7a-0000-4000-8000-000000000319'),
      ('008b2489-7740-451b-ae2a-2ab54ed726f2', 'Salmón ahumado', 'kg', 'f00dca7a-0000-4000-8000-000000000320'),
      ('039c4efc-49fb-4f9f-a157-486dc3828e3e', 'Eneldo', 'kg', 'f00dca7a-0000-4000-8000-000000000321')
    ) as t(item_id, name, unit, new_id)
  loop
    v_ing_row := null;
    select * into v_ing_row from food.ingredients g where g.item_id = r.item_id and g.deleted_at is null limit 1;
    if v_ing_row.id is null then
      select * into v_ing_row from food.ingredients g where lower(btrim(g.name)) = lower(r.name) and g.deleted_at is null limit 1;
      if v_ing_row.id is not null and v_ing_row.item_id is null then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'food.ingredients', 'id', v_ing_row.id,
          'expectedRevision', v_ing_row.revision, 'fields', jsonb_build_object('item_id', r.item_id));
      end if;
    end if;
    v_id := coalesce(v_ing_row.id, r.new_id);
    if v_ing_row.id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.ingredients', 'id', v_id,
        'fields', jsonb_build_object('name', r.name, 'preferred_unit', r.unit, 'item_id', r.item_id));
    end if;
    v_ing := v_ing || jsonb_build_object(r.name, v_id);
  end loop;

  v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.menus', 'id', v_menu,
    'fields', jsonb_build_object('kind', 'carta', 'name', 'Barra · Evento de octubre'));

  -- Montaditos (§8.1–8.2): número, código, ámbito, nombre, imagen y componentes [estación, ingrediente, cantidad, unidad].
  -- Todos llevan además 1 pan de montadito.
  for r in select * from (values
      (1, 'A', 'clasico', 'Serrano', 'montaditos/serrano', '[[2,"Tomate",15,"g"],[2,"Jamón serrano",15,"g"],[3,"Aceite de oliva",3,"ml"]]'::jsonb),
      (2, 'B', 'clasico', 'Dobladillo', null, '[[1,"Atún preparado",20,"g"],[2,"Tomate",15,"g"],[3,"Mayonesa",8,"g"]]'),
      (3, 'C', 'clasico', 'Mediterráneo', null, '[[1,"Hummus",20,"g"],[1,"Tomate seco en aceite",10,"g"],[4,"Rúcula",3,"g"]]'),
      (4, 'D', 'clasico', 'Caprese', null, '[[1,"Queso crema",15,"g"],[2,"Tomate",15,"g"],[3,"Pesto",6,"g"],[4,"Albahaca fresca",1,"g"]]'),
      (5, 'α', 'gourmet', 'Campero', null, '[[1,"Paté de campaña",20,"g"],[1,"Cebolla caramelizada",10,"g"],[4,"Tomillo",0.5,"g"]]'),
      (6, 'β', 'gourmet', 'Payoyo', null, '[[2,"Queso payoyo",20,"g"],[3,"Miel",6,"g"],[4,"Nueces troceadas",5,"g"]]'),
      (7, 'γ', 'gourmet', 'Cabra dulce', null, '[[1,"Cebolla caramelizada",10,"g"],[2,"Queso de cabra",20,"g"],[3,"Mermelada de tomate",8,"g"]]'),
      (8, 'δ', 'gourmet', 'Nórdico', null, '[[1,"Queso crema",15,"g"],[2,"Salmón ahumado",15,"g"],[4,"Eneldo",0.5,"g"]]')
    ) as t(n, code, scope, name, image, parts)
  loop
    v_id := ('f00dca7a-0000-4000-8000-0000000001' || lpad(r.n::text, 2, '0'))::uuid;
    -- «Tomate» es el tomate fresco del documento.
    select string_agg(case p->>1 when 'Tomate' then 'tomate fresco' else lower(p->>1) end, ', ' order by o) into v_desc
      from jsonb_array_elements(r.parts) with ordinality as x(p, o);
    select jsonb_agg(jsonb_build_object('id', 'st' || s.st, 'text', s.st || ' · ' || food.station_label(s.st) || ': ' || s.what) order by s.st),
           string_agg(s.st || '. ' || food.station_label(s.st) || ': ' || s.what, E'\n' order by s.st)
      into v_steps, v_method
      from (select (p->>0)::int as st, string_agg(case p->>1 when 'Tomate' then 'tomate fresco' else lower(p->>1) end, ', ' order by o) as what
              from jsonb_array_elements(r.parts) with ordinality as y(p, o) group by (p->>0)::int) s;
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.recipes', 'id', v_id, 'fields', jsonb_build_object(
      'name', 'Montadito ' || r.name, 'public_name', r.name, 'public_description', upper(left(v_desc, 1)) || substr(v_desc, 2),
      'category', 'entrante', 'base_servings', 1, 'status', 'en_prueba', 'prep_minutes', 0,
      'service_notes', 'Barra · carta ' || case r.scope when 'clasico' then 'clásica' else 'gourmet' end || ' (' || r.code || '). Cantidades de partida, por ajustar.',
      'method_steps', v_steps, 'method', v_method));
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.recipe_ingredients', 'id', ('f00dca7a-0000-4000-8000-0000000004' || lpad(r.n::text, 2, '0'))::uuid,
      'fields', jsonb_build_object('recipe_id', v_id, 'ingredient_id', v_ing->>'Pan de montadito', 'quantity', 1, 'unit', 'unidad', 'position', 0));
    for v_n in 1 .. jsonb_array_length(r.parts) loop
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.recipe_ingredients',
        'id', ('f00dca7a-0000-4000-8000-0000000' || lpad((5000 + r.n * 10 + v_n)::text, 5, '0'))::uuid,
        'fields', jsonb_build_object('recipe_id', v_id, 'ingredient_id', v_ing->>(r.parts->(v_n - 1)->>1),
          'quantity', (r.parts->(v_n - 1)->>2)::numeric, 'unit', r.parts->(v_n - 1)->>3, 'position', v_n,
          'notes', 'Estación ' || (r.parts->(v_n - 1)->>0) || ' · ' || food.station_label((r.parts->(v_n - 1)->>0)::int)));
    end loop;
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.carta_lines', 'id', ('f00dca7a-0000-4000-8000-0000000002' || lpad(r.n::text, 2, '0'))::uuid,
      'fields', jsonb_strip_nulls(jsonb_build_object('menu_id', v_menu, 'recipe_id', v_id, 'scope', r.scope, 'code', r.code,
        'sale_price_cents', case r.scope when 'clasico' then 250 else 300 end, 'position', r.n, 'image_key', r.image)));
  end loop;

  -- Bebidas y extras (§8.3), como artículos de Recursos.
  for r in select * from (values
      (9, 'A', 'fbd86e16-3bef-4dc0-b9a8-a4c9f139b72a'::uuid, 'Agua, botella pequeña', 100),
      (10, 'B', '426bcf0c-d1ae-4e4c-bc67-b7bf35be6776', 'Refresco, lata', 200),
      (11, 'C', '9a49b68d-fbcd-4270-8043-9cfc2441dd34', 'Cerveza, lata', 200),
      (12, 'D', 'cf2b0ff7-21e1-4f61-8b93-a007fdb611c2', 'Café / infusión', 150),
      (13, 'α', '2268636f-6764-40e6-a703-9ed13aad8ee4', 'Palomitas', 150)
    ) as t(n, code, item_id, name, price)
  loop
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'food.carta_lines', 'id', ('f00dca7a-0000-4000-8000-0000000002' || lpad(r.n::text, 2, '0'))::uuid,
      'fields', jsonb_build_object('menu_id', v_menu, 'item_id', r.item_id, 'scope', 'barra', 'code', r.code, 'name', r.name,
        'sale_price_cents', r.price, 'position', r.n));
  end loop;

  perform core.apply_migration_operations('food', 'migration:food-1109-carta-octubre', v_ops);
  return jsonb_array_length(v_ops);
end $$;
revoke all on function food.seed_carta_octubre() from public, anon, authenticated;

-- Solo con todos los artículos de la semilla en Recursos (27): si falta alguno, no siembra y la migración sigue.
do $$
begin
  if exists (select 1 from core.memberships where app = 'food')
     and (select count(*) from resources.items where deleted_at is null and id in (
       '00656f8a-8d68-424c-8b94-efc2ac0c0320',
       '008b2489-7740-451b-ae2a-2ab54ed726f2',
       '014ad81f-fa01-4f85-b580-e402b1ab5d4d',
       '039c4efc-49fb-4f9f-a157-486dc3828e3e',
       '073894c4-5a8e-4315-8726-7efb86b0d07b',
       '0bf532b6-eb3f-4a0e-bb86-84541e81a6d5',
       '15c1535b-164c-4f8d-9d0d-90e74c058bbb',
       '1adffdcf-2981-409e-9341-42f2f9a965b1',
       '1f4cabf9-29ed-4fee-a033-cdf2947443f8',
       '2268636f-6764-40e6-a703-9ed13aad8ee4',
       '330baf65-1bc3-4d90-be95-b4517865e8c4',
       '34d445e9-e9f2-4b0c-a126-d936d1e64642',
       '3a3d080c-417e-4174-a87f-9f28fc62ec90',
       '3dfb175a-c610-4218-be00-a12faaf1490a',
       '426bcf0c-d1ae-4e4c-bc67-b7bf35be6776',
       '4517133e-aa0f-44c6-abf0-e5cf90f51453',
       '5520b406-e3d9-4fd3-aa9b-d8ead2dcc0b5',
       '6866fc2f-c9fb-4481-a1a6-cf967a83fb9e',
       '74545d77-5a6d-45c8-bced-3c23cabdb31f',
       '75db942c-7514-42a8-98fb-5bf3cc3f9959',
       '8955a89a-e23c-4d4c-b493-0c441aaa9f66',
       '9a49b68d-fbcd-4270-8043-9cfc2441dd34',
       'b090e0e8-1195-40cf-af82-4e55b7f17eb1',
       'cf2b0ff7-21e1-4f61-8b93-a007fdb611c2',
       'fbd2d944-9aec-4263-9bfc-bca1bdb8d8b8',
       'fbd86e16-3bef-4dc0-b9a8-a4c9f139b72a',
       'ff5b3629-2241-451d-a4d2-e3930b02a60b')) = 27 then
    perform food.seed_carta_octubre();
  end if;
end $$;
