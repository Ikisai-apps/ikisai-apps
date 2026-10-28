-- Ikisai Recursos · el oficio de un artículo (R2 de Tasks, rescatado por Core el 27-10-2026): la categoría pasa a poder ser
-- un oficio de Central, como las tareas de Tasks (0326), en vez de solo texto libre.
-- - `resources.items.trade_id` (opcional, sin clave foránea: Recursos no lee las tablas de Central). Lo valida el hook con
--   central.trade_alive (1508), al crear o cambiar el oficio: tiene que ser un oficio vivo y activo.
-- - `category` (texto) se conserva tal cual para lo que ya hay y para quien no use oficios.
-- - Tasks y Food leen `trade_id` en `resources.items`, como el resto del artículo.
-- Las funciones que llaman a central.trade_alive son plpgsql: se resuelve al ejecutar. Toca solo el schema resources.

alter table resources.items add column trade_id uuid;
create index items_trade_idx on resources.items (trade_id) where trade_id is not null and deleted_at is null;
select core.register_table('resources', 'resources', 'items',
  array['name', 'kind', 'category', 'base_unit', 'min_quantity', 'reorder_quantity', 'default_space_id', 'default_supplier_id',
        'tracks_lots', 'tracks_expiry', 'attributes', 'active', 'notes', 'source_refs', 'trade_id']);

create or replace function resources.check_item_trades(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_change record;
begin
  for v_change in select c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'items'
                     and c.op in ('insert', 'update') and c.after->>'trade_id' is not null
                     and (c.op = 'insert' or c.before->>'trade_id' is distinct from c.after->>'trade_id') loop
    if not central.trade_alive((v_change.after->>'trade_id')::uuid) then
      perform core.fail('INVALID_TRADE', 422, jsonb_build_object('table', 'resources.items', 'field', 'trade_id', 'tradeId', v_change.after->>'trade_id'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_item_trades');

revoke all on function resources.check_item_trades(jsonb) from public, anon, authenticated;
grant execute on function resources.check_item_trades(jsonb) to service_role;
