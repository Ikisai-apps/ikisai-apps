-- Ikisai Recursos · apoyo a R4 (Finance), peticiones del 14-10-2026 (coordinacion/invoices/R4_PREPARACION.md §5).
-- Toca solo el schema resources.
--   1. `resources.reconcile_entries`: deja las entradas de una app de origen (p. ej. las líneas validadas de Finance) en la
--      cantidad que deben tener, de forma idempotente por `source_ref` y artículo: crea la diferencia (positiva o negativa).
--      Finance la llama en un lote de Recursos tras validar, al volver a revisión, al anular o con una rectificativa, y puede
--      repetirla cuando quiera para cuadrar: si ya cuadra, no crea nada.
--   2. Una `entrada_factura` negativa (el contrario) solo la crea ese procedimiento, con su coste; `item_costs` la cuenta.

create or replace function resources.check_inventory(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_change record;
  v_item resources.items;
  v_row record;
  v_closing text := current_setting('resources.closing_count', true);
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('item_kinds', 'items', 'item_units', 'lots', 'movements', 'counts', 'count_lines', 'spaces')) then
    return;
  end if;

  for v_change in select c.table_name, c.op, c.row_id, c.before, c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' order by c.seq loop
    -- Movimientos: solo se añaden.
    if v_change.table_name = 'movements' then
      if v_change.op <> 'insert' then
        perform core.fail('MOVEMENT_IMMUTABLE', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'movements are only added; correct with an opposite one'));
      end if;
      if (v_change.after->>'kind') = 'ajuste_recuento' and coalesce(v_closing, '') is distinct from (v_change.after->>'count_id') then
        perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'count adjustments come from close_count'));
      end if;
    -- Recuentos: se cierran solo con close_count; un cerrado no cambia.
    elsif v_change.table_name = 'counts' and v_change.op <> 'insert' and coalesce(v_closing, '') is distinct from v_change.row_id::text then
      if (v_change.before->>'status') = 'cerrado' then perform core.fail('COUNT_CLOSED', 409, jsonb_build_object('countId', v_change.row_id)); end if;
    elsif v_change.table_name = 'count_lines' then
      if (select status from resources.counts where id = coalesce((v_change.after->>'count_id')::uuid, (v_change.before->>'count_id')::uuid)) is distinct from 'abierto' then
        perform core.fail('COUNT_CLOSED', 409, jsonb_build_object('countId', coalesce(v_change.after->>'count_id', v_change.before->>'count_id')));
      end if;
    -- Un artículo con movimientos no se borra: se archiva.
    elsif v_change.table_name = 'items' and v_change.op = 'delete'
          and exists (select 1 from resources.movements m where m.item_id = v_change.row_id and m.deleted_at is null) then
      perform core.fail('ITEM_IN_USE', 409, jsonb_build_object('itemId', v_change.row_id));
    -- Un tipo de artículo en uso no se borra ni se archiva.
    elsif v_change.table_name = 'item_kinds' and (v_change.op = 'delete' or (v_change.after->>'active') = 'false')
          and exists (select 1 from resources.items i where i.kind = coalesce(v_change.before->>'kind', v_change.after->>'kind') and i.deleted_at is null) then
      perform core.fail('ITEM_KIND_IN_USE', 409, jsonb_build_object('kind', coalesce(v_change.before->>'kind', v_change.after->>'kind')));
    -- Un espacio con stock no se borra ni se archiva (RECURSOS.md §2.4): primero se traslada.
    elsif v_change.table_name = 'spaces' and (v_change.op = 'delete' or ((v_change.before->>'active') = 'true' and (v_change.after->>'active') = 'false'))
          and exists (select 1 from resources.stock_levels s where s.space_id = v_change.row_id) then
      perform core.fail('SPACE_HAS_STOCK', 409, jsonb_build_object('spaceId', v_change.row_id));
    end if;
  end loop;

  -- Artículos tocados: tipo existente y sitio habitual vivo.
  for v_item in select i.* from resources.items i
                 where i.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'items')
                   and i.deleted_at is null loop
    if not exists (select 1 from resources.item_kinds k where k.kind = v_item.kind and k.deleted_at is null and k.active) then
      perform core.fail('INVALID_ITEM_KIND', 422, jsonb_build_object('kind', v_item.kind));
    end if;
    if v_item.default_space_id is not null and not exists (select 1 from resources.spaces s where s.id = v_item.default_space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_item.default_space_id));
    end if;
  end loop;

  -- Unidades: distintas de la base.
  for v_row in select u.*, i.base_unit from resources.item_units u join resources.items i on i.id = u.item_id
                where u.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'item_units')
                  and u.deleted_at is null loop
    if lower(btrim(v_row.unit)) = lower(btrim(v_row.base_unit)) then
      perform core.fail('INVALID_UNIT', 422, jsonb_build_object('unit', v_row.unit, 'reason', 'same as base unit'));
    end if;
  end loop;

  -- Movimientos y líneas de recuento nuevos: artículo vivo, sitio vivo, lote del artículo, signo según el tipo.
  for v_row in select m.*, i.tracks_lots, i.deleted_at as item_deleted from resources.movements m join resources.items i on i.id = m.item_id
                where m.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'movements') loop
    if v_row.item_deleted is not null then perform core.fail('INVALID_ITEM', 422, jsonb_build_object('itemId', v_row.item_id)); end if;
    if not exists (select 1 from resources.spaces s where s.id = v_row.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_row.space_id));
    end if;
    if v_row.lot_id is not null and not exists (select 1 from resources.lots l where l.id = v_row.lot_id and l.item_id = v_row.item_id and l.deleted_at is null) then
      perform core.fail('INVALID_LOT', 422, jsonb_build_object('lotId', v_row.lot_id));
    end if;
    -- Una entrada_factura negativa solo la crea resources.reconcile_entries (rectificativa, anulación, vuelta a revisión).
    if (v_row.kind = 'entrada_manual' and v_row.quantity < 0)
       or (v_row.kind = 'entrada_factura' and v_row.quantity < 0
           and (coalesce(current_setting('resources.reconciling', true), '') <> '1' or v_row.source_ref is null))
       or v_row.kind in ('consumo_servicio', 'consumo_tarea', 'salida_manual') and v_row.quantity > 0 then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'sign does not match kind', 'kind', v_row.kind));
    end if;
    if v_row.kind = 'salida_manual' and v_row.reason is null then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'manual exits need a reason'));
    end if;
    if v_row.kind = 'traslado' and v_row.transfer_id is null then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'transfers need transfer_id'));
    end if;
    if v_row.unit_cost is not null and v_row.kind not in ('entrada_factura', 'entrada_manual') then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'only entries carry a cost'));
    end if;
  end loop;
  -- Cada traslado del lote: mismo artículo y lote, suma cero, de un sitio a otro.
  for v_row in select m.transfer_id, count(*) as n, sum(m.quantity) as total, count(distinct m.item_id) as items,
                      count(distinct coalesce(m.lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) as lots,
                      count(distinct m.space_id) as spaces, bool_and(m.kind = 'traslado') as all_transfers
                 from resources.movements m
                where m.transfer_id in (select (c.after->>'transfer_id')::uuid from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                         and c.schema_name = 'resources' and c.table_name = 'movements' and c.after->>'transfer_id' is not null)
                group by m.transfer_id loop
    if v_row.n <> 2 or v_row.total <> 0 or v_row.items <> 1 or v_row.lots <> 1 or v_row.spaces <> 2 or not v_row.all_transfers then
      perform core.fail('INVALID_TRANSFER', 422, jsonb_build_object('transferId', v_row.transfer_id));
    end if;
  end loop;

  for v_row in select l.* from resources.count_lines l
                where l.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'count_lines')
                  and l.deleted_at is null loop
    if not exists (select 1 from resources.spaces s where s.id = v_row.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_row.space_id));
    end if;
    if v_row.lot_id is not null and not exists (select 1 from resources.lots l where l.id = v_row.lot_id and l.item_id = v_row.item_id) then
      perform core.fail('INVALID_LOT', 422, jsonb_build_object('lotId', v_row.lot_id));
    end if;
  end loop;
end $$;

create or replace view resources.item_costs as
select m.item_id,
       round(sum(m.quantity * coalesce(m.unit_cost, c.unit_cost)) / nullif(sum(m.quantity), 0), 6) as average_cost,
       sum(m.quantity) as costed_quantity
  from resources.movements m
  left join resources.movement_costs c on c.movement_id = m.id and c.deleted_at is null
 where m.deleted_at is null and coalesce(m.unit_cost, c.unit_cost) is not null
   and ((m.quantity > 0 and m.kind in ('entrada_factura', 'entrada_manual')) or (m.quantity < 0 and m.kind = 'entrada_factura'))
 group by m.item_id;

-- args: {source_app, entries: [{source_ref, item_id, space_id, quantity (neta deseada, ≥ 0, unidad base), unit_cost?, at?}],
--         refs?: [source_ref que también se cuadran; sin entrada en `entries` = 0]}.
-- Por cada (source_ref, artículo): diferencia = deseada − suma actual de sus `entrada_factura`. Si un ref pasa a otro artículo,
-- el anterior queda en 0. El contrario usa el coste y el sitio de lo que deshace. Devuelve los movimientos creados.
create or replace function resources.reconcile_entries(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_source text := a->>'source_app'; v_row record; v_diff numeric; v_out jsonb := '[]'::jsonb; v_id uuid; v_last record;
begin
  if v_source is null or v_source !~ '^[a-z][a-z0-9_]{0,39}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'source_app')); end if;
  if jsonb_typeof(coalesce(a->'entries', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(a->'entries', '[]'::jsonb)) > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'entries'));
  end if;
  perform set_config('resources.reconciling', '1', true);
  for v_row in
    with wanted as (
      select e->>'source_ref' as ref, (e->>'item_id')::uuid as item_id, (e->>'space_id')::uuid as space_id,
             (e->>'quantity')::numeric as qty, (e->>'unit_cost')::numeric as unit_cost, nullif(e->>'at', '')::timestamptz as at
        from jsonb_array_elements(coalesce(a->'entries', '[]'::jsonb)) e),
    refs as (
      select ref from wanted
      union select value from jsonb_array_elements_text(coalesce(a->'refs', '[]'::jsonb))),
    current as (
      select m.source_ref as ref, m.item_id, sum(m.quantity) as qty
        from resources.movements m
       where m.source_app = v_source and m.kind = 'entrada_factura' and m.deleted_at is null and m.source_ref in (select ref from refs)
       group by 1, 2)
    select coalesce(w.ref, c.ref) as ref, coalesce(w.item_id, c.item_id) as item_id, w.space_id, coalesce(w.qty, 0) as wanted,
           coalesce(c.qty, 0) as have, w.unit_cost, w.at
      from wanted w full join current c on c.ref = w.ref and c.item_id = w.item_id
     order by 1, 2
  loop
    if v_row.ref is null or v_row.item_id is null or v_row.wanted < 0 then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'entries', 'sourceRef', v_row.ref));
    end if;
    v_diff := v_row.wanted - v_row.have;
    continue when v_diff = 0;
    select m.space_id, m.unit_cost into v_last from resources.movements m
     where m.source_app = v_source and m.source_ref = v_row.ref and m.item_id = v_row.item_id and m.kind = 'entrada_factura' and m.deleted_at is null
     order by m.at desc, m.created_at desc limit 1;
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.movements', 'id', v_id,
      'fields', jsonb_strip_nulls(jsonb_build_object('item_id', v_row.item_id, 'space_id', coalesce(v_row.space_id, v_last.space_id),
        'quantity', v_diff, 'kind', 'entrada_factura', 'unit_cost', coalesce(v_row.unit_cost, v_last.unit_cost),
        'source_app', v_source, 'source_ref', v_row.ref, 'at', v_row.at))));
    v_out := v_out || jsonb_build_object('id', v_id, 'sourceRef', v_row.ref, 'itemId', v_row.item_id, 'quantity', v_diff);
  end loop;
  return jsonb_build_object('movements', v_out);
end $$;
select core.allow_procedure('resources', 'resources.reconcile_entries');
