-- 0122 · Propuestas (0120): autor y propuesta visibles dentro del lote aplicado, y dos cierres de la revisión de seguridad del 6-11.
--   - `core.proposal_author()` y `core.proposal_id()`: dentro del lote que aplica una propuesta aprobada hacia otra app devuelven el
--     agente autor y la propuesta (como suggestion_author/suggestion_id, 0094); fuera, null. Los hooks de la app destino acotan
--     con ellos lo que un agente puede proponer (Central: «un agente solo propone sobre su propia ficha»).
--   - El decisor nombrado solo existe en propuestas hacia otra app y tiene que ser editor u owner de esa app (nunca reader): lo que
--     aprueba se aplica con sus permisos. En la propia app sigue decidiendo solo el owner.
--   - El agente autor no ve el resumen antes/después de una propuesta hacia otra app (el ensayo se hace con los permisos de la app
--     destino): `summary` solo para owners y decisor. Sus operaciones sí, que son suyas.

create or replace function core.proposal_author() returns uuid language sql stable as $$
  select nullif(current_setting('core.proposal_author', true), '')::uuid
$$;
create or replace function core.proposal_id() returns uuid language sql stable as $$
  select nullif(current_setting('core.proposal_id', true), '')::uuid
$$;

/** Vista de una propuesta para p_actor: el agente autor no ve el resumen de una propuesta hacia otra app. */
create or replace function core.proposal_json_for(p core.proposals, p_actor uuid)
returns jsonb language sql stable as $$
  select case when p.target_app is not null and p.user_id = p_actor
              then core.proposal_json(p) || jsonb_build_object('summary', '[]'::jsonb, 'summaryHidden', true)
              else core.proposal_json(p) end
$$;

create or replace function core.proposal_can_decide(p core.proposals, p_actor uuid) returns boolean language sql stable as $$
  select coalesce((select kind from core.profiles where user_id = p_actor) is distinct from 'agent'
     and (exists (select 1 from core.memberships m where m.app = coalesce(p.target_app, p.app) and m.user_id = p_actor and m.role = 'owner')
          or (p.target_app is not null and p.decider_user_id is not null and p.decider_user_id = p_actor
              and exists (select 1 from core.memberships m where m.app = p.target_app and m.user_id = p_actor and m.role in ('editor', 'owner')))), false)
$$;

create or replace function core.proposal_prepare(p_app text, p_actor uuid, p_key uuid, p_request_id text, p_digest text, p_operations jsonb, p_risk jsonb,
  p_target_app text, p_decider uuid, p_fields jsonb, p_group_key text, p_uncertain jsonb)
returns jsonb language plpgsql as $$
declare v_role text; v_prop core.proposals; v_preview jsonb; v_target text := nullif(p_target_app, p_app); v_preview_actor uuid;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  if (select kind from core.profiles where user_id = p_actor) is distinct from 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'proposals are for agents')); end if;
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  if v_role = 'reader' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot write')); end if;
  if v_target is not null and not exists (select 1 from core.apps where id = v_target) then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown target app', 'targetApp', v_target)); end if;
  if p_decider is not null then
    -- Revisión 6-11: en la propia app decide solo el owner, como siempre; el decisor nombrado es para propuestas hacia otra app.
    if v_target is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decider only applies to proposals to another app')); end if;
    if (select kind from core.profiles where user_id = p_decider) = 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decider must be a person')); end if;
    -- Revisión 6-11: el decisor aplica el lote con sus permisos; un lector no puede ser decisor.
    if not exists (select 1 from core.memberships where app = coalesce(v_target, p_app) and user_id = p_decider and role in ('editor', 'owner')) then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decider must be an editor or owner of the target app'));
    end if;
  end if;
  if p_fields is not null and jsonb_typeof(p_fields) not in ('array', 'null') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'fields must be an array')); end if;
  if p_uncertain is not null and jsonb_typeof(p_uncertain) not in ('array', 'null') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'uncertain must be an array')); end if;
  if exists (select 1 from core.receipts where app = coalesce(v_target, p_app) and actor_id = p_actor and request_id = p_request_id) then
    perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id, 'reason', 'already committed'));
  end if;
  select * into v_prop from core.proposals where app = p_app and user_id = p_actor and request_id = p_request_id;
  if v_prop.id is not null then
    if v_prop.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return core.proposal_json_for(v_prop, p_actor);
  end if;
  v_preview_actor := case when v_target is null then p_actor else coalesce(p_decider, (select m.user_id from core.memberships m join core.profiles pr on pr.user_id = m.user_id
    where m.app = v_target and m.role = 'owner' and pr.kind is distinct from 'agent' order by m.user_id limit 1)) end;
  if v_preview_actor is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'target app has no owner to decide', 'targetApp', v_target)); end if;
  v_preview := core.commit_preview(coalesce(v_target, p_app), v_preview_actor, p_operations);
  insert into core.proposals (app, user_id, key_id, request_id, digest, operations, risk, summary, status, expires_at, target_app, decider_user_id, proposal_fields, uncertain, group_key)
  values (p_app, p_actor, p_key, p_request_id, p_digest, p_operations, coalesce(p_risk, '{}'::jsonb), coalesce(v_preview->'changes', '[]'::jsonb), 'pending', now() + interval '24 hours',
          v_target, p_decider, case when p_fields is null or jsonb_typeof(p_fields) = 'null' then '[]'::jsonb else p_fields end,
          case when p_uncertain is null or jsonb_typeof(p_uncertain) = 'null' then '[]'::jsonb else p_uncertain end, p_group_key)
  returning * into v_prop;
  perform core.log_access(p_app, p_actor, p_key, 'proposal_prepared', jsonb_build_object('proposalId', v_prop.id, 'requestId', p_request_id, 'operations', jsonb_array_length(p_operations),
    'risk', coalesce(p_risk, '{}'::jsonb), 'targetApp', v_target, 'deciderUserId', p_decider, 'groupKey', p_group_key));
  if v_target is not null then
    perform core.log_access(v_target, p_actor, p_key, 'proposal_prepared', jsonb_build_object('proposalId', v_prop.id, 'requestId', p_request_id, 'fromApp', p_app));
  end if;
  return core.proposal_json_for(v_prop, p_actor);
end $$;

create or replace function core.proposal_decide(p_app text, p_actor uuid, p_id uuid, p_decision text)
returns jsonb language plpgsql as $$
declare v_prop core.proposals; v_status text; v_error text; v_eff text; v_result jsonb;
begin
  if p_decision not in ('approve','reject') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decision must be approve or reject')); end if;
  select * into v_prop from core.proposals where id = p_id and (app = p_app or target_app = p_app) for update;
  if v_prop.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('proposalId', p_id)); end if;
  v_eff := core.proposal_app(v_prop);
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot decide proposals')); end if;
  if not core.proposal_can_decide(v_prop, p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners or the named decider decide proposals')); end if;
  v_status := case when v_prop.status in ('pending','approved') and v_prop.expires_at < now() then 'expired' else v_prop.status end;
  if p_decision = 'reject' then
    if v_status not in ('pending','approved') then perform core.fail('PROPOSAL_UNAVAILABLE', 409, jsonb_build_object('proposalId', p_id, 'status', v_status)); end if;
    update core.proposals set status = 'rejected', reason = 'rejected by ' || case when v_prop.decider_user_id = p_actor then 'decider' else 'owner' end, decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
    perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_rejected', jsonb_build_object('proposalId', p_id, 'previous', v_status));
    return core.proposal_json(v_prop);
  end if;
  if v_status <> 'pending' then perform core.fail('PROPOSAL_UNAVAILABLE', 409, jsonb_build_object('proposalId', p_id, 'status', v_status)); end if;
  begin
    perform core.commit_preview(v_eff, case when v_prop.target_app is null then v_prop.user_id else p_actor end, v_prop.operations);
  exception when others then
    if sqlstate !~ '^PT' then raise; end if;
    v_error := sqlerrm;
    update core.proposals set status = 'rejected', reason = 'no longer applies: ' || v_error, decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
    perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_rejected', jsonb_build_object('proposalId', p_id, 'reason', v_error, 'automatic', true));
    return core.proposal_json(v_prop) || jsonb_build_object('autoRejected', true);
  end;
  if v_prop.target_app is null then
    update core.proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = p_id returning * into v_prop;
    perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_approved', jsonb_build_object('proposalId', p_id));
    return core.proposal_json(v_prop);
  end if;
  -- Otra app: se aplica ya, como el decisor (sus permisos acotan el lote), origen servidor, con autor y propuesta a la vista de los hooks.
  update core.proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = p_id;
  perform set_config('core.origin', 'server', true);
  perform set_config('core.proposal_author', v_prop.user_id::text, true);
  perform set_config('core.proposal_id', p_id::text, true);
  begin
    v_result := core.commit(v_eff, p_actor, 'proposal:' || p_id::text, v_prop.digest, null, v_prop.operations, null);
  exception when others then
    perform set_config('core.proposal_author', '', true); perform set_config('core.proposal_id', '', true);
    raise;
  end;
  perform set_config('core.proposal_author', '', true); perform set_config('core.proposal_id', '', true);
  update core.proposals set status = 'consumed', consumed_cursor = (v_result->>'cursor')::bigint where id = p_id returning * into v_prop;
  perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_approved', jsonb_build_object('proposalId', p_id, 'applied', true, 'cursor', v_result->'cursor', 'authorUserId', v_prop.user_id));
  perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_consumed', jsonb_build_object('proposalId', p_id, 'cursor', v_result->'cursor'));
  return core.proposal_json(v_prop) || jsonb_build_object('applied', true, 'cursor', v_result->'cursor');
end $$;

create or replace function core.proposal_list(p_app text, p_actor uuid, p_status text, p_limit int)
returns jsonb language plpgsql stable as $$
declare v_role text; v_kind text; v_limit int := greatest(1, least(coalesce(p_limit, 100), 200));
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select kind into v_kind from core.profiles where user_id = p_actor;
  if v_role <> 'owner' and v_kind is distinct from 'agent' and not exists (select 1 from core.proposals q where (q.app = p_app or q.target_app = p_app) and q.decider_user_id = p_actor) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners, deciders and agents list proposals'));
  end if;
  return (select coalesce(jsonb_agg(core.proposal_json_for(p, p_actor) order by p.created_at desc), '[]'::jsonb) from core.proposals p where p.id in (
    select q.id from core.proposals q
      where (q.app = p_app or q.target_app = p_app)
        and (v_role = 'owner' or q.user_id = p_actor or q.decider_user_id = p_actor)
        and (p_status is null or (case when q.status in ('pending','approved') and q.expires_at < now() then 'expired' else q.status end) = p_status)
      order by q.created_at desc limit v_limit));
end $$;

create or replace function core.proposal_get(p_app text, p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v_role text; v_prop core.proposals;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select * into v_prop from core.proposals where id = p_id and (app = p_app or target_app = p_app);
  if v_prop.id is null or (v_role <> 'owner' and v_prop.user_id <> p_actor and v_prop.decider_user_id is distinct from p_actor) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('proposalId', p_id)); end if;
  return core.proposal_json_for(v_prop, p_actor);
end $$;

revoke all on function core.proposal_author(), core.proposal_id() from public, anon, authenticated;
grant execute on function core.proposal_author(), core.proposal_id() to service_role;
