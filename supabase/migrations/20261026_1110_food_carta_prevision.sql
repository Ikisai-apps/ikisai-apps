-- Food · previsión de la carta (encargo de VG del 26-10-2026, por Core; docs/food/API.md §2.11). Toca solo el schema
-- food; lee resources y registra dos lecturas para Flow (nombres acordados con Flow el 26-10).
--
-- - `carta_lines.expected_units`: unidades que se esperan vender de cada línea (100 serranos, 60 aguas…).
-- - `menus.prep_split`: el reparto de lo que se prepara, por carta: `{mesa, nevera, fresco}` en %, suma 100; sin él,
--   30/20/50. «Mesa» y «nevera», cortado en bandeja; «fresco», sin cortar.
-- - `recipe_ingredients.station`: la estación del montadito (1 Untar · 2 Colocar · 3 Dosificar · 4 Acabados). Las recetas
--   de la semilla la llevaban en la nota («Estación 2 · Colocar»): se pasa a la columna.
-- - Conversiones: nunca se inventan. Del ingrediente al artículo, como el consumo (misma familia de unidad o una
--   conversión del artículo sin proveedor). Una receta en rodajas va en 'unidad' con la nota «rodaja» y pide la
--   conversión «rodaja» del artículo (en su ficha). Lo que no se puede convertir sale con `convertible = false`.
-- - Lista de la compra de la carta: `food.regenerate_shopping` también con una carta (unidades esperadas × lo que gasta
--   cada una). Las bebidas y extras entran por su ingrediente de Food, que se crea enlazado a su artículo si falta.
-- - Lecturas para Flow: `food.carta_prep_projection` (por línea y componente) y `food.carta_prep_totals_projection`
--   (por componente, sumando las líneas), con `component_key = coalesce(item_id, ingredient_id)::text`.

-- ---------------------------------------------------------------------------
-- 1. Columnas
-- ---------------------------------------------------------------------------
alter table food.carta_lines add column expected_units integer check (expected_units is null or expected_units between 0 and 1000000);
select core.register_table('food', 'food', 'carta_lines', array[
  'menu_id','recipe_id','item_id','scope','code','name','description','sale_price_cents','active','position','image_key','expected_units']);

alter table food.menus add column prep_split jsonb check (prep_split is null or (
  jsonb_typeof(prep_split) = 'object'
  and jsonb_typeof(prep_split->'mesa') = 'number' and jsonb_typeof(prep_split->'nevera') = 'number' and jsonb_typeof(prep_split->'fresco') = 'number'
  and (prep_split->>'mesa')::numeric >= 0 and (prep_split->>'nevera')::numeric >= 0 and (prep_split->>'fresco')::numeric >= 0
  and (prep_split->>'mesa')::numeric + (prep_split->>'nevera')::numeric + (prep_split->>'fresco')::numeric = 100));
alter table food.menus add constraint menus_prep_split_carta check (prep_split is null or kind = 'carta');
select core.register_table('food', 'food', 'menus', array[
  'kind','event_id','source_event_revision','source_event_snapshot','status','validated_at','validated_by','validated_warnings',
  'preparation_generated_at','preparation_source_revisions','notes','closing_notes','organizer_shared','house_servings','name','prep_split']);

alter table food.recipe_ingredients add column station smallint check (station is null or station between 1 and 4);
select core.register_table('food', 'food', 'recipe_ingredients', array['recipe_id','ingredient_id','quantity','unit','position','notes','station']);

-- El reparto de una carta, con el de por defecto.
create or replace function food.prep_split_of(p_split jsonb)
returns jsonb language sql immutable as $$
  select coalesce(p_split, '{"mesa": 30, "nevera": 20, "fresco": 50}'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- 2. De la cantidad de una receta a la unidad base de su artículo
-- ---------------------------------------------------------------------------
-- Rodaja: si la nota de la línea dice «rodaja», solo vale la conversión «rodaja» del artículo (nunca la de la pieza
-- entera). Si no: misma familia de unidad, o la conversión del artículo sin proveedor de esa unidad («ud» = «unidad»).
-- Null si no se puede. En plpgsql: lee Recursos al ejecutarse (como 0197).
create or replace function food.to_item_base(p_quantity numeric, p_unit text, p_notes text, p_item uuid, p_base text)
returns numeric language plpgsql stable as $$
declare v_factor numeric;
begin
  if p_item is null or p_quantity is null then return null; end if;
  if coalesce(p_notes, '') ~* 'rodaja' then
    select u.factor into v_factor from resources.item_units u
     where u.item_id = p_item and u.deleted_at is null and u.supplier_id is null and lower(btrim(u.unit)) in ('rodaja', 'rodajas')
     order by u.created_at limit 1;
    return case when v_factor is null then null else p_quantity * v_factor end;
  end if;
  if food.food_unit(p_base) is not null and food.unit_family(food.food_unit(p_base)) = food.unit_family(p_unit) then
    return p_quantity * food.unit_factor(p_unit) / food.unit_factor(food.food_unit(p_base));
  end if;
  select u.factor into v_factor from resources.item_units u
   where u.item_id = p_item and u.deleted_at is null and u.supplier_id is null
     and lower(btrim(u.unit)) in (p_unit, case p_unit when 'unidad' then 'ud' end)
   order by u.created_at limit 1;
  return case when v_factor is null then null else p_quantity * v_factor end;
end $$;

-- Lo que gasta una unidad vendida (1109), ahora con la regla de las rodajas.
create or replace function food.carta_line_usage(p_line uuid)
returns table (item_id uuid, quantity numeric) language plpgsql stable as $$
begin
  return query
  select it.id, food.to_item_base(ri.quantity / rc.base_servings, ri.unit, ri.notes, it.id, it.base_unit)
    from food.carta_lines l
    join food.recipes rc on rc.id = l.recipe_id
    join food.recipe_ingredients ri on ri.recipe_id = rc.id and ri.deleted_at is null
    join food.ingredients g on g.id = ri.ingredient_id
    join resources.items it on it.id = g.item_id and it.deleted_at is null
   where l.id = p_line
  union all
  select it.id, food.to_item_base(1, 'unidad', null, it.id, it.base_unit)
    from food.carta_lines l
    join resources.items it on it.id = l.item_id and it.deleted_at is null
   where l.id = p_line;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Componentes de cada línea de una carta (la base de las lecturas y de la compra)
-- ---------------------------------------------------------------------------
-- Una fila por línea viva × componente: en una receta, cada ingrediente; en un artículo, el propio artículo (con el
-- ingrediente de Food que lo enlaza, si existe). `per_unit` en la unidad base del artículo; null si no se convierte.
-- `raw_*`: la cantidad de la receta por unidad vendida, en su unidad, para la lista de la compra cuando no se convierte.
create or replace function food.carta_components(p_menu uuid)
returns table (menu_id uuid, line_id uuid, scope text, code text, ingredient_id uuid, item_id uuid, name text, unit text,
               per_unit numeric, expected_units integer, station smallint, is_item boolean, raw_quantity numeric, raw_unit text,
               line_revision bigint, menu_revision bigint, prep_split jsonb)
language plpgsql stable as $$
begin
  return query
  select l.menu_id, l.id, l.scope, l.code, g.id, it.id, coalesce(it.name, g.name)::text,
         coalesce(it.base_unit, ri.unit)::text,
         food.to_item_base(ri.quantity / rc.base_servings, ri.unit, ri.notes, it.id, it.base_unit),
         coalesce(l.expected_units, 0), ri.station, false, ri.quantity / rc.base_servings, ri.unit::text,
         l.revision, m.revision, food.prep_split_of(m.prep_split)
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    join food.recipes rc on rc.id = l.recipe_id
    join food.recipe_ingredients ri on ri.recipe_id = rc.id and ri.deleted_at is null
    join food.ingredients g on g.id = ri.ingredient_id
    left join resources.items it on it.id = g.item_id and it.deleted_at is null
   where l.deleted_at is null and (p_menu is null or l.menu_id = p_menu)
  union all
  select l.menu_id, l.id, l.scope, l.code,
         (select g.id from food.ingredients g where g.item_id = it.id and g.deleted_at is null limit 1), it.id, it.name::text, it.base_unit::text,
         food.to_item_base(1, 'unidad', null, it.id, it.base_unit),
         coalesce(l.expected_units, 0), null::smallint, true, 1::numeric, 'unidad'::text,
         l.revision, m.revision, food.prep_split_of(m.prep_split)
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    join resources.items it on it.id = l.item_id
   where l.deleted_at is null and (p_menu is null or l.menu_id = p_menu);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Lecturas para Flow
-- ---------------------------------------------------------------------------
create view food.carta_prep_projection as
select c.menu_id, c.line_id, c.scope, c.code, c.ingredient_id, c.item_id, coalesce(c.item_id, c.ingredient_id)::text as component_key,
       c.name, c.unit, c.per_unit, c.expected_units, c.per_unit * c.expected_units as need_total,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'mesa')::numeric / 100 end as mesa,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'nevera')::numeric / 100 end as nevera,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'fresco')::numeric / 100 end as fresco,
       c.station, c.per_unit is not null as convertible, c.line_revision, c.menu_revision
  from food.carta_components(null) c;

-- Por componente, sumando las líneas. Si un ingrediente va en estaciones distintas según la receta, sale la menor (la de
-- cada montadito está en la vista por línea).
create view food.carta_prep_totals_projection as
select p.menu_id, p.component_key, (array_agg(p.item_id))[1] as item_id, (array_agg(p.ingredient_id) filter (where p.ingredient_id is not null))[1] as ingredient_id,
       min(p.name) as name, min(p.unit) as unit, sum(p.need_total) as need_total,
       sum(p.mesa) as mesa, sum(p.nevera) as nevera, sum(p.fresco) as fresco,
       bool_and(p.convertible) as convertible, min(p.station)::smallint as station
  from food.carta_prep_projection p
 group by p.menu_id, p.component_key;

select core.allow_read('flow', 'food.carta_prep_projection', 'view', '{reader,editor,owner}');
select core.allow_read('flow', 'food.carta_prep_totals_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_prep_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_prep_totals_projection', 'view', '{reader,editor,owner}');

-- ---------------------------------------------------------------------------
-- 5. La lista de la compra de una carta
-- ---------------------------------------------------------------------------
-- Lo que pide una carta por ingrediente de Food, en la base de su familia (g, ml o la propia unidad): convertido a la
-- unidad del artículo si se puede; si no, en la unidad de la receta.
create or replace function food.carta_shopping_lines(p_menu uuid)
returns table (ingredient_id uuid, family text, base_total numeric) language plpgsql stable as $$
begin
  return query
  select c.ingredient_id,
         case when c.per_unit is not null and food.food_unit(c.unit) is not null then food.unit_family(food.food_unit(c.unit)) else food.unit_family(c.raw_unit) end,
         case when c.per_unit is not null and food.food_unit(c.unit) is not null
              then c.per_unit * c.expected_units * food.unit_factor(food.food_unit(c.unit))
              else c.raw_quantity * c.expected_units * food.unit_factor(c.raw_unit) end
    from food.carta_components(p_menu) c
   where c.ingredient_id is not null and c.expected_units > 0;
end $$;

-- Revisiones de origen de la lista de una carta: líneas, recetas, ingredientes y sus cantidades.
create or replace function food.carta_shopping_sources(p_menu uuid)
returns jsonb language sql stable as $$
  with l as (select * from food.carta_lines where menu_id = p_menu and deleted_at is null),
       r as (select * from food.recipes where id in (select recipe_id from l)),
       ri as (select * from food.recipe_ingredients where recipe_id in (select id from r) and deleted_at is null),
       g as (select * from food.ingredients where id in (select ingredient_id from ri))
  select coalesce(jsonb_object_agg(x.id::text, x.revision), '{}'::jsonb) from (
    select id, revision from l union all select id, revision from r union all select id, revision from ri union all select id, revision from g) x;
$$;

-- Uuid estable a partir de un texto (el mismo artículo, el mismo ingrediente nuevo).
create or replace function food.stable_uuid(p_seed text)
returns uuid language sql immutable as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-' ||
          substr('89ab', (('x' || substr(h, 17, 1))::bit(4)::int % 4) + 1, 1) || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
    from (select md5(p_seed) as h) x;
$$;

-- Cada bebida o extra de la carta, con su ingrediente de Food enlazado al artículo: el que ya lo enlaza, el del mismo
-- nombre sin enlazar (se enlaza) o uno nuevo. Dentro del mismo lote de la regeneración.
create or replace function food.carta_ensure_ingredients(p jsonb, p_menu uuid)
returns int language plpgsql as $$
declare r record; v_same food.ingredients; v_n int := 0;
begin
  for r in
    select distinct it.id as item_id, it.name, it.base_unit from food.carta_lines l join resources.items it on it.id = l.item_id and it.deleted_at is null
     where l.menu_id = p_menu and l.deleted_at is null
       and not exists (select 1 from food.ingredients g where g.item_id = it.id and g.deleted_at is null)
  loop
    v_same := null;
    select * into v_same from food.ingredients g where lower(btrim(g.name)) = lower(btrim(r.name)) and g.deleted_at is null limit 1;
    if v_same.id is not null then
      if v_same.item_id is null then
        perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint, jsonb_build_object(
          'op', 'update', 'table', 'food.ingredients', 'id', v_same.id, 'expectedRevision', v_same.revision, 'fields', jsonb_build_object('item_id', r.item_id)));
        v_n := v_n + 1;
      end if;
      continue;
    end if;
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint, jsonb_build_object(
      'op', 'insert', 'table', 'food.ingredients', 'id', food.stable_uuid('food-carta-ingredient:' || r.item_id),
      'fields', jsonb_build_object('name', r.name, 'preferred_unit', coalesce(food.food_unit(r.base_unit), 'unidad'), 'item_id', r.item_id)));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- food.regenerate_shopping (1108), igual, más la carta: sus fuentes, sus ingredientes de bebidas y extras, y sus líneas.
create or replace function food.regenerate_shopping(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_list food.shopping_lists; v_item food.shopping_list_items; v_created boolean := false;
  v_sources jsonb; r record; v_required numeric; v_fields jsonb; v_seen uuid[] := '{}'; v_new uuid; v_ratio numeric;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_status text; v_from date; v_to date;
  v_on date; v_stock numeric; v_min numeric; v_purchase numeric; v_wanted uuid[] := '{}'; v_pack numeric;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;
  select * into v_from, v_to from food.call_period(v_menu, a);
  v_sources := case when v_menu.kind = 'carta' then food.carta_shopping_sources(v_menu.id) else food.shopping_sources(v_menu.id, v_from, v_to) end;
  -- La carta: cada bebida o extra necesita su ingrediente de Food (enlazado a su artículo) para entrar en la lista.
  if v_menu.kind = 'carta' then perform food.carta_ensure_ingredients(p, v_menu.id); end if;
  -- Primer día de la lista: lo que caduca antes no cuenta como «en casa».
  v_on := greatest(current_date, coalesce(v_from, (select min(s.service_date) from food.menu_services s where s.menu_id = v_menu.id and s.deleted_at is null), current_date));

  select * into v_list from food.shopping_lists
    where menu_id = v_menu.id and deleted_at is null and period_start is not distinct from v_from and period_end is not distinct from v_to
    for update;
  if v_list.id is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.shopping_lists', 'id', a->>'list_id',
      'fields', jsonb_build_object('menu_id', v_menu.id, 'generated_at', now(), 'source_revisions', v_sources,
        'period_start', v_from, 'period_end', v_to)));
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
        and (v_from is null or s.service_date between v_from and v_to)
      group by 1, 2
      union all
      -- Carta (1110): unidades esperadas × lo que gasta cada una, en la unidad base del artículo si se puede convertir
      -- (rodajas incluidas); si no, en la unidad de la receta, como en un menú.
      select c.ingredient_id, c.family, sum(c.base_total)
        from food.carta_shopping_lines(v_menu.id) c
       group by 1, 2)
    select l.ingredient_id, l.family, l.base_total, g.preferred_supplier, food.output_unit(l.family, l.base_total, g.preferred_unit) as unit,
           it.id as item_id, it.base_unit, it.min_quantity as item_min
    from lines l join food.ingredients g on g.id = l.ingredient_id
    left join resources.items it on it.id = g.item_id and it.deleted_at is null
    order by l.ingredient_id, l.family
  loop
    v_required := round(r.base_total / food.unit_factor(r.unit), 3);
    v_wanted := v_wanted || r.ingredient_id;
    v_stock := case when r.item_id is null then null else food.from_base(food.kitchen_stock(r.item_id, v_on), r.base_unit, r.unit) end;
    v_min := food.from_base(r.item_min, r.base_unit, r.unit);
    v_pack := food.usual_pack(r.item_id, r.base_unit, r.unit);
    select * into v_item from food.shopping_list_items i
      where i.shopping_list_id = v_list.id and i.ingredient_id = r.ingredient_id and not i.manual and i.deleted_at is null
        and food.unit_family(i.unit) = r.family
      order by i.created_at, i.id limit 1;
    if v_item.id is null then
      v_new := gen_random_uuid();
      v_purchase := food.round_pack(greatest(v_required + coalesce(v_min, 0) - coalesce(v_stock, 0), 0), v_pack);
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.shopping_list_items', 'id', v_new,
        'fields', jsonb_strip_nulls(jsonb_build_object('shopping_list_id', v_list.id, 'ingredient_id', r.ingredient_id, 'required_quantity', v_required,
          'unit', r.unit, 'purchase_quantity', v_purchase, 'supplier', r.preferred_supplier, 'stock_quantity', v_stock, 'min_quantity', v_min))));
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
      -- Con inventario, «en casa» es lo que dice el inventario; sin él, lo que se escribió a mano. En una línea ya
      -- comprada o recibida no se toca: «en casa» ya lleva lo comprado y bajaría «comprar» (H-C5).
      if v_item.status = 'pendiente' and v_stock is not null and v_item.stock_quantity is distinct from v_stock then
        v_item.stock_quantity := v_stock;
        v_fields := v_fields || jsonb_build_object('stock_quantity', v_stock);
      end if;
      if v_item.min_quantity is distinct from v_min then v_fields := v_fields || jsonb_build_object('min_quantity', v_min); end if;
      if v_item.restock then v_fields := v_fields || jsonb_build_object('restock', false); end if;
      v_purchase := food.round_pack(greatest(v_required + coalesce(v_min, 0) - coalesce(v_item.stock_quantity, 0), 0), v_pack);
      if v_item.status = 'pendiente' and not v_item.manual_override and v_item.purchase_quantity <> v_purchase then
        v_fields := v_fields || jsonb_build_object('purchase_quantity', v_purchase);
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

  -- Reponer: ingredientes bajo mínimo en la cocina que ningún menú de esta lista pide y que no lleva otra lista abierta.
  for r in
    select g.id as ingredient_id, g.preferred_supplier, it.id as item_id, it.base_unit, it.min_quantity, food.food_unit(it.base_unit) as unit,
           food.kitchen_stock(it.id, v_on) as stock
      from food.ingredients g join resources.items it on it.id = g.item_id and it.deleted_at is null and it.active
     where g.deleted_at is null and g.active and it.min_quantity is not null and it.min_quantity > 0
       and food.food_unit(it.base_unit) is not null and not (g.id = any(v_wanted))
       and coalesce(food.kitchen_stock(it.id, v_on), 0) < it.min_quantity
       and not exists (select 1 from food.shopping_list_items o join food.shopping_lists ol on ol.id = o.shopping_list_id
                        where o.ingredient_id = g.id and o.restock and o.deleted_at is null and ol.id <> v_list.id
                          and ol.deleted_at is null and ol.status <> 'cerrada')
     order by g.id
  loop
    v_stock := r.stock;
    v_purchase := food.round_pack(round(greatest(r.min_quantity - coalesce(v_stock, 0), 0), 3), food.usual_pack(r.item_id, r.base_unit, r.unit));
    select * into v_item from food.shopping_list_items i
      where i.shopping_list_id = v_list.id and i.ingredient_id = r.ingredient_id and i.restock and not i.manual and i.deleted_at is null limit 1;
    if v_item.id is null then
      v_new := gen_random_uuid();
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.shopping_list_items', 'id', v_new,
        'fields', jsonb_strip_nulls(jsonb_build_object('shopping_list_id', v_list.id, 'ingredient_id', r.ingredient_id, 'required_quantity', 0,
          'unit', r.unit, 'purchase_quantity', v_purchase, 'supplier', r.preferred_supplier, 'stock_quantity', v_stock,
          'min_quantity', r.min_quantity, 'restock', true))));
      v_seen := v_seen || v_new;
      v_inserted := v_inserted + 1;
    else
      v_seen := v_seen || v_item.id;
      v_fields := '{}'::jsonb;
      if v_item.status = 'pendiente' and v_item.stock_quantity is distinct from v_stock and v_stock is not null then v_fields := v_fields || jsonb_build_object('stock_quantity', v_stock); end if;
      if v_item.min_quantity is distinct from r.min_quantity then v_fields := v_fields || jsonb_build_object('min_quantity', r.min_quantity); end if;
      if v_item.status = 'pendiente' and not v_item.manual_override and v_item.purchase_quantity <> v_purchase then v_fields := v_fields || jsonb_build_object('purchase_quantity', v_purchase); end if;
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
      -- Pendiente y tocada a mano, o ya comprada: se queda lo que se compra; solo la necesidad pasa a 0.
      v_fields := jsonb_build_object('required_quantity', 0);
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
-- 6. La estación de las recetas de la semilla, de la nota a la columna
-- ---------------------------------------------------------------------------
create or replace function food.backfill_carta_stations()
returns int language plpgsql as $$
declare v_ops jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('op', 'update', 'table', 'food.recipe_ingredients', 'id', ri.id, 'expectedRevision', ri.revision,
           'fields', jsonb_build_object('station', substring(ri.notes from '^Estación ([1-4])')::int)) order by ri.id), '[]'::jsonb)
    into v_ops
    from food.recipe_ingredients ri
   where ri.deleted_at is null and ri.station is null and ri.notes ~ '^Estación [1-4]';
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('food', 'migration:food-1110-stations', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;
revoke all on function food.backfill_carta_stations() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from core.memberships where app = 'food') then perform food.backfill_carta_stations(); end if;
end $$;
