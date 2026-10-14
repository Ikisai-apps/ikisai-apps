-- Food · R5a: cada ingrediente y cada máquina de Food enlaza con su artículo de Recursos (coordinacion/ampliacion/
-- RECURSOS.md §6 «Food»; docs/food/API.md §2.7; docs/resources/API.md §3). Toca solo el schema food; lee resources.
--
-- - `ingredients.item_id` y `equipment.item_id`: el artículo de Recursos (sin clave foránea entre schemas). Lo rellena la
--   app al abrirse (un editor), creando el artículo con `source_refs = food.ingredient:<id>` o `food.equipment:<id>`
--   si no existe. Así el stock, el consumo y la compra de R5 trabajan sobre artículos.
-- - Durante R5, Food sigue escribiendo sus tablas como hasta ahora (las recetas apuntan a `ingredient_id` y
--   `equipment_id`): cero cambios para quien usa la app y las pruebas de caracterización siguen valiendo. El enlace va en
--   el ingrediente y en la máquina, no en cada línea: un solo sitio que mantener.
-- - Reglas: el artículo existe y está vivo; un ingrediente enlaza con un artículo que se gasta y una máquina con uno que
--   se cuenta (`resources.item_kinds.consumable`); un artículo, como mucho, con un ingrediente o una máquina viva.

alter table food.ingredients add column item_id uuid;
alter table food.equipment add column item_id uuid;
create unique index ingredients_item_key on food.ingredients (item_id) where deleted_at is null and item_id is not null;
create unique index equipment_item_key on food.equipment (item_id) where deleted_at is null and item_id is not null;

create or replace function food.guard_resource_link()
returns trigger language plpgsql as $$
declare v_kind text; v_consumable boolean; v_want boolean := tg_table_name = 'ingredients'; v_other uuid;
begin
  if new.item_id is null or new.deleted_at is not null then return new; end if;
  if tg_op = 'UPDATE' and new.item_id is not distinct from old.item_id and old.deleted_at is null then return new; end if;
  select i.kind, k.consumable into v_kind, v_consumable
    from resources.items i left join resources.item_kinds k on k.kind = i.kind and k.deleted_at is null
   where i.id = new.item_id and i.deleted_at is null;
  if v_kind is null then
    perform core.fail('INVALID_ITEM', 422, jsonb_build_object('field', 'item_id', 'item_id', new.item_id, 'reason', 'not_found'));
  end if;
  if coalesce(v_consumable, true) <> v_want then
    perform core.fail('INVALID_ITEM', 422, jsonb_build_object('field', 'item_id', 'item_id', new.item_id, 'reason', 'kind', 'kind', v_kind));
  end if;
  if tg_table_name = 'ingredients' then
    select id into v_other from food.ingredients where item_id = new.item_id and id <> new.id and deleted_at is null limit 1;
  else
    select id into v_other from food.equipment where item_id = new.item_id and id <> new.id and deleted_at is null limit 1;
  end if;
  if v_other is not null then
    perform core.fail('INVALID_ITEM', 422, jsonb_build_object('field', 'item_id', 'item_id', new.item_id, 'reason', 'linked', 'existingId', v_other));
  end if;
  return new;
end $$;

create trigger food_guard_ingredient_item before insert or update on food.ingredients
  for each row execute function food.guard_resource_link();
create trigger food_guard_equipment_item before insert or update on food.equipment
  for each row execute function food.guard_resource_link();

select core.register_table('food', 'food', 'ingredients', array['name','preferred_unit','preferred_supplier','active','item_id']);
select core.register_table('food', 'food', 'equipment', array['name','category','quantity','capacity','location','status','notes','item_id']);
