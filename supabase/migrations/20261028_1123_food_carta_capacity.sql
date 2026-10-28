-- Food · capacidad material de la carta (food-13, pedido de VG del 28-10; traspaso de Flow §3.4). Toca solo el schema food.
--
-- Las ventas esperadas (`expected_units`, 1110) y la capacidad material son números distintos y nadie los cuadra: se
-- espera vender 400 montaditos y se quiere material para 800 (100 de cada uno de los ocho). `capacity_units` es esa
-- capacidad, por línea; vacía, no se ha fijado. Se edita en Previsión, junto a las unidades esperadas, y la barra (Flow)
-- lee las dos en `food.carta_projection`, que gana `expected_units` y `capacity_units` al final.

alter table food.carta_lines add column capacity_units integer check (capacity_units is null or capacity_units between 0 and 1000000);
select core.register_table('food', 'food', 'carta_lines', array[
  'menu_id','recipe_id','item_id','scope','code','name','description','sale_price_cents','active','position','image_key','expected_units','per_person',
  'capacity_units']);

-- La proyección para Flow, con las dos columnas al final (nadie depende de la vista: se rehace con su función).
drop view food.carta_projection;
drop function food.carta_rows();
create function food.carta_rows()
returns table (menu_id uuid, menu_name text, event_id uuid, line_id uuid, scope text, code text, name text, description text,
               sale_price_cents integer, active boolean, allergens text[], allergens_checked boolean, image_key text,
               cost_cents integer, "position" numeric, line_revision bigint, menu_revision bigint,
               expected_units integer, capacity_units integer)
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
         l.image_key, food.carta_line_cost_cents(l.id), l.position, l.revision, m.revision,
         l.expected_units, l.capacity_units
    from food.carta_lines l
    join food.menus m on m.id = l.menu_id and m.deleted_at is null and m.kind = 'carta'
    left join food.recipes rc on rc.id = l.recipe_id
    left join resources.items it on it.id = l.item_id
   where l.deleted_at is null;
end $$;

create view food.carta_projection as select * from food.carta_rows();
select core.allow_read('flow', 'food.carta_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.carta_projection', 'view', '{reader,editor,owner}');
