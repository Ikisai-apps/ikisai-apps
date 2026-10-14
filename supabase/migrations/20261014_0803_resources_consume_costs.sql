-- Ikisai Recursos · apoyo a R4 (Finance) y R5 (Food), peticiones de Food del 14-10-2026 (coordinacion/food/SALIDA.md).
-- Toca solo el schema resources.
--   1. `resources.consume`: consumo que gasta primero lo que caduca antes (RECURSOS.md §5.2), en los sitios que se pidan.
--   2. `resources.movement_costs`: el coste llega después a una entrada que entró sin él (decisión del usuario del 14-10:
--      «comprado» en la lista de Food entra al stock en ese momento y la factura de Finance añade el coste, sin contarlo dos veces).
--   3. `attributes.status` de un artículo (máquinas y herramientas): operativo, limitado, averiado o fuera_de_servicio.

-- ---------------------------------------------------------------------------
-- 2. Coste añadido después (solo se añade; uno por entrada)
-- ---------------------------------------------------------------------------
create table resources.movement_costs (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  movement_id uuid not null references resources.movements(id),
  unit_cost numeric not null check (unit_cost >= 0),
  source_app text check (source_app is null or source_app ~ '^[a-z][a-z0-9_]{0,39}$'),
  source_ref text check (source_ref is null or length(source_ref) <= 200)
);
create unique index movement_costs_movement_idx on resources.movement_costs (movement_id) where deleted_at is null;
select core.register_table('resources', 'resources', 'movement_costs', array['movement_id', 'unit_cost', 'source_app', 'source_ref'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- Coste medio: el de la entrada o, si entró sin él, el que se le añadió después.
create or replace view resources.item_costs as
select m.item_id,
       round(sum(m.quantity * coalesce(m.unit_cost, c.unit_cost)) / nullif(sum(m.quantity), 0), 6) as average_cost,
       sum(m.quantity) as costed_quantity
  from resources.movements m
  left join resources.movement_costs c on c.movement_id = m.id and c.deleted_at is null
 where m.deleted_at is null and m.quantity > 0 and m.kind in ('entrada_factura', 'entrada_manual')
   and coalesce(m.unit_cost, c.unit_cost) is not null
 group by m.item_id;

-- ---------------------------------------------------------------------------
-- 1. Consumo por lotes: primero lo que caduca antes, después lo más antiguo
-- ---------------------------------------------------------------------------
-- args: {item_id, quantity (> 0, en la unidad base), kind ('consumo_servicio' | 'consumo_tarea'), space_ids? (sitios donde
-- buscar; sin ellos, todos), default_space_id? (dónde apuntar lo que falte), source_app, source_ref, note?, at?}.
-- Lo que no alcanza el stock se apunta en `default_space_id` (o en el primer sitio pedido, o en el habitual del artículo)
-- sin lote: el stock queda en negativo y lo arregla un recuento. Devuelve los movimientos creados.
create or replace function resources.consume(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_item resources.items; v_left numeric; v_take numeric; v_kind text := a->>'kind'; v_spaces uuid[]; v_fallback uuid;
  v_row record; v_out jsonb := '[]'::jsonb; v_id uuid;
begin
  begin v_item.id := (a->>'item_id')::uuid; v_left := (a->>'quantity')::numeric; exception when others then v_item.id := null; end;
  select * into v_item from resources.items where id = v_item.id and deleted_at is null;
  if v_item.id is null then perform core.fail('INVALID_ITEM', 422, jsonb_build_object('argument', 'item_id')); end if;
  if v_left is null or v_left <= 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'quantity')); end if;
  if v_kind is null or v_kind not in ('consumo_servicio', 'consumo_tarea') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'kind')); end if;
  if jsonb_typeof(a->'space_ids') = 'array' then
    select array_agg(value::uuid) into v_spaces from jsonb_array_elements_text(a->'space_ids');
  end if;
  v_fallback := coalesce(nullif(a->>'default_space_id', '')::uuid, v_spaces[1], v_item.default_space_id);

  for v_row in
    select s.space_id, s.lot_id, s.quantity
      from resources.stock_levels s left join resources.lots l on l.id = s.lot_id
     where s.item_id = v_item.id and s.quantity > 0 and (v_spaces is null or s.space_id = any(v_spaces))
     order by l.expires_on nulls last, s.last_at, s.space_id
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_row.quantity);
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.movements', 'id', v_id,
      'fields', jsonb_strip_nulls(jsonb_build_object('item_id', v_item.id, 'space_id', v_row.space_id, 'lot_id', v_row.lot_id, 'quantity', -v_take,
        'kind', v_kind, 'source_app', a->>'source_app', 'source_ref', a->>'source_ref', 'note', a->>'note', 'at', a->>'at'))));
    v_out := v_out || jsonb_build_object('id', v_id, 'spaceId', v_row.space_id, 'lotId', v_row.lot_id, 'quantity', -v_take);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    if v_fallback is null then perform core.fail('INVALID_SPACE', 422, jsonb_build_object('reason', 'no stock and no space to record the rest', 'missing', v_left)); end if;
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.movements', 'id', v_id,
      'fields', jsonb_strip_nulls(jsonb_build_object('item_id', v_item.id, 'space_id', v_fallback, 'quantity', -v_left,
        'kind', v_kind, 'source_app', a->>'source_app', 'source_ref', a->>'source_ref', 'note', a->>'note', 'at', a->>'at'))));
    v_out := v_out || jsonb_build_object('id', v_id, 'spaceId', v_fallback, 'lotId', null, 'quantity', -v_left, 'shortfall', true);
  end if;
  return jsonb_build_object('itemId', v_item.id, 'movements', v_out);
end $$;
select core.allow_procedure('resources', 'resources.consume');

-- ---------------------------------------------------------------------------
-- Reglas nuevas, en un hook aparte (el de 0802 no cambia)
-- ---------------------------------------------------------------------------
create or replace function resources.check_inventory_costs(p jsonb)
returns void language plpgsql as $$
declare v_cursor bigint := (p->>'cursor')::bigint; v_change record; v_row record;
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('movement_costs', 'items')) then
    return;
  end if;
  for v_change in select c.table_name, c.op, c.row_id from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'movement_costs' loop
    if v_change.op <> 'insert' then
      perform core.fail('MOVEMENT_IMMUTABLE', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'costs are only added'));
    end if;
    select m.kind, m.unit_cost, m.quantity into v_row from resources.movement_costs c join resources.movements m on m.id = c.movement_id where c.id = v_change.row_id;
    if v_row.kind not in ('entrada_factura', 'entrada_manual') or v_row.quantity <= 0 or v_row.unit_cost is not null then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'a cost is added only to an entry without cost'));
    end if;
  end loop;
  for v_row in select i.id, i.attributes->>'status' as status from resources.items i
                where i.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'items')
                  and i.deleted_at is null and i.attributes ? 'status' loop
    if v_row.status is null or v_row.status not in ('operativo', 'limitado', 'averiado', 'fuera_de_servicio') then
      perform core.fail('INVALID_ITEM_ATTRIBUTE', 422, jsonb_build_object('itemId', v_row.id, 'key', 'status'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_inventory_costs');
