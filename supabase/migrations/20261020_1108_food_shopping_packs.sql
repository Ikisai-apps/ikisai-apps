-- Food · tanda 40 (MUELA-093, PERDIDAS_food_093.md §2 y §4; contrato de envases en docs/resources/API.md, 0810). Toca
-- solo el schema food; lee resources.
--
-- - **Lo comprado no se recalcula.** `food.regenerate_shopping` ya no toca «En casa» ni «Comprar» de las líneas que no
--   estén pendientes (antes las reescribía: 0198, líneas 146-155 y 217-221). «En casa» ya lleva lo que se acaba de
--   comprar, así que «Comprar» bajaba, a veces a 0, y al desmarcar y volver a marcar la Despensa recibía la cifra nueva.
--   Lo que ya no hace falta y está comprado se queda con su compra; solo su necesidad pasa a 0.
-- - **S5, redondeo al envase habitual** (`resources.item_units.usual`, como mucho uno vivo por artículo): «Comprar» son
--   envases enteros del habitual, solo en las líneas pendientes y sin cifra fijada a mano. Solo cuenta un envase de la
--   misma familia que la unidad de la línea (g/kg, ml/l, unidades), como `from_base`. Igual que `roundToPack` del
--   dominio, que usan «En casa» y «Recalcular» en la app.
-- - Lo demás, idéntico a 0198.

-- Tamaño del envase habitual del artículo en la unidad de la línea; null si no tiene o no es de la misma familia.
create or replace function food.usual_pack(p_item uuid, p_base text, p_unit text)
returns numeric language plpgsql stable as $$
begin
  if p_item is null then return null; end if;
  return (select food.from_base(u.factor, p_base, p_unit) from resources.item_units u
           where u.item_id = p_item and u.usual and u.deleted_at is null
           order by u.updated_at desc, u.id limit 1);
end $$;

-- Envases enteros: lo que hace falta, redondeado hacia arriba al tamaño del envase (sin envase, igual).
create or replace function food.round_pack(p_quantity numeric, p_size numeric)
returns numeric language sql immutable as $$
  select case when p_quantity is null or p_size is null or p_size <= 0 or p_quantity <= 0 then p_quantity
              else round(ceil(p_quantity / p_size - 0.000000001) * p_size, 3) end;
$$;

-- ---------------------------------------------------------------------------
-- food.regenerate_shopping: igual que en 0198, con el redondeo al envase y sin tocar las cantidades de lo comprado.
-- ---------------------------------------------------------------------------
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
  v_sources := food.shopping_sources(v_menu.id, v_from, v_to);
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


revoke all on function food.usual_pack(uuid, text, text), food.round_pack(numeric, numeric) from public, anon, authenticated;
grant execute on function food.usual_pack(uuid, text, text), food.round_pack(numeric, numeric) to service_role;
