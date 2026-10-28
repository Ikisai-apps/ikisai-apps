-- 0116 · El snapshot y los lotes del núcleo usaban `t` como alias de fila en SQL dinámico (`to_jsonb(t)`), así que cualquier tabla
-- sincronizada con una columna llamada `t` devolvía esa columna en vez de la fila (lo destapó Flow con board_history, 27-10). Mismas
-- funciones, alias `__r` que ninguna tabla usa. Sin cambios de comportamiento.

-- apply_row_op (última definición: migrations\20261006_0021_core_restore_fields.sql, 2 alias)
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
    execute format('select to_jsonb(__r) from %s __r where id = $1', v_qualified) into v_before using v_id;
    if v_before is not null then perform core.fail('ROW_EXISTS', 409, jsonb_build_object('table', p_op->>'table', 'id', v_id)); end if;
    v_fields := v_fields || jsonb_build_object('id', v_id, 'updated_by', p_actor);
    v_cols := v_cols || array['id','updated_by'];
    v_sql := format('insert into %s (%s) select %s from jsonb_populate_record(null::%s, $1) returning to_jsonb(%I.*)',
      v_qualified, (select string_agg(format('%I', c), ',') from unnest(v_cols) c), (select string_agg(format('%I', c), ',') from unnest(v_cols) c), v_qualified, v_def.table_name);
    execute v_sql into v_after using v_fields;
  else
    execute format('select to_jsonb(__r) from %s __r where id = $1 for update', v_qualified) into v_before using v_id;
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

-- snapshot_table (última definición: migrations\20261006_0001_core_base.sql, 1 alias)
create or replace function core.snapshot_table(p_app text, p_role text, p_table text, p_include_deleted boolean, p_limit int, p_offset int)
returns jsonb language plpgsql stable as $$
declare v_def core.synced_tables; v_rows jsonb; v_total bigint;
begin
  v_def := core.table_def(p_app, p_table);
  if not (p_role = any(v_def.readable_roles)) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', p_table)); end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(__r) order by __r.created_at, __r.id), ''[]''::jsonb) from (select * from %I.%I where ($1 or deleted_at is null) order by created_at, id limit $2 offset $3) __r', v_def.schema_name, v_def.table_name)
    into v_rows using p_include_deleted, greatest(1, least(coalesce(p_limit, 500), 2000)), greatest(0, coalesce(p_offset, 0));
  execute format('select count(*) from %I.%I where ($1 or deleted_at is null)', v_def.schema_name, v_def.table_name) into v_total using p_include_deleted;
  return jsonb_build_object('table', p_table, 'rows', v_rows, 'total', v_total);
end $$;

-- undo_plan (última definición: migrations\20261006_0001_core_base.sql, 1 alias)
create or replace function core.undo_plan(p_app text, p_cursor bigint)
returns jsonb language plpgsql stable as $$
declare c record; v_ops jsonb := '[]'::jsonb; v_current jsonb; v_def core.synced_tables; v_fields jsonb; v_col text;
begin
  if not exists (select 1 from core.changes where app = p_app and cursor = p_cursor) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('cursor', p_cursor)); end if;
  for c in select * from core.changes where app = p_app and cursor = p_cursor order by seq desc loop
    if c.op = 'call' then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'batch contains a procedure call', 'cursor', p_cursor)); end if;
    if c.op = 'purge' then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'purged rows cannot be restored', 'cursor', p_cursor)); end if;
    execute format('select to_jsonb(__r) from %I.%I __r where id = $1', c.schema_name, c.table_name) into v_current using c.row_id;
    if v_current is null then perform core.fail('UNDO_UNAVAILABLE', 409, jsonb_build_object('reason', 'row no longer exists', 'id', c.row_id)); end if;
    if c.op = 'insert' then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    elsif c.op = 'delete' then
      v_ops := v_ops || jsonb_build_object('op', 'restore', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    elsif c.op = 'restore' then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint);
    else
      select * into v_def from core.synced_tables where app = p_app and schema_name = c.schema_name and table_name = c.table_name;
      v_fields := '{}'::jsonb;
      foreach v_col in array v_def.writable_columns loop
        if c.before->v_col is distinct from c.after->v_col then v_fields := v_fields || jsonb_build_object(v_col, c.before->v_col); end if;
      end loop;
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'expectedRevision', (v_current->>'revision')::bigint, 'fields', v_fields);
    end if;
  end loop;
  return jsonb_build_object('cursor', p_cursor, 'operations', v_ops);
end $$;

-- purge_deleted (última definición: migrations\20261006_0001_core_base.sql, 1 alias)
create or replace function core.purge_deleted(p_app text, p_actor uuid, p_request_id text, p_tables text[])
returns jsonb language plpgsql as $$
declare v_role text; v_cursor bigint; v_next bigint; v_table text; v_def core.synced_tables; v_count int; v_total int := 0; v_row record;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners can purge')); end if;
  select cursor into v_cursor from core.app_state where app = p_app for update;
  v_next := v_cursor + 1;
  foreach v_table in array p_tables loop
    v_def := core.table_def(p_app, v_table);
    if v_def.never_purge then continue; end if;
    for v_row in execute format('select id, to_jsonb(__r) row from %I.%I __r where deleted_at is not null', v_def.schema_name, v_def.table_name) loop
      insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
      values (p_app, v_next, core.next_seq(p_app, v_next), p_actor, p_request_id, v_def.schema_name, v_def.table_name, v_row.id, 'purge', (v_row.row->>'revision')::bigint, v_row.row, null);
    end loop;
    execute format('delete from %I.%I where deleted_at is not null', v_def.schema_name, v_def.table_name);
    get diagnostics v_count = row_count; v_total := v_total + v_count;
  end loop;
  if v_total > 0 then update core.app_state set cursor = v_next where app = p_app; end if;
  return jsonb_build_object('purged', v_total, 'cursor', case when v_total > 0 then v_next else v_cursor end);
end $$;

-- file_referencing_rows (última definición: migrations\20261008_0081_core_file_referencing_rows.sql, 2 alias)
create or replace function core.file_referencing_rows(p_app text, p_file uuid)
returns jsonb language plpgsql stable as $$
declare f core.file_fields; v_rows jsonb; v_out jsonb := '[]'::jsonb;
begin
  for f in select * from core.file_fields where app = p_app loop
    execute format('select coalesce(jsonb_agg(to_jsonb(__r)), ''[]''::jsonb) from %I.%I __r where %I = $1 and (to_jsonb(__r)->>''deleted_at'') is null',
                   f.schema_name, f.table_name, f.column_name) into v_rows using p_file;
    select v_out || coalesce(jsonb_agg(jsonb_build_object('table', f.schema_name || '.' || f.table_name, 'row', r)), '[]'::jsonb)
      into v_out from jsonb_array_elements(v_rows) r;
  end loop;
  return v_out;
end $$;
