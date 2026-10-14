-- Food · R5c: consumo al acabar el servicio (coordinacion/ampliacion/RECURSOS.md §6 «Food»; decisión del usuario del
-- 14-10-2026; docs/food/API.md §2.8). Toca solo el schema food.
--
-- Lo que se gasta lo descuenta la app en Recursos con `resources.consume` (gasta primero lo que caduca antes), con
-- `source_ref = 'menu_item:<id>'`. Aquí queda, por plato, que el consumo está hecho:
-- - `confirmado`: se descontó lo que se cocinó (a mano con «Confirmar consumo», o solo a las 24 h: `automatic`);
-- - `omitido`: el plato no se hizo y no se descuenta nada.
-- Es una tabla aparte y no un campo del plato para que un menú validado o cerrado (los platos no se tocan) pueda
-- confirmar su consumo. Un plato, como mucho, un consumo vivo; corregirlo después es un ajuste en Recursos.

create table food.consumptions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  menu_item_id uuid not null references food.menu_items(id) on delete cascade,
  status text not null check (status in ('confirmado', 'omitido')),
  automatic boolean not null default false,
  notes text check (notes is null or length(notes) <= 500)
);
create unique index consumptions_item_key on food.consumptions (menu_item_id) where deleted_at is null;

-- El plato existe y está vivo, y no cambia.
create or replace function food.guard_consumption()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.menu_item_id <> old.menu_item_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'menu_item_id'));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and not exists (select 1 from food.menu_items i where i.id = new.menu_item_id and i.deleted_at is null) then
    perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menu_items', 'id', new.menu_item_id));
  end if;
  return new;
end $$;
create trigger food_guard_consumption before insert or update on food.consumptions
  for each row execute function food.guard_consumption();

select core.register_table('food', 'food', 'consumptions', array['menu_item_id', 'status', 'automatic', 'notes']);
