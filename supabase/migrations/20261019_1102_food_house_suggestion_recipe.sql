-- Food · tanda 27 (rediseño de La Muela, MUELA-033 y 068 §3): «Usar “receta parecida”» y «Ya pasó» en las sugerencias de
-- plato del menú de casa. Toca solo el schema food. Rehace `food.house_dish_from_suggestion` (0196) con dos cambios:
-- - `recipe_id` opcional: quien aprueba corrige el lote (`core.suggestion_decide` con `p_operations`) para usar una receta
--   del Recetario en lugar de la del nombre. Tiene que estar viva y no archivada; si no, INVALID_OPERATION (`recipe_id`).
-- - Un día que ya pasó (hora de Madrid) se rechaza: INVALID_OPERATION con `argument: 'date'` y `reason: 'past'`. Al
--   aprobar, la sugerencia sigue pendiente y quien decide la descarta. Hasta hoy solo se validaba el formato.
-- Lo demás, igual que en 0196.

create or replace function food.house_dish_from_suggestion(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb); v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_name text := btrim(coalesce(a->>'name', '')); v_type text := a->>'service'; v_date date; v_recipe_id uuid;
  v_menu food.menus; v_service food.menu_services; v_recipe food.recipes; v_item uuid; v_servings numeric; v_id uuid;
  v_created_menu boolean := false; v_created_service boolean := false; v_created_recipe boolean := false; v_created_item boolean := false;
begin
  -- Argumentos. La sugerencia llega desde Guests, así que aquí no ha pasado la validación de la Edge de Food.
  if char_length(v_name) not between 1 and 160 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'name'));
  end if;
  if coalesce(v_type, '') not in ('desayuno','comida','cena','picnic','merienda','otro') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'service'));
  end if;
  if coalesce(a->>'date', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'date'));
  end if;
  begin
    v_date := (a->>'date')::date;
  exception when others then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'date'));
  end;

  -- Tanda 27: ningún día que ya haya pasado (hora de Madrid, la de la casa).
  if v_date < (now() at time zone 'Europe/Madrid')::date then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'date', 'reason', 'past'));
  end if;
  -- Tanda 27: «Usar “receta parecida”». Quien aprueba corrige el lote con `recipe_id`: una receta viva y no archivada.
  if a ? 'recipe_id' and jsonb_typeof(a->'recipe_id') <> 'null' then
    if coalesce(a->>'recipe_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'recipe_id'));
    end if;
    v_recipe_id := (a->>'recipe_id')::uuid;
    select * into v_recipe from food.recipes where id = v_recipe_id and deleted_at is null and status <> 'archivada';
    if v_recipe.id is null then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'food.house_dish_from_suggestion', 'argument', 'recipe_id', 'reason', 'not_found'));
    end if;
  end if;

  -- Menú de casa (uno solo; id fijo, el mismo que usa la app: HOUSE_MENU_ID).
  select * into v_menu from food.menus where kind = 'casa' and deleted_at is null for update;
  if v_menu.id is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.menus', 'id', 'f00dca5a-0000-4000-8000-000000000001', 'fields', jsonb_build_object('kind', 'casa')));
    select * into v_menu from food.menus where id = 'f00dca5a-0000-4000-8000-000000000001';
    v_created_menu := true;
  end if;
  v_servings := coalesce(nullif(v_menu.house_servings, 0), 1);

  -- Servicio de ese día.
  select * into v_service from food.menu_services
    where menu_id = v_menu.id and service_date = v_date and service_type = v_type and deleted_at is null
    order by position, service_time nulls last, created_at limit 1;
  if v_service.id is null then
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.menu_services', 'id', v_id, 'fields', jsonb_build_object(
        'menu_id', v_menu.id, 'service_date', v_date, 'service_type', v_type,
        'service_time', case v_type when 'desayuno' then '09:00' when 'comida' then '14:00' when 'cena' then '20:30' end,
        'position', coalesce((select max(position) from food.menu_services where menu_id = v_menu.id and service_date = v_date and deleted_at is null), 0) + 1)));
    select * into v_service from food.menu_services where id = v_id;
    v_created_service := true;
  end if;

  -- Receta: la elegida, o la del mismo nombre, o una rápida.
  if v_recipe_id is null then
    select * into v_recipe from food.recipes
      where lower(btrim(name)) = lower(v_name) and deleted_at is null and status <> 'archivada'
      order by (status = 'validada') desc, quick, created_at limit 1;
  end if;
  if v_recipe.id is null then
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.recipes', 'id', v_id, 'fields', jsonb_build_object(
        'name', v_name, 'category', case when v_type in ('desayuno','merienda','picnic') then v_type else 'principal' end,
        'base_servings', v_servings, 'quick', true)));
    select * into v_recipe from food.recipes where id = v_id;
    v_created_recipe := true;
  end if;

  -- Plato, si no está ya en ese servicio.
  select id into v_item from food.menu_items where service_id = v_service.id and recipe_id = v_recipe.id and deleted_at is null limit 1;
  if v_item is null then
    v_item := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'insert', 'table', 'food.menu_items', 'id', v_item, 'fields', jsonb_build_object(
        'service_id', v_service.id, 'recipe_id', v_recipe.id, 'servings', v_servings,
        'position', coalesce((select max(position) from food.menu_items where service_id = v_service.id and deleted_at is null), 0) + 1)));
    v_created_item := true;
  end if;

  return jsonb_build_object('menu_id', v_menu.id, 'service_id', v_service.id, 'recipe_id', v_recipe.id, 'item_id', v_item,
    'created_menu', v_created_menu, 'created_service', v_created_service, 'created_recipe', v_created_recipe, 'created_item', v_created_item);
end $$;
