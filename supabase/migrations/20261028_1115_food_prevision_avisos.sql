-- Food · por qué falta un dato en la previsión para Flow (encargo de Core del 28-10-2026: «rendimiento y recipientes»).
-- Toca solo el schema food.
--
-- Flow cuenta los recipientes con lo que le llega de Food (`prep_need_total` en unidades de preparación ÷ lo que lleva un
-- recipiente). Cuando a un ingrediente le falta un dato, Flow solo podía decir «Sin cantidad (revisar en Food)». Ahora las dos
-- lecturas dicen qué falta y dónde se pone, al final de sus columnas (las de antes no cambian):
-- - `missing`: por qué no hay cantidad (`convertible` = false):
--   'articulo' (el ingrediente no tiene artículo del inventario), 'rendimiento' (la receta cuenta piezas y el ingrediente no
--   dice cuántas salen de una de compra) o 'conversion' (el artículo no sabe pasar esa unidad a la suya). Null si hay cantidad.
-- - `yield_missing`: la receta cuenta piezas de un ingrediente sin rendimiento. Hay cantidad (piezas enteras de compra), pero
--   si son rodajas o rebanadas, los recipientes y la compra salen mal: conviene ponerlo.
-- - `note`: la frase para enseñar, con dónde se arregla en Food. Null si no falta nada.
create or replace view food.carta_prep_projection as
select c.menu_id, c.line_id, c.scope, c.code, c.ingredient_id, c.item_id, coalesce(c.item_id, c.ingredient_id)::text as component_key,
       c.name, c.unit, c.per_unit, c.expected_units, c.per_unit * c.expected_units as need_total,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'mesa')::numeric / 100 end as mesa,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'nevera')::numeric / 100 end as nevera,
       case when c.is_item then null else c.per_unit * c.expected_units * (c.prep_split->>'fresco')::numeric / 100 end as fresco,
       c.station, c.per_unit is not null as convertible, c.line_revision, c.menu_revision,
       c.prep_unit, c.raw_quantity as prep_per_unit, c.raw_quantity * c.expected_units as prep_need_total, c.purchase_unit, c.yield,
       m.missing, m.yield_missing,
       case m.missing
         when 'articulo' then format('%s no tiene artículo del inventario: enlázalo en Food, en la Despensa.', c.name)
         when 'rendimiento' then format('Falta el rendimiento de %s: en Food, Previsión de la carta, cuántas piezas salen de una de compra (1 tomate = 8 rodajas).', c.name)
         when 'conversion' then format('Falta la conversión de %s: en Food, Despensa, cuánto pesa o mide una %s.', c.name, c.raw_unit)
         else case when m.yield_missing then format('%s sin rendimiento: se cuentan piezas enteras. Si son rodajas, ponlo en Food, Previsión de la carta.', c.name) end
       end as note
  from food.carta_components(null) c
  cross join lateral (select
       case when c.per_unit is not null then null
            when c.item_id is null then 'articulo'
            when not c.is_item and c.raw_unit = 'unidad' and c.yield is null then 'rendimiento'
            else 'conversion' end as missing,
       (not c.is_item and c.raw_unit = 'unidad' and c.yield is null) as yield_missing) m;

-- Por componente: el primer motivo por gravedad (artículo, rendimiento, conversión) y su frase.
create or replace view food.carta_prep_totals_projection as
select p.menu_id, p.component_key, (array_agg(p.item_id))[1] as item_id, (array_agg(p.ingredient_id) filter (where p.ingredient_id is not null))[1] as ingredient_id,
       min(p.name) as name, min(p.unit) as unit, sum(p.need_total) as need_total,
       sum(p.mesa) as mesa, sum(p.nevera) as nevera, sum(p.fresco) as fresco,
       bool_and(p.convertible) as convertible, min(p.station)::smallint as station,
       case when count(distinct p.prep_unit) = 1 then min(p.prep_unit) end as prep_unit,
       case when count(distinct p.prep_unit) = 1 then sum(p.prep_need_total) end as prep_need_total,
       min(p.purchase_unit) as purchase_unit, min(p.yield) as yield,
       (array_agg(p.missing order by case p.missing when 'articulo' then 1 when 'rendimiento' then 2 else 3 end) filter (where p.missing is not null))[1] as missing,
       bool_or(p.yield_missing) as yield_missing,
       coalesce((array_agg(p.note order by case p.missing when 'articulo' then 1 when 'rendimiento' then 2 else 3 end) filter (where p.missing is not null))[1],
                (array_agg(p.note) filter (where p.note is not null))[1]) as note
  from food.carta_prep_projection p
 group by p.menu_id, p.component_key;
