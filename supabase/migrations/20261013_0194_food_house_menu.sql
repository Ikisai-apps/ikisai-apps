-- Food · O3a: menú de casa y plato rápido (coordinacion/ampliacion/RECURSOS.md §15.3; docs/food/API.md §2.2 y §2.6).
-- Toca solo el schema food. Todo lo que ya existe sigue igual: un menú sin `kind` es un retiro con evento y sus reglas.
--
-- - `menus.kind`: 'retiro' (por defecto, con evento) o 'casa' (sin evento). Hay un solo menú de casa vivo; no se borra,
--   no cambia de estado (no se valida ni se cierra) y lleva `house_servings`, las personas en casa por defecto.
-- - `recipes.quick`: receta nacida como plato rápido (solo el nombre). Está «por completar» mientras no tenga los alérgenos
--   revisados y al menos un ingrediente (decisión del usuario, 13-10-2026). Una receta por completar no entra en un menú
--   de retiro (salvaguarda aprobada): lo impide `food.guard_menu_item` con QUICK_RECIPE_IN_RETREAT.
--   «Por completar» se calcula siempre a partir de la receta y sus líneas (`food.recipe_quick_pending`), en vez de apagar
--   la marca desde un trigger: así no hay escrituras fuera de `core.commit` y todos los dispositivos ven lo mismo.

-- ---------------------------------------------------------------------------
-- Menú de casa
-- ---------------------------------------------------------------------------
alter table food.menus add column kind text not null default 'retiro' check (kind in ('retiro','casa'));
alter table food.menus add column house_servings numeric(8,2) check (house_servings is null or house_servings > 0);
alter table food.menus alter column event_id drop not null;
alter table food.menus alter column source_event_revision drop not null;
alter table food.menus add constraint menus_kind_event check (
  (kind = 'retiro' and event_id is not null and source_event_revision is not null)
  or (kind = 'casa' and event_id is null and source_event_revision is null and source_event_snapshot is null));
alter table food.menus add constraint menus_house_servings check (house_servings is null or kind = 'casa');
create unique index menus_house_key on food.menus (kind) where kind = 'casa' and deleted_at is null;

-- Menú: kind y event_id inmutables; un menú vivo por evento; un solo menú de casa, que ni se borra ni cambia de estado;
-- no se borra un retiro validado o cerrado.
create or replace function food.guard_menu()
returns trigger language plpgsql as $$
declare v_other uuid;
begin
  if tg_op = 'UPDATE' then
    if new.event_id is distinct from old.event_id then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'event_id'));
    end if;
    if new.kind <> old.kind then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'kind'));
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      if old.kind = 'casa' then
        perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'delete'));
      end if;
      if old.status in ('validado','cerrado') then
        perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', new.id, 'status', old.status));
      end if;
    end if;
    if new.kind = 'casa' and new.status <> old.status then
      perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'status'));
    end if;
  end if;
  if tg_op = 'INSERT' and new.kind = 'casa' and new.status <> 'borrador' then
    perform core.fail('HOUSE_MENU', 422, jsonb_build_object('menu_id', new.id, 'action', 'status'));
  end if;
  if new.deleted_at is null then
    if new.event_id is not null then
      select m.id into v_other from food.menus m where m.event_id = new.event_id and m.id <> new.id and m.deleted_at is null limit 1;
      if v_other is not null then
        perform core.fail('MENU_EXISTS', 422, jsonb_build_object('menuId', v_other, 'event_id', new.event_id));
      end if;
    elsif new.kind = 'casa' then
      select m.id into v_other from food.menus m where m.kind = 'casa' and m.id <> new.id and m.deleted_at is null limit 1;
      if v_other is not null then
        perform core.fail('MENU_EXISTS', 422, jsonb_build_object('menuId', v_other, 'kind', 'casa'));
      end if;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Plato rápido
-- ---------------------------------------------------------------------------
alter table food.recipes add column quick boolean not null default false;

-- Una receta rápida está por completar mientras le falten los alérgenos revisados o algún ingrediente.
create or replace function food.recipe_quick_pending(p_recipe uuid)
returns boolean language sql stable as $$
  select coalesce((
    select r.quick and not (r.allergens_checked and exists (
      select 1 from food.recipe_ingredients l where l.recipe_id = r.id and l.deleted_at is null))
    from food.recipes r where r.id = p_recipe), false);
$$;

-- Receta: no pasa a validada sin alérgenos revisados; `quick` se fija al crearla y no cambia.
create or replace function food.guard_recipe()
returns trigger language plpgsql as $$
begin
  if new.status = 'validada' and not new.allergens_checked then
    perform core.fail('ALLERGENS_UNCHECKED', 422, jsonb_build_object('id', new.id));
  end if;
  if tg_op = 'UPDATE' and new.quick <> old.quick then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'quick'));
  end if;
  return new;
end $$;

-- Platos: service_id inmutable; mismo bloqueo; ni servicio ni receta borrados; y en un retiro, ninguna receta rápida por
-- completar (al insertar, al restaurar o al cambiar de receta).
create or replace function food.guard_menu_item()
returns trigger language plpgsql as $$
declare v_service food.menu_services; v_menu food.menus;
begin
  if tg_op = 'UPDATE' and new.service_id <> old.service_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'service_id'));
  end if;
  select * into v_service from food.menu_services where id = new.service_id;
  if v_service.id is null then return new; end if;
  select * into v_menu from food.menus where id = v_service.menu_id;
  if v_menu.status in ('validado','cerrado') then
    perform core.fail('MENU_LOCKED', 422, jsonb_build_object('menu_id', v_menu.id, 'status', v_menu.status));
  end if;
  if new.deleted_at is null then
    if (tg_op = 'INSERT' or old.deleted_at is not null) and v_service.deleted_at is not null then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menu_services', 'id', v_service.id));
    end if;
    if (tg_op = 'INSERT' or old.deleted_at is not null or new.recipe_id <> old.recipe_id) then
      if exists (select 1 from food.recipes r where r.id = new.recipe_id and r.deleted_at is not null) then
        perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'recipes', 'id', new.recipe_id));
      end if;
      if v_menu.kind = 'retiro' and food.recipe_quick_pending(new.recipe_id) then
        perform core.fail('QUICK_RECIPE_IN_RETREAT', 422, jsonb_build_object('recipe_id', new.recipe_id, 'menu_id', v_menu.id));
      end if;
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Registro en el núcleo (columnas escribibles nuevas: kind, house_servings y quick).
-- ---------------------------------------------------------------------------
select core.register_table('food', 'food', 'menus', array[
  'kind','event_id','source_event_revision','source_event_snapshot','status','validated_at','validated_by','validated_warnings',
  'preparation_generated_at','preparation_source_revisions','notes','closing_notes','organizer_shared','house_servings']);
select core.register_table('food', 'food', 'recipes', array[
  'name','public_name','public_description','category','base_servings','method','method_steps','conservation','freezable','regeneration',
  'service_notes','prep_minutes','status','diet_tags','allergens','allergens_checked','photo_file_id','photo_thumb_file_id','quick']);
