-- Ikisai Recursos · `resources.consume` con `once: true` (P17 de Food, 18-10-2026). Toca solo el schema resources. Lo demás, igual que en 0803.
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
  -- `once: true` (P17 de Food): si ya hay consumos de este artículo con el mismo origen, no hace nada. Cierra el doble
  -- descuento de un dispositivo sin red que sincroniza después del worker.
  if coalesce((a->>'once')::boolean, false) and a->>'source_ref' is not null
     and exists (select 1 from resources.movements m where m.item_id = v_item.id and m.kind = v_kind and m.deleted_at is null
                  and m.source_app is not distinct from a->>'source_app' and m.source_ref = a->>'source_ref') then
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
