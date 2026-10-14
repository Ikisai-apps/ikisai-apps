-- Food · R5b: la lista de la compra con el stock de Recursos (coordinacion/ampliacion/RECURSOS.md §6 «Food»; decisiones
-- del usuario del 14-10-2026; docs/food/API.md §2.3 y §3.2). Toca solo el schema food; lee resources.
--
-- - «En casa» (`stock_quantity`) sale del inventario al generar: lo que hay en la cocina, sus despensas y sus cámaras
--   (`food.kitchen_spaces`), sin los lotes que caducan antes del primer día de la lista. Si el artículo nunca ha tenido
--   movimientos allí, se queda como hoy (vacío, para escribirlo a mano). Sigue siendo editable.
-- - El mínimo del artículo (`min_quantity`) se suma: comprar = necesario + mínimo − en casa.
-- - «Reponer» (`restock`): los ingredientes bajo mínimo que ningún menú de la lista pide, en un grupo aparte, si no los
--   lleva ya otra lista abierta.
-- - Lo demás de `food.regenerate_shopping` es idéntico a 0195 (y sin datos de inventario, el resultado también).

alter table food.shopping_list_items add column min_quantity numeric(12,3) check (min_quantity is null or min_quantity >= 0);
alter table food.shopping_list_items add column restock boolean not null default false;

-- ---------------------------------------------------------------------------
-- Dónde cuenta el stock de cocina (decisión del usuario: solo cocina, despensas y cámaras)
-- ---------------------------------------------------------------------------
-- Los espacios de tipo cocina, los almacenes y ubicaciones que se llaman despensa, cámara, nevera o congelador o que
-- guardan en frío, y todo lo que cuelga de ellos. Igual que `isKitchenSpace` del dominio.
-- En plpgsql (como las que leen Recursos en 0197): el cuerpo se comprueba al ejecutarse, no al crearse, y así no depende
-- del orden de las migraciones del mismo día.
create or replace function food.kitchen_spaces()
returns table (space_id uuid) language plpgsql stable as $$
begin
  return query
  with recursive roots as (
    select s.id from resources.spaces s
     where s.deleted_at is null and s.active
       and (s.kind = 'cocina'
            or (s.kind in ('almacen', 'ubicacion')
                and (s.name ~* '(despensa|c[aá]mara|nevera|frigor[ií]fico|congelador)' or s.attributes->>'storage' in ('frio', 'congelado'))))),
  tree as (
    select id from roots
    union
    select s.id from resources.spaces s join tree t on s.parent_id = t.id where s.deleted_at is null)
  select tree.id from tree;
end $$;

-- Unidad de Food de la unidad base de un artículo («ud» es «unidad»); null si Food no la tiene.
create or replace function food.food_unit(p_base text)
returns text language sql immutable as $$
  select case when lower(btrim(p_base)) in ('ud', 'uds', 'unidad') then 'unidad'
              when lower(btrim(p_base)) in ('g','kg','ml','l','paquete','manojo','otro') then lower(btrim(p_base)) end;
$$;

-- Stock de cocina de un artículo en su unidad base, sin lotes caducados antes de `p_on`. Null si nunca ha tenido
-- movimientos en la cocina (no se sabe cuánto hay: se escribe a mano, como antes de R5).
create or replace function food.kitchen_stock(p_item uuid, p_on date)
returns numeric language plpgsql stable as $$
begin
  return (select case when count(*) = 0 then null
              else greatest(coalesce(sum(m.quantity) filter (where l.id is null or l.expires_on is null or l.expires_on >= p_on), 0), 0) end
    from resources.movements m
    left join resources.lots l on l.id = m.lot_id
   where m.item_id = p_item and m.deleted_at is null and m.space_id in (select k.space_id from food.kitchen_spaces() k));
end $$;

-- Una cantidad en la unidad base del artículo, pasada a una unidad de Food de la misma familia; null si no se puede.
create or replace function food.from_base(p_quantity numeric, p_base text, p_unit text)
returns numeric language sql immutable as $$
  select case when p_quantity is null or food.food_unit(p_base) is null then null
              when food.unit_family(food.food_unit(p_base)) <> food.unit_family(p_unit) then null
              else round(p_quantity * food.unit_factor(food.food_unit(p_base)) / food.unit_factor(p_unit), 3) end;
$$;

-- ---------------------------------------------------------------------------
-- food.regenerate_shopping: igual que en 0195, con stock, mínimos y «Reponer».
-- ---------------------------------------------------------------------------
create or replace function food.regenerate_shopping(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_list food.shopping_lists; v_item food.shopping_list_items; v_created boolean := false;
  v_sources jsonb; r record; v_required numeric; v_fields jsonb; v_seen uuid[] := '{}'; v_new uuid; v_ratio numeric;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_status text; v_from date; v_to date;
  v_on date; v_stock numeric; v_min numeric; v_purchase numeric; v_wanted uuid[] := '{}';
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
    select * into v_item from food.shopping_list_items i
      where i.shopping_list_id = v_list.id and i.ingredient_id = r.ingredient_id and not i.manual and i.deleted_at is null
        and food.unit_family(i.unit) = r.family
      order by i.created_at, i.id limit 1;
    if v_item.id is null then
      v_new := gen_random_uuid();
      v_purchase := greatest(v_required + coalesce(v_min, 0) - coalesce(v_stock, 0), 0);
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
      -- Con inventario, «en casa» es lo que dice el inventario; sin él, lo que se escribió a mano.
      if v_stock is not null and v_item.stock_quantity is distinct from v_stock then
        v_item.stock_quantity := v_stock;
        v_fields := v_fields || jsonb_build_object('stock_quantity', v_stock);
      end if;
      if v_item.min_quantity is distinct from v_min then v_fields := v_fields || jsonb_build_object('min_quantity', v_min); end if;
      if v_item.restock then v_fields := v_fields || jsonb_build_object('restock', false); end if;
      v_purchase := greatest(v_required + coalesce(v_min, 0) - coalesce(v_item.stock_quantity, 0), 0);
      if not v_item.manual_override and v_item.purchase_quantity <> v_purchase then
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
    select g.id as ingredient_id, g.preferred_supplier, it.base_unit, it.min_quantity, food.food_unit(it.base_unit) as unit,
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
    v_purchase := round(greatest(r.min_quantity - coalesce(v_stock, 0), 0), 3);
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
      if v_item.stock_quantity is distinct from v_stock and v_stock is not null then v_fields := v_fields || jsonb_build_object('stock_quantity', v_stock); end if;
      if v_item.min_quantity is distinct from r.min_quantity then v_fields := v_fields || jsonb_build_object('min_quantity', r.min_quantity); end if;
      if not v_item.manual_override and v_item.purchase_quantity <> v_purchase then v_fields := v_fields || jsonb_build_object('purchase_quantity', v_purchase); end if;
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
      v_fields := jsonb_build_object('required_quantity', 0);
      if not v_item.manual_override then v_fields := v_fields || jsonb_build_object('purchase_quantity', 0); end if;
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

select core.register_table('food', 'food', 'shopping_list_items', array[
  'shopping_list_id','ingredient_id','required_quantity','unit','stock_quantity','purchase_quantity','supplier','status','manual_override','manual','notes',
  'min_quantity','restock']);
