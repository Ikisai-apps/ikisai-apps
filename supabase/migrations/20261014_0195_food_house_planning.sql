-- Food · O3b: compra y preparación del menú de casa por un rango de fechas elegido al generarlas
-- (decisión del usuario, 13-10-2026; docs/food/API.md §2.6 y §3.2–3.3). Toca solo el schema food.
--
-- En un retiro todo sigue igual: una lista viva por menú, sin rango, y la preparación de todos sus servicios.
-- En el menú de casa, que no se acaba nunca:
-- - `shopping_lists.period_start/period_end`: cada lista cubre un rango de días. Las listas vivas del menú de casa no se
--   solapan (PERIOD_OVERLAP); regenerar el mismo rango reutiliza su lista.
-- - `food.regenerate_shopping` y `food.regenerate_preparation` reciben `period_start` y `period_end`, obligatorios en casa
--   y prohibidos en un retiro (INVALID_PERIOD), y solo miran los servicios de esos días.

-- ---------------------------------------------------------------------------
-- Listas con rango
-- ---------------------------------------------------------------------------
alter table food.shopping_lists add column period_start date;
alter table food.shopping_lists add column period_end date;
alter table food.shopping_lists add constraint shopping_lists_period check (
  (period_start is null and period_end is null)
  or (period_start is not null and period_end is not null and period_start <= period_end and period_end - period_start <= 62));
drop index food.shopping_lists_menu_key;
create unique index shopping_lists_menu_key on food.shopping_lists (menu_id) where deleted_at is null and period_start is null;
create unique index shopping_lists_menu_period_key on food.shopping_lists (menu_id, period_start, period_end)
  where deleted_at is null and period_start is not null;

-- Lista: menú y rango inmutables; con rango solo en el menú de casa (y en él, siempre); sin solaparse con otra viva.
create or replace function food.guard_shopping_list()
returns trigger language plpgsql as $$
declare v_kind text; v_other food.shopping_lists;
begin
  if tg_op = 'UPDATE' then
    if new.menu_id <> old.menu_id then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_id'));
    end if;
    if (new.period_start, new.period_end) is distinct from (old.period_start, old.period_end) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'period_start'));
    end if;
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null) then
    select m.kind into v_kind from food.menus m where m.id = new.menu_id;
    if (v_kind = 'casa') <> (new.period_start is not null) then
      perform core.fail('INVALID_PERIOD', 422, jsonb_build_object('menu_id', new.menu_id,
        'reason', case when v_kind = 'casa' then 'required' else 'not_allowed' end));
    end if;
    if new.period_start is not null then
      select * into v_other from food.shopping_lists l
        where l.menu_id = new.menu_id and l.id <> new.id and l.deleted_at is null and l.period_start is not null
          and l.period_start <= new.period_end and new.period_start <= l.period_end
        order by l.period_start limit 1;
      if v_other.id is not null then
        perform core.fail('PERIOD_OVERLAP', 422, jsonb_build_object('list_id', v_other.id,
          'period_start', v_other.period_start, 'period_end', v_other.period_end));
      end if;
    end if;
  end if;
  return new;
end $$;
drop trigger food_guard_shopping_list on food.shopping_lists;
create trigger food_guard_shopping_list before insert or update on food.shopping_lists
  for each row execute function food.guard_shopping_list();

-- ---------------------------------------------------------------------------
-- Rango de un procedimiento: null en un retiro; obligatorio, válido y de como mucho 63 días en casa.
-- ---------------------------------------------------------------------------
create or replace function food.call_period(p_menu food.menus, a jsonb, out p_from date, out p_to date)
language plpgsql as $$
begin
  p_from := nullif(a->>'period_start', '')::date;
  p_to := nullif(a->>'period_end', '')::date;
  if p_menu.kind = 'casa' then
    if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 62 then
      perform core.fail('INVALID_PERIOD', 422, jsonb_build_object('menu_id', p_menu.id, 'reason', 'required'));
    end if;
  elsif p_from is not null or p_to is not null then
    perform core.fail('INVALID_PERIOD', 422, jsonb_build_object('menu_id', p_menu.id, 'reason', 'not_allowed'));
  end if;
end $$;

-- Revisiones de origen de la lista (§2.4), con rango opcional. La versión de un argumento sigue sirviendo a los retiros.
create or replace function food.shopping_sources(p_menu uuid, p_from date, p_to date)
returns jsonb language sql stable as $$
  with i as (select mi.* from food.menu_items mi join food.menu_services s on s.id = mi.service_id
             where s.menu_id = p_menu and s.deleted_at is null and mi.deleted_at is null
               and (p_from is null or s.service_date between p_from and p_to)),
       r as (select * from food.recipes where id in (select recipe_id from i)),
       l as (select * from food.recipe_ingredients where recipe_id in (select id from r) and deleted_at is null),
       g as (select * from food.ingredients where id in (select ingredient_id from l))
  select coalesce(jsonb_object_agg(x.id::text, x.revision), '{}'::jsonb) from (
    select id, revision from i union all select id, revision from r union all select id, revision from l union all select id, revision from g) x;
$$;

-- ---------------------------------------------------------------------------
-- food.regenerate_shopping: igual que en 0130, con el rango del menú de casa.
-- ---------------------------------------------------------------------------
create or replace function food.regenerate_shopping(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_list food.shopping_lists; v_item food.shopping_list_items; v_created boolean := false;
  v_sources jsonb; r record; v_required numeric; v_fields jsonb; v_seen uuid[] := '{}'; v_new uuid; v_ratio numeric;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_status text; v_from date; v_to date;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;
  select * into v_from, v_to from food.call_period(v_menu, a);
  v_sources := food.shopping_sources(v_menu.id, v_from, v_to);

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
    select l.ingredient_id, l.family, l.base_total, g.preferred_supplier, food.output_unit(l.family, l.base_total, g.preferred_unit) as unit
    from lines l join food.ingredients g on g.id = l.ingredient_id
    order by l.ingredient_id, l.family
  loop
    v_required := round(r.base_total / food.unit_factor(r.unit), 3);
    select * into v_item from food.shopping_list_items i
      where i.shopping_list_id = v_list.id and i.ingredient_id = r.ingredient_id and not i.manual and i.deleted_at is null
        and food.unit_family(i.unit) = r.family
      order by i.created_at, i.id limit 1;
    if v_item.id is null then
      v_new := gen_random_uuid();
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.shopping_list_items', 'id', v_new,
        'fields', jsonb_build_object('shopping_list_id', v_list.id, 'ingredient_id', r.ingredient_id, 'required_quantity', v_required,
          'unit', r.unit, 'purchase_quantity', v_required, 'supplier', r.preferred_supplier)));
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
      if not v_item.manual_override and v_item.purchase_quantity <> greatest(v_required - coalesce(v_item.stock_quantity, 0), 0) then
        v_fields := v_fields || jsonb_build_object('purchase_quantity', greatest(v_required - coalesce(v_item.stock_quantity, 0), 0));
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

-- ---------------------------------------------------------------------------
-- food.regenerate_preparation: igual que en 0150, con el rango del menú de casa. En casa solo mira los platos de esos
-- días y solo retira propuestas de esos días; la marca de obsolescencia del menú (§2.4) es solo de los retiros.
-- ---------------------------------------------------------------------------
create or replace function food.regenerate_preparation(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_prep food.preparation_items; r record; v_when timestamp; v_date date; v_time time; v_text text;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_last numeric; v_from date; v_to date;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null for update;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;
  select * into v_from, v_to from food.call_period(v_menu, a);

  for r in
    select mi.id as item_id, mi.recipe_id, rc.name, rc.prep_minutes, s.service_date, s.service_time
    from food.menu_items mi
    join food.menu_services s on s.id = mi.service_id
    join food.recipes rc on rc.id = mi.recipe_id
    where s.menu_id = v_menu.id and s.deleted_at is null and mi.deleted_at is null
      and (v_from is null or s.service_date between v_from and v_to)
    order by s.service_date, s.service_time nulls last, s.position, mi.position, mi.id
  loop
    v_text := left('Preparar ' || r.name, 300);
    if r.service_time is null then
      v_date := r.service_date; v_time := null;
    else
      v_when := (r.service_date + r.service_time) - make_interval(mins => coalesce(r.prep_minutes, 120));
      v_date := v_when::date; v_time := v_when::time;
    end if;
    select * into v_prep from food.preparation_items x
      where x.menu_id = v_menu.id and x.menu_item_id = r.item_id and x.deleted_at is null
      order by x.created_at, x.id limit 1;
    if v_prep.id is null then
      -- Día ya ordenado a mano (alguna posición mayor que 0): el paso nuevo va al final. Si no, posición 0 y se coloca por su hora.
      select coalesce(max(x.position), 0) into v_last from food.preparation_items x
        where x.menu_id = v_menu.id and x.deleted_at is null and x.scheduled_date is not distinct from v_date;
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'insert', 'table', 'food.preparation_items', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('menu_id', v_menu.id, 'menu_item_id', r.item_id, 'recipe_id', r.recipe_id,
          'scheduled_date', v_date, 'scheduled_time', v_time, 'text', v_text,
          'position', case when v_last > 0 then v_last + 1 else 0 end)));
      v_inserted := v_inserted + 1;
    elsif not v_prep.manual and not v_prep.done
          and (v_prep.text, v_prep.scheduled_date, v_prep.scheduled_time) is distinct from (v_text, v_date, v_time) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
        'op', 'update', 'table', 'food.preparation_items', 'id', v_prep.id, 'expectedRevision', v_prep.revision,
        'fields', jsonb_build_object('scheduled_date', v_date, 'scheduled_time', v_time, 'text', v_text)));
      v_updated := v_updated + 1;
    else
      v_kept := v_kept + 1;
    end if;
  end loop;

  -- Propuestas de platos que ya no están en el menú: fuera, salvo hechas o propias. En casa, solo las de esos días.
  for v_prep in
    select x.* from food.preparation_items x
    where x.menu_id = v_menu.id and x.deleted_at is null and not x.manual and not x.done and x.menu_item_id is not null
      and (v_from is null or x.scheduled_date between v_from - 7 and v_to)
      and not exists (
        select 1 from food.menu_items mi join food.menu_services s on s.id = mi.service_id
        where mi.id = x.menu_item_id and mi.deleted_at is null and s.deleted_at is null)
  loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'delete', 'table', 'food.preparation_items', 'id', v_prep.id, 'expectedRevision', v_prep.revision));
    v_deleted := v_deleted + 1;
  end loop;

  if v_from is null then
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'update', 'table', 'food.menus', 'id', v_menu.id, 'expectedRevision', v_menu.revision,
      'fields', jsonb_build_object('preparation_generated_at', now(), 'preparation_source_revisions', food.preparation_sources(v_menu.id))));
  end if;
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted, 'kept', v_kept);
end $$;

select core.register_table('food', 'food', 'shopping_lists', array['menu_id','status','generated_at','source_revisions','notes','period_start','period_end']);
