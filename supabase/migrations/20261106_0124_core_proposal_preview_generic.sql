-- 0124 · Propuestas hacia otra app: el ensayo (commit_preview) en la app destino corre con permisos de un owner o del decisor de allí;
-- si falla, el agente recibía el error detallado del núcleo (fila actual, campos…), datos de una app en la que no es nadie
-- (revisión de seguridad del 6-11 sobre 0122). Ahora recibe un INVALID_OPERATION genérico; el detalle lo verá el decisor al decidir.

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
  if v_target is null then
    v_preview := core.commit_preview(p_app, v_preview_actor, p_operations);
  else
    -- 0124: el ensayo en la app destino corre con permisos de allí; sus errores (filas actuales, campos) no se devuelven al agente.
    begin
      v_preview := core.commit_preview(v_target, v_preview_actor, p_operations);
    exception when others then
      if sqlstate !~ '^PT' then raise; end if;
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'the proposal cannot be applied in the target app as it is', 'targetApp', v_target));
    end;
  end if;
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
