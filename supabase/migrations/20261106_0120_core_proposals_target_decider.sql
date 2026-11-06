-- 0120 · Propuestas con destino, decisor, campos y grupo (VG 28-10 «Carga asistida» y vg-51; sprint 5-11: Central X1, Flow fl-25).
--   - `target_app`: la app donde se aplican las operaciones cuando no es la del agente (Central no admite agentes: el agente propone
--     desde su app y la propuesta aparece en la bandeja de Central). Al aprobarla se APLICA en el acto en la app destino, con el
--     decisor como actor del lote (sus permisos acotan lo que entra); el agente queda como autor en el registro de accesos.
--   - `decider_user_id`: además de los owners de la app efectiva decide esa persona (p. ej. el responsable de la ficha del agente).
--   - `proposal_fields` (campos tocados, `entity.prop`), `uncertain` (marcas «por confirmar») y `group_key` (decisión por grupo):
--     lo que Flow recorre en Guiado para la «Carga asistida».
-- Compatibilidad: las funciones de 7 y 4 argumentos siguen; `proposal_json` añade claves.

alter table core.proposals
  add column if not exists target_app text references core.apps(id),
  add column if not exists decider_user_id uuid references auth.users(id),
  add column if not exists proposal_fields jsonb not null default '[]'::jsonb,
  add column if not exists uncertain jsonb not null default '[]'::jsonb,
  add column if not exists group_key text check (group_key is null or group_key ~ '^[A-Za-z0-9_.:-]{1,120}$');
create index if not exists proposals_target_idx on core.proposals (target_app, created_at desc) where target_app is not null;
create index if not exists proposals_group_idx on core.proposals (app, group_key) where group_key is not null;

/** App efectiva de una propuesta: donde se aplican sus operaciones. */
create or replace function core.proposal_app(p core.proposals) returns text language sql immutable as $$
  select coalesce(p.target_app, p.app)
$$;

create or replace function core.proposal_json(p core.proposals)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p.id, 'app', p.app, 'targetApp', p.target_app, 'effectiveApp', coalesce(p.target_app, p.app), 'userId', p.user_id, 'keyId', p.key_id,
    'requestId', p.request_id, 'digest', p.digest, 'operations', p.operations, 'risk', p.risk, 'summary', p.summary,
    'fields', p.proposal_fields, 'uncertain', p.uncertain, 'groupKey', p.group_key, 'deciderUserId', p.decider_user_id,
    'status', case when p.status in ('pending','approved') and p.expires_at < now() then 'expired' else p.status end,
    'reason', p.reason, 'expiresAt', p.expires_at, 'decidedBy', p.decided_by, 'decidedAt', p.decided_at, 'consumedCursor', p.consumed_cursor, 'createdAt', p.created_at);
$$;

/** ¿Puede p_actor decidir la propuesta? Owner humano de la app efectiva, o el decisor nombrado (humano, con pertenencia). */
create or replace function core.proposal_can_decide(p core.proposals, p_actor uuid) returns boolean language sql stable as $$
  select coalesce((select kind from core.profiles where user_id = p_actor) is distinct from 'agent'
     and (exists (select 1 from core.memberships m where m.app = coalesce(p.target_app, p.app) and m.user_id = p_actor and m.role = 'owner')
          or (p.decider_user_id is not null and p.decider_user_id = p_actor
              and exists (select 1 from core.memberships m where m.app = coalesce(p.target_app, p.app) and m.user_id = p_actor))), false)
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
    if (select kind from core.profiles where user_id = p_decider) = 'agent' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decider must be a person')); end if;
    if not exists (select 1 from core.memberships where app = coalesce(v_target, p_app) and user_id = p_decider) then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decider has no membership in the target app')); end if;
  end if;
  -- Un `null` JSON cuenta como ausente (la Edge lo manda así cuando no hay valor).
  if p_fields is not null and jsonb_typeof(p_fields) not in ('array', 'null') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'fields must be an array')); end if;
  if p_uncertain is not null and jsonb_typeof(p_uncertain) not in ('array', 'null') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'uncertain must be an array')); end if;
  if exists (select 1 from core.receipts where app = coalesce(v_target, p_app) and actor_id = p_actor and request_id = p_request_id) then
    perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id, 'reason', 'already committed'));
  end if;
  select * into v_prop from core.proposals where app = p_app and user_id = p_actor and request_id = p_request_id;
  if v_prop.id is not null then
    if v_prop.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return core.proposal_json(v_prop);
  end if;
  -- Ensayo: en la propia app, como el agente; en otra app, como el decisor o un owner de la app destino (el agente no entra allí).
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
  return core.proposal_json(v_prop);
end $$;

-- La de 7 argumentos delega en la nueva.
create or replace function core.proposal_prepare(p_app text, p_actor uuid, p_key uuid, p_request_id text, p_digest text, p_operations jsonb, p_risk jsonb)
returns jsonb language sql as $$
  select core.proposal_prepare(p_app, p_actor, p_key, p_request_id, p_digest, p_operations, p_risk, null, null, null, null, null)
$$;

-- Decide un owner humano de la app efectiva o el decisor nombrado. Si la propuesta apunta a otra app, aprobar la APLICA en el acto
-- (el decisor es el actor del lote; requestId `proposal:<id>`), y queda `consumed`.
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
  -- Otra app: se aplica ya, como el decisor (sus permisos acotan el lote), origen servidor.
  update core.proposals set status = 'approved', decided_by = p_actor, decided_at = now() where id = p_id;
  perform set_config('core.origin', 'server', true);
  v_result := core.commit(v_eff, p_actor, 'proposal:' || p_id::text, v_prop.digest, null, v_prop.operations, null);
  update core.proposals set status = 'consumed', consumed_cursor = (v_result->>'cursor')::bigint where id = p_id returning * into v_prop;
  perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_approved', jsonb_build_object('proposalId', p_id, 'applied', true, 'cursor', v_result->'cursor', 'authorUserId', v_prop.user_id));
  perform core.log_access(v_eff, p_actor, v_prop.key_id, 'proposal_consumed', jsonb_build_object('proposalId', p_id, 'cursor', v_result->'cursor'));
  return core.proposal_json(v_prop) || jsonb_build_object('applied', true, 'cursor', v_result->'cursor');
end $$;

/** Decide de golpe todas las pendientes de un grupo en la app (las que p_actor puede decidir). Devuelve el resumen y cada propuesta. */
create or replace function core.proposal_decide_group(p_app text, p_actor uuid, p_group_key text, p_decision text)
returns jsonb language plpgsql as $$
declare r record; v_items jsonb := '[]'::jsonb; v_one jsonb; v_ok int := 0; v_auto int := 0; v_skipped int := 0;
begin
  if p_group_key is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'groupKey required')); end if;
  if (select kind from core.profiles where user_id = p_actor) = 'agent' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents cannot decide proposals')); end if;
  if not exists (select 1 from core.memberships m where m.app = p_app and m.user_id = p_actor and m.role = 'owner')
     and not exists (select 1 from core.proposals q where (q.app = p_app or q.target_app = p_app) and q.group_key = p_group_key and q.decider_user_id = p_actor) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners or the named decider decide proposals'));
  end if;
  for r in select p.id from core.proposals p where (p.app = p_app or p.target_app = p_app) and p.group_key = p_group_key and p.status = 'pending' and p.expires_at >= now() order by p.created_at
  loop
    begin
      v_one := core.proposal_decide(p_app, p_actor, r.id, p_decision);
      if coalesce((v_one->>'autoRejected')::boolean, false) then v_auto := v_auto + 1; else v_ok := v_ok + 1; end if;
      v_items := v_items || v_one;
    exception when others then
      if sqlstate !~ '^PT' then raise; end if;
      v_skipped := v_skipped + 1;
      v_items := v_items || jsonb_build_object('id', r.id, 'skipped', true, 'reason', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('groupKey', p_group_key, 'decision', p_decision, 'decided', v_ok, 'autoRejected', v_auto, 'skipped', v_skipped, 'items', v_items);
end $$;

-- Listado y lectura: owners de la app efectiva, el decisor nombrado y el agente autor.
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
  return (select coalesce(jsonb_agg(core.proposal_json(p) order by p.created_at desc), '[]'::jsonb) from core.proposals p where p.id in (
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
  return core.proposal_json(v_prop);
end $$;

create or replace function public.core_proposal_prepare(p_app text, p_actor uuid, p_key uuid, p_request_id text, p_digest text, p_operations jsonb, p_risk jsonb,
  p_target_app text, p_decider uuid, p_fields jsonb, p_group_key text, p_uncertain jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.proposal_prepare(p_app, p_actor, p_key, p_request_id, p_digest, p_operations, p_risk, p_target_app, p_decider, p_fields, p_group_key, p_uncertain) $$;
create or replace function public.core_proposal_decide_group(p_app text, p_actor uuid, p_group_key text, p_decision text) returns jsonb
language sql security definer set search_path = '' as $$ select core.proposal_decide_group(p_app, p_actor, p_group_key, p_decision) $$;

revoke all on function public.core_proposal_prepare(text, uuid, uuid, text, text, jsonb, jsonb, text, uuid, jsonb, text, jsonb), public.core_proposal_decide_group(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.core_proposal_prepare(text, uuid, uuid, text, text, jsonb, jsonb, text, uuid, jsonb, text, jsonb), public.core_proposal_decide_group(text, uuid, text, text) to service_role;
