-- Ikisai Flow · recipientes en los puntos de existencias (VG 27-10; diseño aprobado por Core). Para la v2 (lo que tenga
-- puntos de existencias y no esté congelado); la v1 no cambia.
-- - Cada punto (mesa, nevera) puede decir «3 recipientes × 8 rodajas»: `containers` y `per_container`. La capacidad sale de
--   ahí (no se teclea aparte) y regenerar no la pisa. Lo pone el owner en Ingredientes (`set_buffer_containers`).
-- - Rendimiento de Food (#774): al generar se guardan `prep_unit`, `purchase_unit` y `yield` del ingrediente.
-- - Reposición: «Reponer mesa: 2 recipientes de Tomate (16 rodaja ≈ 2,0 unidad)»; «Comprar X» en unidades de compra
--   (ceil(necesario ÷ rendimiento)), y así se pide a Tasks. Sin rendimiento, como hasta ahora.

alter table flow.buffers add column containers integer check (containers is null or containers between 1 and 99);
alter table flow.buffers add column per_container numeric check (per_container is null or per_container > 0);
alter table flow.buffers add column prep_unit text check (prep_unit is null or length(prep_unit) between 1 and 30);
alter table flow.buffers add column purchase_unit text check (purchase_unit is null or length(purchase_unit) between 1 and 30);
alter table flow.buffers add column yield numeric check (yield is null or yield > 0);
select core.register_table('flow', 'flow', 'buffers', array['project_id','key','item_key','name','unit','location','capacity','level','threshold_pct','containers','per_container','prep_unit','purchase_unit','yield'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

-- Recipientes de un punto. args = { buffer_id, containers, per_container } (los dos null quitan los recipientes). Solo el owner.
create or replace function flow.set_buffer_containers(p jsonb) returns jsonb language plpgsql as $$
declare v_b flow.buffers; v_c int; v_per numeric; v_cap numeric;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'containers are for the owner')); end if;
  select * into v_b from flow.buffers where id = flow.arg_uuid(p, 'buffer_id') and deleted_at is null for update;
  if v_b.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.buffers')); end if;
  if exists (select 1 from flow.projects where id = v_b.project_id and frozen) then perform core.fail('FLOW_FROZEN', 409, jsonb_build_object('project_id', v_b.project_id)); end if;
  if v_b.location not in ('mesa','nevera') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'containers only for mesa and nevera')); end if;
  begin v_c := (p->'args'->>'containers')::int; v_per := (p->'args'->>'per_container')::numeric; exception when others then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'containers and per_container must be numbers'));
  end;
  if (v_c is null) <> (v_per is null) or (v_c is not null and (v_c < 1 or v_c > 99 or v_per <= 0)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'containers 1..99 and per_container > 0, or both null'));
  end if;
  v_cap := case when v_c is null then v_b.capacity else v_c * v_per end;
  perform flow.upd(p, 'flow.buffers', v_b.id, v_b.revision, jsonb_build_object('containers', v_c, 'per_container', v_per, 'capacity', v_cap,
    'level', least(v_b.level, v_cap)));
  perform flow.proc_end();
  return jsonb_build_object('buffer_id', v_b.id, 'capacity', v_cap);
end $$;
select core.allow_procedure('flow', 'flow.set_buffer_containers');

-- Generar (amplía la de la 0909): guarda el rendimiento de Food y respeta la capacidad de los puntos con recipientes.
alter function flow.generate_ingredient_tasks(jsonb) rename to generate_ingredient_tasks_fresh;
create or replace function flow.generate_ingredient_tasks(p jsonb) returns jsonb language plpgsql as $$
declare v_out jsonb; v_project uuid := flow.arg_uuid(p, 'project_id'); v_t jsonb; v_b flow.buffers;
begin
  v_out := flow.generate_ingredient_tasks_fresh(p);
  perform flow.proc_begin();
  for v_t in select * from jsonb_array_elements(coalesce(p->'args'->'totals', '[]'::jsonb)) loop
    for v_b in select * from flow.buffers where project_id = v_project and item_key = v_t->>'component_key' and deleted_at is null for update loop
      if (v_t ? 'yield') or (v_t ? 'purchase_unit') or v_b.containers is not null then
        perform flow.upd(p, 'flow.buffers', v_b.id, v_b.revision, jsonb_build_object(
          'prep_unit', coalesce(nullif(v_t->>'prep_unit', ''), v_b.prep_unit),
          'purchase_unit', coalesce(nullif(v_t->>'purchase_unit', ''), v_b.purchase_unit),
          'yield', coalesce(nullif(v_t->>'yield', '')::numeric, v_b.yield),
          'capacity', case when v_b.containers is not null then v_b.containers * v_b.per_container else v_b.capacity end));
      end if;
    end loop;
  end loop;
  perform flow.proc_end();
  return v_out;
end $$;

-- Reposición (sustituye a la de la 0909: lo mismo, más recipientes y unidades de compra).
create or replace function flow.propose_restock(p jsonb, p_buffers uuid[]) returns void language plpgsql as $$
declare v_b flow.buffers; v_from text; v_qty numeric; v_open flow.units; v_payload jsonb; v_label text; v_ref text; v_col text; v_moves jsonb; v_purchase boolean;
  v_cont int; v_buy numeric; v_eq text;
begin
  for v_b in select * from flow.buffers where id = any(p_buffers) and deleted_at is null and capacity > 0 loop
    if v_b.level >= v_b.capacity * v_b.threshold_pct / 100.0 then continue; end if;
    v_purchase := v_b.location = 'fresco';
    v_from := case v_b.location when 'mesa' then 'nevera' when 'nevera' then 'fresco' else null end;
    v_qty := v_b.capacity - greatest(v_b.level, 0);
    v_ref := 'restock:' || v_b.key || ':' || coalesce(v_from, 'compra');
    v_col := coalesce((select key from flow.columns where project_id = v_b.project_id and deleted_at is null and coalesce((config->>'proposal')::boolean, false) order by position limit 1), 'ingredients');
    v_moves := jsonb_build_array(jsonb_build_object('buffer', v_b.key, 'delta', v_qty));
    if v_from = 'nevera' then
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('buffer', v_b.item_key || ':nevera', 'delta', -v_qty));
    elsif v_from = 'fresco' and exists (select 1 from flow.buffers where project_id = v_b.project_id and key = v_b.item_key || ':fresco' and deleted_at is null) then
      v_moves := v_moves || jsonb_build_array(jsonb_build_object('buffer', v_b.item_key || ':fresco', 'delta', -v_qty));
    end if;
    v_payload := jsonb_build_object('item_key', v_b.item_key, 'name', v_b.name, 'unit', v_b.unit, 'qty', v_qty, 'to', v_b.location, 'from', v_from,
      'restock', v_ref, 'moves', v_moves) || case when v_purchase then jsonb_build_object('purchase', true) else '{}'::jsonb end;
    v_label := case when v_purchase then 'Comprar ' || v_b.name else 'Reponer ' || v_b.name || ' a ' || v_b.location || ' desde ' || v_from end;
    -- Recipientes (0918): la reposición habla en recipientes y traduce a unidades de preparación y, con rendimiento, de compra.
    v_eq := case when v_b.yield is not null and v_b.yield > 0 and v_b.purchase_unit is not null
                 then ' ≈ ' || trim(to_char(round(v_qty / v_b.yield, 1), 'FM999990.0')) || ' ' || v_b.purchase_unit else '' end;
    if not v_purchase and v_b.per_container is not null and v_b.per_container > 0 then
      v_cont := ceil(v_qty / v_b.per_container)::int;
      v_label := 'Reponer ' || v_b.location || ': ' || v_cont || case when v_cont = 1 then ' recipiente' else ' recipientes' end
        || ' de ' || v_b.name || ' (' || trim(to_char(v_qty, 'FM999990.##')) || ' ' || v_b.unit || v_eq || ')';
      v_payload := v_payload || jsonb_build_object('containers', v_cont);
    end if;
    -- «Comprar X» en unidades de compra cuando Food da el rendimiento (#774): ceil(necesario ÷ rendimiento).
    if v_purchase and v_b.yield is not null and v_b.yield > 0 and v_b.purchase_unit is not null then
      v_buy := ceil(v_qty / v_b.yield);
      v_label := 'Comprar ' || v_b.name || ' · ' || trim(to_char(v_buy, 'FM999990')) || ' ' || v_b.purchase_unit;
      v_payload := v_payload || jsonb_build_object('purchase_qty', v_buy, 'purchase_unit', v_b.purchase_unit);
    end if;
    select * into v_open from flow.units
     where project_id = v_b.project_id and deleted_at is null and source_ref like v_ref || ':%' and status in ('proposed','pending','in_progress')
     order by created_at desc limit 1 for update;
    if v_open.id is null then
      perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_b.project_id, 'column_key', v_col, 'kind', 'task', 'label', v_label,
        'status', 'proposed', 'payload', v_payload, 'source_ref', v_ref || ':' || gen_random_uuid()));
    elsif v_open.status = 'proposed' and (v_open.payload->>'qty')::numeric is distinct from v_qty then
      perform flow.upd(p, 'flow.units', v_open.id, v_open.revision, jsonb_build_object('payload', v_payload, 'label', v_label));
    end if;
  end loop;
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
