-- Ikisai Core · el lector vota (tanda 27: P10 de Central y petición de Food). Decisión del usuario (19-10-2026): en
-- Decisiones y en Platos sugeridos vota también quien solo lee; autorizó este cambio del núcleo el mismo día.
-- Hasta ahora core.commit rechazaba cualquier lote de un lector. Desde aquí, como con el outsider, manda la tabla:
--   · filas: el lector escribe solo en tablas cuyo `writable_roles` lo incluye a propósito (hoy central.decision_votes y
--     food.suggestion_votes); en el resto (por defecto '{editor,owner}') core.apply_row_op le sigue devolviendo 403;
--   · procedimientos: solo los que la app abre con core.allow_reader_procedure.
-- Y core.suggestion_list gana el ámbito `vote`: las pendientes para votar, sin quién propone si no eres editor ni owner.

alter table core.allowed_procedures add column if not exists reader boolean not null default false;

create or replace function core.allow_reader_procedure(p_app text, p_procedure text)
returns void language plpgsql as $$
begin
  update core.allowed_procedures set reader = true where app = p_app and procedure = p_procedure;
  if not found then perform core.fail('PROCEDURE_NOT_ALLOWED', 422, jsonb_build_object('procedure', p_procedure)); end if;
end $$;

create or replace function core.apply_operations(p_app text, p_actor uuid, p_role text, p_request_id text, p_cursor bigint, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_op jsonb; v_results jsonb := '[]'::jsonb; v_result jsonb; v_proc text; v_hook text;
begin
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
    execute format('select %s($1)', v_hook) using jsonb_build_object('app', p_app, 'actor', p_actor, 'cursor', p_cursor);
  end loop;
  return v_results;
end $$;

create or replace function core.commit_preview(p_app text, p_actor uuid, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_cursor bigint; v_role text; v_next bigint; v_results jsonb; v_changes jsonb;
begin
  if jsonb_typeof(p_operations) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array')); end if;
  if jsonb_array_length(p_operations) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 500 operations')); end if;
  select cursor into v_cursor from core.app_state where app = p_app;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  v_next := v_cursor + 1;
  begin
    v_results := core.apply_operations(p_app, p_actor, v_role, 'preview', v_next, p_operations);
    select coalesce(jsonb_agg(jsonb_build_object('seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'before', c.before, 'after', c.after) order by c.seq), '[]'::jsonb)
      into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;
    raise exception using errcode = 'PV000', message = 'PREVIEW_ROLLBACK';
  exception when sqlstate 'PV000' then
    -- Las variables conservan su valor; la subtransacción (filas, cambios, secuencias) queda deshecha.
    return jsonb_build_object('cursor', v_cursor, 'results', v_results, 'changes', v_changes);
  end;
end $$;

create or replace function core.commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb, p_confirmation jsonb default null)
returns jsonb language plpgsql as $$
declare
  v_cursor bigint; v_role text; v_kind text; v_receipt core.receipts; v_results jsonb; v_result jsonb; v_next bigint; v_changes jsonb;
  v_prop core.proposals; v_prop_id uuid;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  if jsonb_typeof(p_operations) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array')); end if;
  if jsonb_array_length(p_operations) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 500 operations')); end if;

  select cursor into v_cursor from core.app_state where app = p_app for update;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;

  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;

  select * into v_receipt from core.receipts where app = p_app and actor_id = p_actor and request_id = p_request_id;
  if v_receipt.request_id is not null then
    if v_receipt.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return v_receipt.result || jsonb_build_object('replayed', true);
  end if;

  if p_expected_cursor is not null and p_expected_cursor <> v_cursor then
    perform core.fail('CURSOR_CONFLICT', 409, jsonb_build_object('expectedCursor', p_expected_cursor, 'currentCursor', v_cursor));
  end if;

  select kind into v_kind from core.profiles where user_id = p_actor;
  if v_kind = 'agent' and coalesce((p_confirmation->>'required')::boolean, false) then
    begin v_prop_id := (p_confirmation->>'id')::uuid; exception when others then v_prop_id := null; end;
    if v_prop_id is not null then select * into v_prop from core.proposals where id = v_prop_id and app = p_app and user_id = p_actor for update; end if;
    if v_prop.id is null or v_prop.status <> 'approved' or v_prop.expires_at < now() or v_prop.request_id <> p_request_id or v_prop.digest <> p_digest then
      perform core.fail('CONFIRMATION_REQUIRED', 428, jsonb_build_object('risk', coalesce(p_confirmation->'risk', '{}'::jsonb), 'proposalId', v_prop.id,
        'proposalStatus', case when v_prop.id is null then null when v_prop.status in ('pending','approved') and v_prop.expires_at < now() then 'expired' else v_prop.status end,
        'mismatch', case when v_prop.id is null then null else jsonb_build_object('requestId', v_prop.request_id <> p_request_id, 'digest', v_prop.digest <> p_digest) end));
    end if;
  end if;

  v_next := v_cursor + 1;
  v_results := core.apply_operations(p_app, p_actor, v_role, p_request_id, v_next, p_operations);

  update core.app_state set cursor = v_next where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('cursor', c.cursor, 'seq', c.seq, 'table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision, 'after', c.after) order by c.seq), '[]'::jsonb)
    into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;
  v_result := jsonb_build_object('cursor', v_next, 'requestId', p_request_id, 'results', v_results, 'changes', v_changes);
  if v_prop.id is not null then
    update core.proposals set status = 'consumed', consumed_cursor = v_next where id = v_prop.id;
    perform core.log_access(p_app, p_actor, v_prop.key_id, 'proposal_consumed', jsonb_build_object('proposalId', v_prop.id, 'cursor', v_next));
    v_result := v_result || jsonb_build_object('proposalId', v_prop.id);
  end if;
  insert into core.receipts (app, actor_id, request_id, digest, cursor, result) values (p_app, p_actor, p_request_id, p_digest, v_next, v_result);
  return v_result;
end $$;

-- `vote`: pendientes para votar; sin autor para quien no es editor ni owner.
create or replace function core.suggestion_list(p_app text, p_actor uuid, p_scope text, p_limit int default 50, p_before timestamptz default null)
returns jsonb language plpgsql stable as $$
declare v_limit int := least(200, greatest(1, coalesce(p_limit, 50))); v_role text; v_anon boolean := false;
begin
  if p_scope not in ('mine', 'pending', 'all', 'vote') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'scope must be mine, pending, all or vote')); end if;
  if p_scope = 'vote' then
    -- Votar: las pendientes de la app, para cualquier miembro humano salvo el outsider. Quien no decide no ve quién propone.
    select role into v_role from core.memberships where app = p_app and user_id = p_actor;
    if v_role is null or v_role = 'outsider' or coalesce((select kind from core.profiles where user_id = p_actor), 'human') = 'agent' then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'cannot vote suggestions'));
    end if;
    v_anon := v_role not in ('editor', 'owner');
  elsif p_scope <> 'mine' then perform core.suggestion_require_reviewer(p_app, p_actor); end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(case when v_anon then core.suggestion_json(s) || jsonb_build_object('author', null, 'anonymous', true) else core.suggestion_json(s) end order by s.created_at desc)
      from (select * from core.suggestions s
             where s.app = p_app
               and (p_scope <> 'mine' or s.author_id = p_actor)
               and (p_scope not in ('pending', 'vote') or s.status = 'pending')
               and (p_before is null or s.created_at < p_before)
             order by s.created_at desc limit v_limit) s), '[]'::jsonb),
    'pendingCount', case when p_scope = 'mine' then null else (select count(*) from core.suggestions where app = p_app and status = 'pending') end);
end $$;

do $$
declare f text;
begin
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'core' and p.proname in ('allow_reader_procedure', 'apply_operations', 'commit', 'commit_preview', 'suggestion_list') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
