-- Food · orden a mano de los pasos de preparación (decisión del usuario del 6 de octubre de 2026).
-- Dentro de un día los pasos van por hora hasta que alguien los ordena a mano; desde entonces manda `position`.
-- food.regenerate_preparation insertaba siempre con posición 0, así que en un día ya ordenado los pasos nuevos
-- aparecían arriba. Ahora van al final de ese día. El resto del procedimiento no cambia. Toca solo el schema food.
create or replace function food.regenerate_preparation(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_menu food.menus; v_prep food.preparation_items; r record; v_when timestamp; v_date date; v_time time; v_text text;
  v_inserted int := 0; v_updated int := 0; v_deleted int := 0; v_kept int := 0; v_last numeric;
begin
  select * into v_menu from food.menus where id = (a->>'menu_id')::uuid and deleted_at is null for update;
  if v_menu.id is null then perform core.fail('MENU_NOT_FOUND', 422, jsonb_build_object('menu_id', a->>'menu_id')); end if;

  for r in
    select mi.id as item_id, mi.recipe_id, rc.name, rc.prep_minutes, s.service_date, s.service_time
    from food.menu_items mi
    join food.menu_services s on s.id = mi.service_id
    join food.recipes rc on rc.id = mi.recipe_id
    where s.menu_id = v_menu.id and s.deleted_at is null and mi.deleted_at is null
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

  -- Propuestas de platos que ya no están en el menú: fuera, salvo que estén hechas o el cocinero las hiciera suyas.
  for v_prep in
    select x.* from food.preparation_items x
    where x.menu_id = v_menu.id and x.deleted_at is null and not x.manual and not x.done and x.menu_item_id is not null
      and not exists (
        select 1 from food.menu_items mi join food.menu_services s on s.id = mi.service_id
        where mi.id = x.menu_item_id and mi.deleted_at is null and s.deleted_at is null)
  loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
      'op', 'delete', 'table', 'food.preparation_items', 'id', v_prep.id, 'expectedRevision', v_prep.revision));
    v_deleted := v_deleted + 1;
  end loop;

  perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object(
    'op', 'update', 'table', 'food.menus', 'id', v_menu.id, 'expectedRevision', v_menu.revision,
    'fields', jsonb_build_object('preparation_generated_at', now(), 'preparation_source_revisions', food.preparation_sources(v_menu.id))));
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'deleted', v_deleted, 'kept', v_kept);
end $$;
