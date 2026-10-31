-- Flow 0961: dar de baja un pedido de la barra sobre el motor (0957) fallaba con INVALID_FIELDS (deleted_at en flow.units):
-- `flow.order_unit_sync` quitaba la tarjeta del pedido con un update de `deleted_at`, que el núcleo no admite como campo.
-- Ahora usa la op `delete` (con su revisión). Afectaba a «Cancelar pedido» en la Barra y al borrón flow-31 (31-10).
-- Lo demás de la función, como en 0957.

create or replace function flow.order_unit_sync(p_order uuid) returns void language plpgsql as $$
declare p jsonb := flow.batch_ctx(); o flow.orders; u flow.units; v_lane text; v_status text; v_fields jsonb; v_prev text;
begin
  if p is null or p_order is null then return; end if;
  select * into o from flow.orders where id = p_order;
  if o.id is null or not flow.engine_barra(o.project_id) then return; end if;
  select * into u from flow.units where source_ref = 'flow.orders:' || o.id and kind = 'order' and deleted_at is null limit 1;
  if o.deleted_at is not null then
    v_lane := null;
  elsif o.status = 'open' then v_lane := 'caja'; v_status := 'pending';
  elsif o.status = 'delivered' then v_lane := 'servicio'; v_status := 'done';
  elsif exists (select 1 from flow.units x where x.order_id = o.id and x.kind = 'prep' and x.deleted_at is null and x.status in ('pending', 'in_progress')) then
    v_lane := 'cocina'; v_status := 'in_progress';
  else v_lane := 'servicio'; v_status := 'in_progress';
  end if;
  v_prev := current_setting('flow.proc', true);
  perform set_config('flow.proc', 'on', true);
  if u.id is null and v_lane is not null then
    perform flow.row_op(p, jsonb_build_object('op', 'insert', 'table', 'flow.units', 'id', gen_random_uuid(), 'fields', jsonb_build_object(
      'project_id', o.project_id, 'column_key', 'order', 'kind', 'order', 'class', 'operation', 'source_ref', 'flow.orders:' || o.id, 'pay_seq', o.pay_seq,
      'label', left('Pedido' || coalesce(' ' || o.pay_seq, ''), 120), 'lane_key', v_lane, 'status', v_status,
      'done_at', case when v_status = 'done' then coalesce(o.delivered_at, now()) end)));
  elsif u.id is not null and v_lane is null then
    perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision));
  elsif u.id is not null and (u.lane_key is distinct from v_lane or u.status is distinct from v_status or u.pay_seq is distinct from o.pay_seq) then
    v_fields := jsonb_build_object('lane_key', v_lane, 'status', v_status, 'pay_seq', o.pay_seq,
      'label', left('Pedido' || coalesce(' ' || o.pay_seq, ''), 120),
      'done_at', case when v_status = 'done' then coalesce(u.done_at, o.delivered_at, now()) end);
    perform flow.row_op(p, jsonb_build_object('op', 'update', 'table', 'flow.units', 'id', u.id, 'expectedRevision', u.revision, 'fields', v_fields));
  end if;
  perform set_config('flow.proc', coalesce(v_prev, ''), true);
end $$;
