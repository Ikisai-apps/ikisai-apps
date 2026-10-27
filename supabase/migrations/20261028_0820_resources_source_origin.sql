-- Ikisai Recursos · quién pone el origen de los movimientos (FO4 de la auditoría del 27-10; decisión de Core: opción 3, con
-- `core.batch_origin()` del núcleo, 0118). Diseño en MUELA/equipo/feedback/guests/RECURSOS_ORIGEN.md.
-- - `resources.movements` y `resources.movement_costs`, antes de insertar dentro de un lote:
--   - lote del navegador: `source_app` = la app del lote (`core.app`); en un lote de la propia Recursos, ninguno. Lo que
--     mande el cliente no cuenta;
--   - lote de servidor (Finance, Tasks, el worker de Food, sistema o migración): el `source_app` declarado, si es una app
--     conocida (`core.apps`); si no, `INVALID_FIELDS`.
--   Fuera de un lote (SQL directo) no cambia nada. Al editar, `source_app` no cambia.
-- - `resources.consume`: del navegador, el origen es la app del lote (también al comparar con `once`); de servidor, el
--   declarado.
-- - `resources.reconcile_entries`: solo desde servidor (`FORBIDDEN` del navegador).
-- Toca solo el schema resources.

create or replace function resources.guard_source_app() returns trigger language plpgsql as $$
declare v_app text := nullif(current_setting('core.app', true), '');
begin
  if tg_op = 'UPDATE' then new.source_app := old.source_app; return new; end if;
  if not core.in_batch() then return new; end if;
  if core.batch_origin() = 'browser' then
    new.source_app := nullif(v_app, 'resources');
  elsif new.source_app is not null and not exists (select 1 from core.apps x where x.id = new.source_app) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', tg_table_schema || '.' || tg_table_name, 'field', 'source_app', 'reason', 'unknown app'));
  end if;
  return new;
end $$;

drop trigger if exists movements_source_app on resources.movements;
create trigger movements_source_app before insert or update of source_app on resources.movements
  for each row execute function resources.guard_source_app();
drop trigger if exists movement_costs_source_app on resources.movement_costs;
create trigger movement_costs_source_app before insert or update of source_app on resources.movement_costs
  for each row execute function resources.guard_source_app();

create or replace function resources.consume(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_item resources.items; v_left numeric; v_take numeric; v_kind text := a->>'kind'; v_spaces uuid[]; v_fallback uuid;
  v_row record; v_out jsonb := '[]'::jsonb; v_id uuid;
  -- El origen (FO4, 0118): del navegador, la app del lote (en Recursos, ninguno); de un servidor, el que declare.
  v_src text := case when core.batch_origin() = 'browser' then nullif(nullif(p->>'app', ''), 'resources') else a->>'source_app' end;
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
  -- `once: true` (P17 de Food): si ya hay consumos de este artículo con el mismo origen, no hace nada. Cierra el doble
  -- descuento de un dispositivo sin red que sincroniza después del worker.
  if coalesce((a->>'once')::boolean, false) and a->>'source_ref' is not null
     and exists (select 1 from resources.movements m where m.item_id = v_item.id and m.kind = v_kind and m.deleted_at is null
                  and m.source_app is not distinct from v_src and m.source_ref = a->>'source_ref') then
    return jsonb_build_object('itemId', v_item.id, 'movements', '[]'::jsonb, 'skipped', 'already_consumed');
  end if;

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
        'kind', v_kind, 'source_app', v_src, 'source_ref', a->>'source_ref', 'note', a->>'note', 'at', a->>'at'))));
    v_out := v_out || jsonb_build_object('id', v_id, 'spaceId', v_row.space_id, 'lotId', v_row.lot_id, 'quantity', -v_take);
    v_left := v_left - v_take;
  end loop;

  if v_left > 0 then
    if v_fallback is null then perform core.fail('INVALID_SPACE', 422, jsonb_build_object('reason', 'no stock and no space to record the rest', 'missing', v_left)); end if;
    v_id := gen_random_uuid();
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.movements', 'id', v_id,
      'fields', jsonb_strip_nulls(jsonb_build_object('item_id', v_item.id, 'space_id', v_fallback, 'quantity', -v_left,
        'kind', v_kind, 'source_app', v_src, 'source_ref', a->>'source_ref', 'note', a->>'note', 'at', a->>'at'))));
    v_out := v_out || jsonb_build_object('id', v_id, 'spaceId', v_fallback, 'lotId', null, 'quantity', -v_left, 'shortfall', true);
  end if;
  return jsonb_build_object('itemId', v_item.id, 'movements', v_out);
end $$;

create or replace function resources.reconcile_entries(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint; a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_source text := a->>'source_app'; v_row record; v_diff numeric; v_out jsonb := '[]'::jsonb; v_id uuid; v_last record;
begin
  -- Solo los servidores (Finance y Tasks) cuadran entradas: el origen no lo pone el navegador (FO4, 0118).
  if core.batch_origin() = 'browser' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'reconcile_entries is server only')); end if;
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

revoke all on function resources.guard_source_app() from public, anon, authenticated;
