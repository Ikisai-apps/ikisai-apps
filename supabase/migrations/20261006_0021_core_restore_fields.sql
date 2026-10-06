-- Ikisai Core · `restore` admite `fields` (solo writable_columns) para corregir una fila al sacarla de la papelera
-- (petición C16 de Tasks: una hija cuyo padre cambió de proyecto mientras estaba borrada).
create or replace function core.apply_row_op(p_app text, p_actor uuid, p_role text, p_request_id text, p_cursor bigint, p_op jsonb)
returns jsonb language plpgsql as $$
declare
  v_def core.synced_tables; v_op text := p_op->>'op'; v_id uuid; v_fields jsonb := coalesce(p_op->'fields', '{}'::jsonb);
  v_before jsonb; v_after jsonb; v_key text; v_cols text[] := '{}'; v_expected bigint; v_qualified text; v_sql text;
begin
  if v_op not in ('insert','update','delete','restore') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown op', 'op', v_op)); end if;
  v_def := core.table_def(p_app, p_op->>'table');
  v_qualified := format('%I.%I', v_def.schema_name, v_def.table_name);
  if not (p_role = any(v_def.writable_roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', p_op->>'table')); end if;
  begin v_id := (p_op->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id must be a uuid')); end if;
  if jsonb_typeof(v_fields) <> 'object' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('reason', 'fields must be an object')); end if;
  for v_key in select jsonb_object_keys(v_fields) loop
    if not (v_key = any(v_def.writable_columns)) then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', v_key, 'table', p_op->>'table')); end if;
    v_cols := v_cols || v_key;
  end loop;
  if v_op = 'delete' and array_length(v_cols, 1) is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('reason', 'delete takes no fields')); end if;

  if v_op = 'insert' then
    execute format('select to_jsonb(t) from %s t where id = $1', v_qualified) into v_before using v_id;
    if v_before is not null then perform core.fail('ROW_EXISTS', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id)); end if;
    v_fields := v_fields || jsonb_build_object('id', v_id, 'updated_by', p_actor);
    v_cols := v_cols || array['id','updated_by'];
    v_sql := format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) returning to_jsonb(%I.*)',
      v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name);
    execute v_sql into v_after using v_fields;
  else
    execute format('select to_jsonb(t) from %s t where id = $1 for update', v_qualified) into v_before using v_id;
    if v_before is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', p_op->>'table', 'id', v_id)); end if;
    if p_op->>'expectedRevision' is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'expectedRevision required', 'id', v_id)); end if;
    v_expected := (p_op->>'expectedRevision')::bigint;
    if (v_before->>'revision')::bigint <> v_expected then
      perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'expectedRevision', v_expected, 'currentRevision', (v_before->>'revision')::bigint, 'current', v_before));
    end if;
    if v_op = 'update' then
      if v_before->>'deleted_at' is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      if array_length(v_cols, 1) is null then
        v_after := v_before;
      else
        v_sql := format('update %s set (%s) = (select %s from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)',
          v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name);
        if array_length(v_cols, 1) = 1 then
          v_sql := format('update %s set %I = (select %I from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)', v_qualified, v_cols[1], v_cols[1], v_qualified, v_def.table_name);
        end if;
        execute v_sql into v_after using v_fields, v_id;
      end if;
    elsif v_op = 'delete' then
      if v_before->>'deleted_at' is not null then perform core.fail('ROW_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      execute format('update %s set deleted_at = now() where id = $1 returning to_jsonb(%I.*)', v_qualified, v_def.table_name) into v_after using v_id;
    else
      if v_before->>'deleted_at' is null then perform core.fail('ROW_NOT_DELETED', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id, 'current', v_before)); end if;
      if array_length(v_cols, 1) is null then
        execute format('update %s set deleted_at = null where id = $1 returning to_jsonb(%I.*)', v_qualified, v_def.table_name) into v_after using v_id;
      elsif array_length(v_cols, 1) = 1 then
        execute format('update %s set deleted_at = null, %I = (select %I from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)', v_qualified, v_cols[1], v_cols[1], v_qualified, v_def.table_name) into v_after using v_fields, v_id;
      else
        execute format('update %s set deleted_at = null, (%s) = (select %s from jsonb_populate_record(null::%s, $1)) where id = $2 returning to_jsonb(%I.*)',
          v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name) into v_after using v_fields, v_id;
      end if;
    end if;
  end if;

  insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
  values (p_app, p_cursor, core.next_seq(p_app, p_cursor), p_actor, p_request_id, v_def.schema_name, v_def.table_name, v_id, v_op, (v_after->>'revision')::bigint, v_before, v_after);
  return jsonb_build_object('op', v_op, 'table', p_op->>'table', 'id', v_id, 'revision', (v_after->>'revision')::bigint, 'after', v_after);
end $$;
