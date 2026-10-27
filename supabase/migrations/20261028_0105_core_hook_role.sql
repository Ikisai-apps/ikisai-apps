-- 0105 · Los hooks de validación reciben el rol y los ámbitos con los que empezó el lote (auditoría del 27-10, H0–H6).
--
-- Hasta ahora `validate_hooks` recibían solo {app, actor, cursor}. Un hook que leía el rol de `core.memberships` veía lo que un
-- trigger del mismo lote hubiera cambiado (C1 de Central: `people.house_level` → `apply_house_level` subía al editor a owner
-- antes de que el hook mirase). Los procedimientos ya recibían `role`; ahora los hooks reciben `role` (el inicial, el mismo que
-- autorizó el lote) y `scopes` (los de la pertenencia al empezar). Los hooks deben usar estos valores y no volver a leer la tabla.
-- Misma función que la 0099; solo cambia el payload del hook y la lectura inicial de los ámbitos.

create or replace function core.apply_operations(p_app text, p_actor uuid, p_role text, p_request_id text, p_cursor bigint, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_scopes0 jsonb; v_op jsonb; v_results jsonb := '[]'::jsonb; v_result jsonb; v_proc text; v_hook text;
begin
  -- El ámbito con el que empezó el lote (un trigger del propio lote puede cambiar la pertenencia: H0–H6 de la auditoría).
  select scopes into v_scopes0 from core.memberships where app = p_app and user_id = p_actor;
  perform set_config('core.actor', p_actor::text, true);
  perform set_config('core.app', p_app, true);
  perform set_config('core.cursor', p_cursor::text, true);
  perform set_config('core.request_id', p_request_id, true);
  perform set_config('core.role', p_role, true);
  for v_op in select * from jsonb_array_elements(p_operations) loop
    if v_op->>'op' = 'call' then
      v_proc := v_op->>'procedure';
      if not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc) then
        perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'procedure not allowed', 'procedure', v_proc));
      end if;
      if p_role = 'outsider' and not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc and outsider) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', v_proc));
      end if;
      if p_role = 'reader' and not exists (select 1 from core.allowed_procedures where app = p_app and procedure = v_proc and reader) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', v_proc));
      end if;
      execute format('select %s($1)', v_proc) into v_result
        using jsonb_build_object('app', p_app, 'actor', p_actor, 'role', p_role, 'requestId', p_request_id, 'cursor', p_cursor, 'args', coalesce(v_op->'args', '{}'::jsonb));
      insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
      values (p_app, p_cursor, core.next_seq(p_app, p_cursor), p_actor, p_request_id, split_part(v_proc, '.', 1), split_part(v_proc, '.', 2), null, 'call', null, coalesce(v_op->'args', '{}'::jsonb), v_result);
      v_results := v_results || jsonb_build_object('op', 'call', 'procedure', v_proc, 'result', v_result);
    else
      v_result := core.apply_row_op(p_app, p_actor, p_role, p_request_id, p_cursor, v_op);
      v_results := v_results || (v_result - 'after');
    end if;
  end loop;
  for v_hook in select procedure from core.validate_hooks where app = p_app loop
    execute format('select %s($1)', v_hook) using jsonb_build_object('app', p_app, 'actor', p_actor, 'cursor', p_cursor, 'role', p_role, 'scopes', v_scopes0);
  end loop;
  return v_results;
end $$;
