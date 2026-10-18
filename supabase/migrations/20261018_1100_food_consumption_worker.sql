-- Food · R5c, P17: el consumo que lleva 24 h sin confirmar se descuenta en el servidor, sin esperar a que alguien abra
-- la app (respuesta de Core del 18-10-2026; docs/food/API.md §2.8). Toca solo el schema food; lee resources y core.
-- Es la primera migración del segundo bloque de Food (1100–1199): el primero (0100–0199) está completo.
--
-- - `food.consumption_due`: los platos vencidos (24 h después de quedar por confirmar, desde el 15-10-2026) sin consumo
--   anotado ni movimientos, y los automáticos ya anotados cuyo descuento no llegó a Recursos (para reintentarlo). Para
--   cada uno, lo que gasta en la unidad base de cada artículo, con las mismas reglas que la app (`consumptionLines`):
--   misma familia de unidad o una conversión del artículo sin proveedor.
-- - El worker `POST /api/v1/worker/consumption/tick` (food-api), con la cuenta de servicio `food`:
--   1. anota el consumo en Food (`food.consumptions`, id fijo por plato). Es el cerrojo: un plato, un consumo vivo, así
--      que si la app ya lo hizo, aquí se salta;
--   2. descuenta en Recursos con `resources.consume`, con un `requestId` fijo por plato (repetirlo devuelve el recibo).
-- - Solo se despierta si existe la cuenta de servicio `food` (la da de alta Core), hay cocina en Recursos y hay trabajo.

create or replace function food.consumption_due(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_limit int := least(greatest(coalesce((a->>'limit')::int, 50), 1), 200);
  v_kitchen uuid[];
  v_out jsonb;
begin
  select coalesce(array_agg(k.space_id), '{}') into v_kitchen from food.kitchen_spaces() k;
  if cardinality(v_kitchen) = 0 then return jsonb_build_object('kitchen', '[]'::jsonb, 'items', '[]'::jsonb); end if;
  with due as (
    select mi.id, mi.servings, rc.id as recipe_id, rc.name as recipe_name, rc.base_servings, s.service_type, s.service_date,
           exists (select 1 from food.consumptions c where c.menu_item_id = mi.id and c.deleted_at is null) as noted
      from food.menu_items mi
      join food.menu_services s on s.id = mi.service_id
      join food.menus m on m.id = s.menu_id
      join food.recipes rc on rc.id = mi.recipe_id
     where mi.deleted_at is null and s.deleted_at is null and m.deleted_at is null
       and s.service_date >= date '2026-10-15'
       -- Por confirmar a las 2 h de la hora del servicio (sin hora, a las 23:59), en hora de Madrid; solo, 24 h después.
       and (coalesce(s.service_date + s.service_time + interval '2 hours', s.service_date + time '23:59') at time zone 'Europe/Madrid') + interval '24 hours' <= now()
       and not exists (select 1 from resources.movements mv where mv.source_ref = 'menu_item:' || mi.id and mv.deleted_at is null)
       and (not exists (select 1 from food.consumptions c where c.menu_item_id = mi.id and c.deleted_at is null)
            or exists (select 1 from food.consumptions c where c.menu_item_id = mi.id and c.deleted_at is null and c.automatic and c.status = 'confirmado'))
     order by s.service_date, mi.id
     limit v_limit),
  lines as (
    select d.id as menu_item_id, it.id as item_id, it.default_space_id,
           case
             when food.food_unit(it.base_unit) is not null and food.unit_family(food.food_unit(it.base_unit)) = food.unit_family(ri.unit)
               then ri.quantity * mi_q.factor * food.unit_factor(ri.unit) / food.unit_factor(food.food_unit(it.base_unit))
             else ri.quantity * mi_q.factor * (select u.factor from resources.item_units u
                                                where u.item_id = it.id and u.deleted_at is null and u.supplier_id is null
                                                  and lower(btrim(u.unit)) in (ri.unit, case ri.unit when 'unidad' then 'ud' end) limit 1)
           end as quantity
      from due d
      cross join lateral (select d.servings / d.base_servings as factor) mi_q
      join food.recipe_ingredients ri on ri.recipe_id = d.recipe_id and ri.deleted_at is null
      join food.ingredients g on g.id = ri.ingredient_id
      join resources.items it on it.id = g.item_id and it.deleted_at is null)
  select jsonb_agg(jsonb_build_object(
           'menu_item_id', d.id, 'retry', d.noted,
           'note', d.recipe_name || ' · ' || d.service_type || ' del ' || to_char(d.service_date, 'YYYY-MM-DD') || ' · descontado solo a las 24 h',
           'calls', coalesce((select jsonb_agg(jsonb_build_object('item_id', l.item_id, 'quantity', round(l.quantity, 6), 'default_space_id', l.default_space_id))
                                from lines l where l.menu_item_id = d.id and l.quantity > 0), '[]'::jsonb))
         order by d.service_date, d.id)
    into v_out from due d;
  return jsonb_build_object('kitchen', to_jsonb(v_kitchen), 'items', coalesce(v_out, '[]'::jsonb));
end $$;
select core.allow_read('food', 'food.consumption_due', 'function', '{editor,owner}');

-- Despierta el worker solo si puede trabajar: con la cuenta de servicio `food` ya creada en el núcleo y algo vencido.
create or replace function food.consumption_has_work()
returns boolean language plpgsql stable as $$
begin
  if core.service_actor('food') is null then return false; end if;
  return jsonb_array_length(food.consumption_due('{}'::jsonb)->'items') > 0;
end $$;

select core.schedule_tick('food', 'consumption/tick', '*/15 * * * *', 'food.consumption_has_work');
