-- Food · la lista de la compra única por evento (encargo de Core del 28-10-2026; diseño en MUELA/equipo/feedback/food/
-- LISTA_COMPRA.md; docs/food/API.md §2.15). Toca solo el schema food; lee resources.
--
-- Suma las listas ya generadas de los menús del evento (el menú cerrado y sus cartas): no recalcula nada, cada lista ya
-- descuenta lo que hay en casa, redondea al envase y respeta lo puesto a mano. Una fila por ingrediente, unidad y tienda,
-- con el pasillo (la categoría del artículo). Lo pedido a Tasks (`tasks.request_purchase`) queda en las líneas.

-- ---------------------------------------------------------------------------
-- 1. Lo pedido a Tasks, en cada línea de la lista de un menú
-- ---------------------------------------------------------------------------
-- `purchase_ref`: la referencia de la petición de compra en Tasks; `purchase_project_id`: su proyecto; `purchase_requested`:
-- lo que se pidió de esa línea. Las escribe solo la Edge de Food al pedir (reservadas para el cliente). Con referencia, la
-- Despensa no apunta la compra desde Food: el stock entra por Recursos al recibirla en Tasks.
alter table food.shopping_list_items add column purchase_ref text check (purchase_ref is null or length(purchase_ref) between 1 and 150);
alter table food.shopping_list_items add column purchase_project_id uuid;
alter table food.shopping_list_items add column purchase_requested numeric(12,3) check (purchase_requested is null or purchase_requested >= 0);
select core.register_table('food', 'food', 'shopping_list_items', array[
  'shopping_list_id','ingredient_id','required_quantity','unit','stock_quantity','purchase_quantity','supplier','status','manual_override','manual','notes',
  'min_quantity','restock','purchase_ref','purchase_project_id','purchase_requested']);

-- ---------------------------------------------------------------------------
-- 2. La lista del evento
-- ---------------------------------------------------------------------------
-- args = { event_id }. Devuelve { event_id, menus: [{menu_id, kind, name, list_id, generated_at, lines}],
--   rows: [{key, ingredient_id, item_id, name, unit, supplier, aisle, pending, bought, requested, purchase_ref,
--           purchase_project_id, status, menus, lines: [{id, revision, menu_id, quantity, status, purchase_ref}]}] }.
-- `status` de la fila: 'pendiente' (algo sin comprar ni pedir), 'pedida' (lo pendiente, pedido a Tasks), 'comprado'
-- (nada pendiente). Los menús del evento: los suyos (`event_id`) y los de sus ofertas.
create or replace function food.event_shopping(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid; v_out jsonb;
begin
  begin v_event := (p->'args'->>'event_id')::uuid; exception when others then v_event := null; end;
  if v_event is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'event_id')); end if;
  with menus as (
    select m.id, m.kind, coalesce(nullif(btrim(m.name), ''), case m.kind when 'carta' then 'Carta' else 'Menú del evento' end) as name
      from food.menus m
     where m.deleted_at is null and m.kind in ('retiro', 'carta')
       and (m.event_id = v_event or m.id in (select o.menu_id from food.event_offers o where o.event_id = v_event and o.deleted_at is null))),
  lists as (
    select mn.id as menu_id, mn.kind, mn.name, l.id as list_id, l.generated_at
      from menus mn left join food.shopping_lists l on l.menu_id = mn.id and l.deleted_at is null),
  items as (
    select ls.menu_id, ls.name as menu_name, i.*, g.name as ingredient_name, g.item_id, it.category,
           coalesce(nullif(btrim(i.supplier), ''), '') as shop
      from lists ls
      join food.shopping_list_items i on i.shopping_list_id = ls.list_id and i.deleted_at is null
      join food.ingredients g on g.id = i.ingredient_id
      left join resources.items it on it.id = g.item_id and it.deleted_at is null
     -- Lo que no hay que comprar (todo en casa) no sale como fila.
     where not (i.status = 'pendiente' and i.purchase_quantity = 0)),
  grp as (
    select i.ingredient_id || ':' || i.unit || ':' || left(md5(lower(i.shop)), 8) as key,
           i.ingredient_id, min(i.item_id::text)::uuid as item_id, min(i.ingredient_name) as name, i.unit,
           nullif(i.shop, '') as supplier, min(i.category) as aisle,
           coalesce(sum(i.purchase_quantity) filter (where i.status = 'pendiente'), 0) as pending,
           coalesce(sum(i.purchase_quantity) filter (where i.status <> 'pendiente'), 0) as bought,
           coalesce(sum(i.purchase_requested) filter (where i.status = 'pendiente' and i.purchase_ref is not null), 0) as requested,
           bool_or(i.status = 'pendiente' and i.purchase_ref is null and i.purchase_quantity > 0) as unrequested,
           max(i.purchase_ref) as purchase_ref, max(i.purchase_project_id::text)::uuid as purchase_project_id,
           array_agg(distinct i.menu_name order by i.menu_name) as menus,
           jsonb_agg(jsonb_build_object('id', i.id, 'revision', i.revision, 'menu_id', i.menu_id, 'quantity', i.purchase_quantity,
             'status', i.status, 'purchase_ref', i.purchase_ref) order by i.menu_name, i.id) as lines
      from items i
     group by i.ingredient_id, i.unit, i.shop)
  select jsonb_build_object(
    'event_id', v_event,
    'menus', coalesce((select jsonb_agg(jsonb_build_object('menu_id', ls.menu_id, 'kind', ls.kind, 'name', ls.name, 'list_id', ls.list_id,
        'generated_at', ls.generated_at,
        'lines', (select count(*) from food.shopping_list_items i where i.shopping_list_id = ls.list_id and i.deleted_at is null))
        order by ls.kind desc, ls.name) from lists ls), '[]'::jsonb),
    'rows', coalesce((select jsonb_agg(jsonb_build_object('key', r.key, 'ingredient_id', r.ingredient_id, 'item_id', r.item_id, 'name', r.name,
        'unit', r.unit, 'supplier', r.supplier, 'aisle', r.aisle, 'pending', r.pending, 'bought', r.bought, 'requested', r.requested,
        'purchase_ref', r.purchase_ref, 'purchase_project_id', r.purchase_project_id,
        'status', case when r.pending = 0 then 'comprado' when r.unrequested then 'pendiente' else 'pedida' end,
        'menus', to_jsonb(r.menus), 'lines', r.lines)
        order by r.supplier nulls last, r.aisle nulls last, r.name) from grp r), '[]'::jsonb))
  into v_out;
  return v_out;
end $$;
select core.allow_read('food', 'food.event_shopping', 'function', '{reader,editor,owner}');
