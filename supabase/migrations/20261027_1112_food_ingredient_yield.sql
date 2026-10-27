-- Food · rendimiento del ingrediente (encargo de VG del 27-10-2026, por Core; docs/food/API.md §2.13). Toca solo el schema
-- food; lee resources.
--
-- Conocimiento de cocina que vale para todos los eventos: 1 <unidad de compra> = N <unidades de preparación> (1 tomate =
-- 8 rodajas; 1 barra = 20 rebanadas). Va en el ingrediente de Food:
-- - `purchase_unit`: cómo se compra (una unidad de Food: 'unidad', 'paquete', 'manojo', 'kg'…);
-- - `prep_unit`: cómo se usa en las recetas cuando la receta cuenta piezas ('rodaja', 'rebanada'…);
-- - `yield`: cuántas unidades de preparación da una de compra.
-- Una línea de receta en 'unidad' de un ingrediente con rendimiento cuenta unidades de preparación (2 'unidad' de tomate
-- con prep_unit 'rodaja' = 2 rodajas). Lo anterior sigue valiendo: la nota «rodaja» y la conversión «rodaja» del artículo.
-- Con el rendimiento, lo que no tenía conversión la tiene: rodajas ÷ rendimiento = piezas de compra → su conversión.
-- A Flow le llega en la previsión (carta_prep_*): `prep_unit`, `prep_per_unit` y `prep_need_total` (en unidades de
-- preparación), `purchase_unit` y `yield`, para decir «Comprar 3 tomates» en vez de «Comprar 24 rodajas».

-- ---------------------------------------------------------------------------
-- 1. Columnas del ingrediente
-- ---------------------------------------------------------------------------
alter table food.ingredients add column purchase_unit text check (purchase_unit is null or purchase_unit in ('g','kg','ml','l','unidad','paquete','manojo','otro'));
alter table food.ingredients add column prep_unit text check (prep_unit is null or length(btrim(prep_unit)) between 1 and 30);
alter table food.ingredients add column yield numeric(10,3) check (yield is null or yield > 0);
alter table food.ingredients add constraint ingredients_yield_pair check ((prep_unit is null) = (yield is null));
select core.register_table('food', 'food', 'ingredients', array['name','preferred_unit','preferred_supplier','active','item_id','purchase_unit','prep_unit','yield']);

-- ---------------------------------------------------------------------------
-- 2. Cantidad de una línea de receta en la base del artículo, con el rendimiento como última vía
-- ---------------------------------------------------------------------------
-- Si la línea cuenta piezas ('unidad') de un ingrediente con rendimiento, son piezas de preparación: piezas ÷ rendimiento,
-- en su unidad de compra, y de ahí a la base del artículo. Si no, como hasta ahora (`food.to_item_base`: misma familia,
-- conversión del artículo, «rodaja»).
create or replace function food.recipe_qty_to_base(p_quantity numeric, p_unit text, p_notes text, p_ingredient uuid, p_item uuid, p_base text)
returns numeric language plpgsql stable as $$
declare g food.ingredients;
begin
  if p_item is null then return null; end if;
  select * into g from food.ingredients where id = p_ingredient;
  if g.yield is not null and p_unit = 'unidad' then
    return food.to_item_base(p_quantity / g.yield, coalesce(g.purchase_unit, 'unidad'), null, p_item, p_base);
  end if;
  return food.to_item_base(p_quantity, p_unit, p_notes, p_item, p_base);
end $$;

-- Lo que gasta una unidad vendida (1109, 1110), ahora también con el rendimiento.
create or replace function food.carta_line_usage(p_line uuid)
returns table (item_id uuid, quantity numeric) language plpgsql stable as $$
begin
  return query
  select it.id, food.recipe_qty_to_base(ri.quantity / rc.base_servings, ri.unit, ri.notes, g.id, it.id, it.base_unit)
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
-- 3. Componentes de la carta y lecturas para Flow, con el rendimiento
-- ---------------------------------------------------------------------------
-- Cambia lo que devuelve `food.carta_components`: se rehacen la función y las dos vistas (los nombres y columnas de
-- antes no cambian; las nuevas van al final).
drop view food.carta_prep_totals_projection;
drop view food.carta_prep_projection;
drop function food.carta_components(uuid);

create function food.carta_components(p_menu uuid)
returns table (menu_id uuid, line_id uuid, scope text, code text, ingredient_id uuid, item_id uuid, name text, unit text,
               per_unit numeric, expected_units integer, station smallint, is_item boolean, raw_quantity numeric, raw_unit text,
               line_revision bigint, menu_revision bigint, prep_split jsonb,
               prep_unit text, purchase_unit text, yield numeric)
language plpgsql stable as $$
begin
  return query
  select l.menu_id, l.id, l.scope, l.code, g.id, it.id, coalesce(it.name, g.name)::text,
         coalesce(it.base_unit, ri.unit)::text,
         food.recipe_qty_to_base(ri.quantity / rc.base_servings, ri.unit, ri.notes, g.id, it.id, it.base_unit),
         coalesce(l.expected_units, 0), ri.station, false, ri.quantity / rc.base_servings, ri.unit::text,
         l.revision, m.revision, food.prep_split_of(m.prep_split),
         -- Unidad de preparación: la del ingrediente si la receta cuenta piezas; si no, «rodaja» por la nota, o la de la receta.
         case when ri.unit = 'unidad' and g.prep_unit is not null then g.prep_unit
              when ri.unit = 'unidad' and coalesce(ri.notes, '') ~* 'rodaja' then 'rodaja'
              else ri.unit end::text,
         g.purchase_unit::text, g.yield
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    join food.recipes rc on rc.id = l.recipe_id
    join food.recipe_ingredients ri on ri.recipe_id = rc.id and ri.deleted_at is null
    join food.ingredients g on g.id = ri.ingredient_id
    left join resources.items it on it.id = g.item_id and it.deleted_at is null
   where l.deleted_at is null and (p_menu is null or l.menu_id = p_menu)
  union all
  select l.menu_id, l.id, l.scope, l.code, g2.id, it.id, it.name::text, it.base_unit::text,
         food.to_item_base(1, 'unidad', null, it.id, it.base_unit),
         coalesce(l.expected_units, 0), null::smallint, true, 1::numeric, 'unidad'::text,
         l.revision, m.revision, food.prep_split_of(m.prep_split),
         'unidad'::text, g2.purchase_unit::text, g2.yield
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    join resources.items it on it.id = l.item_id
    left join lateral (select g.* from food.ingredients g where g.item_id = it.id and g.deleted_at is null limit 1) g2 on true
   where l.deleted_at is null and (p_menu is null or l.menu_id = p_menu);
end $$;

-- Por línea y componente: las columnas de 1110 y, al final, las del rendimiento (en unidades de preparación).
create view food.carta_prep_projection as
select c.menu_id, c.line_id, c.scope, c.code, c.ingredient_id, c.item_id, coalesce(c.item_id, c.ingredient_id)::text as component_key,
       c.name, c.unit, c.per_unit, c.expected_units, c.per_unit * c.expected_units as need_total,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'mesa')::numeric / 100 end as mesa,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'nevera')::numeric / 100 end as nevera,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'fresco')::numeric / 100 end as fresco,
       c.station, c.per_unit is not null as convertible, c.line_revision, c.menu_revision,
       c.prep_unit, c.raw_quantity as prep_per_unit, c.raw_quantity * c.expected_units as prep_need_total, c.purchase_unit, c.yield
  from food.carta_components(null) c;

-- Por componente: las de 1110 y, al final, el rendimiento. `prep_need_total` solo si todas sus líneas cuentan en la
-- misma unidad de preparación (si no, null).
create view food.carta_prep_totals_projection as
select p.menu_id, p.component_key, (array_agg(p.item_id))[1] as item_id, (array_agg(p.ingredient_id) filter (where p.ingredient_id is not null))[1] as ingredient_id,
       min(p.name) as name, min(p.unit) as unit, sum(p.need_total) as need_total,
       sum(p.mesa) as mesa, sum(p.nevera) as nevera, sum(p.fresco) as fresco,
       bool_and(p.convertible) as convertible, min(p.station)::smallint as station,
       case when count(distinct p.prep_unit) = 1 then min(p.prep_unit) end as prep_unit,
       case when count(distinct p.prep_unit) = 1 then sum(p.prep_need_total) end as prep_need_total,
       min(p.purchase_unit) as purchase_unit, min(p.yield) as yield
  from food.carta_prep_projection p
 group by p.menu_id, p.component_key;

select core.allow_read('flow', 'food.carta_prep_projection', 'view', '{reader,editor,owner}');
select core.allow_read('flow', 'food.carta_prep_totals_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_prep_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_prep_totals_projection', 'view', '{reader,editor,owner}');
