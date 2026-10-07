-- Ikisai Core · feedback: filtro del usuario y modo «Revisor de QA» (FEEDBACK.md §9, aprobado el 7-10-2026).
-- Los reportes de aplicación entran como «nuevos» y solo llegan a los agentes cuando el dueño del ecosistema los aprueba.
-- La ruta real (con ids técnicos, sin consulta) se guarda aparte para llevar al revisor a la pantalla exacta.

alter table core.feedback_reports
  add column review_status text not null default 'approved' check (review_status in ('new','approved','rejected')),
  add column reviewed_by uuid references auth.users(id),
  add column reviewed_at timestamptz,
  add column merged_into uuid references core.feedback_reports(id) on delete set null,
  add column route_raw text check (route_raw is null or char_length(route_raw) <= 300);
create index feedback_reports_review_idx on core.feedback_reports (created_at) where review_status = 'new' and status = 'open';

-- Al crear: los de aplicación esperan revisión; lo operativo no. La ruta real sale del contexto y no se queda en él.
create or replace function core.feedback_before_insert()
returns trigger language plpgsql as $$
begin
  new.review_status := case when new.subject = 'application' then 'new' else 'approved' end;
  if new.context ? 'routeRaw' then
    new.route_raw := left(nullif(split_part(new.context->>'routeRaw', '?', 1), ''), 300);
    new.context := new.context - 'routeRaw';
  end if;
  return new;
end $$;
create trigger feedback_before_insert before insert on core.feedback_reports for each row execute function core.feedback_before_insert();
-- Los de aplicación ya abiertos (pruebas del usuario) pasan a revisión.
update core.feedback_reports set review_status = 'new' where subject = 'application' and status = 'open';

create or replace function core.feedback_json(p_report core.feedback_reports, p_actor uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p_report.id, 'code', p_report.code, 'originApp', p_report.origin_app, 'reporterKind', p_report.reporter_kind,
    'subject', p_report.subject, 'intent', p_report.intent, 'blocking', p_report.blocking, 'message', p_report.message,
    'node', jsonb_build_object('id', p_report.node_id, 'path', p_report.node_path, 'meta', p_report.node_meta),
    'scope', p_report.scope, 'category', p_report.category, 'status', p_report.status, 'display', core.feedback_display(p_report),
    'destination', p_report.destination, 'routingStatus', p_report.routing_status, 'supportersCount', p_report.supporters_count,
    'supported', exists (select 1 from core.feedback_supporters s where s.report_id = p_report.id and s.user_id = p_actor),
    'mine', p_report.reporter_user_id = p_actor, 'canManage', core.feedback_can_manage(p_report, p_actor),
    'canVerify', p_report.reporter_user_id = p_actor or core.feedback_can_manage(p_report, p_actor),
    'reviewStatus', p_report.review_status, 'mergedInto', (select m.code from core.feedback_reports m where m.id = p_report.merged_into),
    'routeRaw', case when p_report.reporter_user_id = p_actor or core.feedback_is_ecosystem_owner(p_actor) then p_report.route_raw end,
    'releasedBuild', p_report.released_build, 'reopenCount', p_report.reopen_count, 'createdAt', p_report.created_at,
    'verifiedAt', p_report.verified_at, 'verifiedBuild', p_report.verified_build, 'dismissReason', p_report.dismiss_reason)
$$;

create or replace function core.feedback_list(p_app text, p_actor uuid, p_filters jsonb)
returns jsonb language plpgsql stable as $$
declare v_review boolean := coalesce((p_filters->>'review')::boolean, false); v_limit int := least(greatest(coalesce((p_filters->>'limit')::int, 100), 1), 500); v_status text := coalesce(p_filters->>'status', 'open');
begin
  if v_review and not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'reviewer is the ecosystem owner')); end if;
  if v_review then v_status := 'all'; end if;
  return coalesce((select jsonb_agg(core.feedback_json(s.r, p_actor) order by (s.r).blocking desc, (s.r).created_at desc)
    from (select r from core.feedback_reports r
           where core.feedback_can_see(r, p_actor)
             and (p_filters->>'app' is null or p_filters->>'app' = 'all' or r.origin_app = p_filters->>'app')
             and (p_filters->>'node' is null or r.node_id = p_filters->>'node')
             and (coalesce((p_filters->>'mine')::boolean, false) = false or r.reporter_user_id = p_actor)
             and (v_status = 'all' or core.feedback_display(r) = v_status or (v_status = 'open' and core.feedback_display(r) in ('open','in_progress')))
             and (coalesce((p_filters->>'review')::boolean, false) = false
                  or (r.status = 'open' and (r.review_status = 'new' or core.feedback_display(r) = 'pending_verify')))
             and (coalesce((p_filters->>'pin')::boolean, false) = false or r.reporter_user_id = p_actor or core.feedback_is_ecosystem_owner(p_actor))
           order by r.blocking desc, r.created_at desc limit v_limit) s), '[]'::jsonb);
end $$;

create or replace function core.feedback_act(p_actor uuid, p_id uuid, p_action text, p_args jsonb)
returns jsonb language plpgsql as $$
declare v core.feedback_reports; v_target core.feedback_reports;
begin
  select * into v from core.feedback_reports where id = p_id for update;
  if v.id is null or not core.feedback_can_see(v, p_actor) then perform core.fail('OUT_OF_SCOPE', 404); end if;
  if p_action = 'support' then
    if v.reporter_kind <> 'internal' or not core.feedback_is_internal(p_actor) then perform core.fail('FORBIDDEN', 403); end if;
    insert into core.feedback_supporters (report_id, user_id) values (v.id, p_actor) on conflict do nothing;
    update core.feedback_reports set supporters_count = (select count(*) from core.feedback_supporters where report_id = v.id), updated_at = now() where id = v.id returning * into v;
  elsif p_action = 'verify' then
    if not (v.reporter_user_id = p_actor or core.feedback_can_manage(v, p_actor)) then perform core.fail('FORBIDDEN', 403); end if;
    if v.status <> 'open' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'report is not open')); end if;
    update core.feedback_reports set status = 'verified', verified_at = now(), verified_by = p_actor, closed_at = now(), updated_at = now(),
      verified_build = coalesce(nullif(p_args->>'build', ''), v.released_build) where id = v.id returning * into v;
  elsif p_action = 'reopen' then
    if not (v.reporter_user_id = p_actor or core.feedback_can_manage(v, p_actor)) then perform core.fail('FORBIDDEN', 403); end if;
    if v.status = 'dismissed' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'report is dismissed')); end if;
    update core.feedback_reports set status = 'open', released_at = null, released_build = null, verified_at = null, verified_by = null, verified_build = null,
      closed_at = null, reopen_count = reopen_count + 1, updated_at = now(),
      message = case when coalesce(p_args->>'message', '') = '' then message else left(message || E'\n\n— Sigue fallando: ' || (p_args->>'message'), 4000) end,
      routing_status = case when destination = 'operations' or exists (select 1 from core.feedback_task_links l where l.report_id = v.id) then 'pending' else routing_status end,
      next_routing_at = case when destination = 'operations' or exists (select 1 from core.feedback_task_links l where l.report_id = v.id) then now() else next_routing_at end
     where id = v.id returning * into v;
  elsif p_action = 'approve' then
    if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'reviewer is the ecosystem owner')); end if;
    if v.status <> 'open' or v.review_status <> 'new' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'report is not waiting for review')); end if;
    update core.feedback_reports set review_status = 'approved', reviewed_by = p_actor, reviewed_at = now(), updated_at = now() where id = v.id returning * into v;
  elsif p_action = 'merge' then
    if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'reviewer is the ecosystem owner')); end if;
    select * into v_target from core.feedback_reports where code = upper(coalesce(p_args->>'into', ''));
    if v_target.id is null or v_target.id = v.id or v_target.status <> 'open' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'target must be another open report')); end if;
    insert into core.feedback_supporters (report_id, user_id) values (v_target.id, v.reporter_user_id) on conflict do nothing;
    update core.feedback_reports set supporters_count = (select count(*) from core.feedback_supporters where report_id = v_target.id), updated_at = now() where id = v_target.id;
    update core.feedback_reports set status = 'dismissed', review_status = case when review_status = 'new' then 'rejected' else review_status end, merged_into = v_target.id,
      dismissed_at = now(), dismissed_by = p_actor, dismiss_reason = 'Unido a ' || v_target.code, closed_at = now(), reviewed_by = p_actor, reviewed_at = now(), updated_at = now()
     where id = v.id returning * into v;
  elsif p_action = 'dismiss' then
    if not core.feedback_can_manage(v, p_actor) then perform core.fail('FORBIDDEN', 403); end if;
    update core.feedback_reports set status = 'dismissed', review_status = case when review_status = 'new' then 'rejected' else review_status end,
      reviewed_by = case when review_status = 'new' then p_actor else reviewed_by end, reviewed_at = case when review_status = 'new' then now() else reviewed_at end,
      dismissed_at = now(), dismissed_by = p_actor, dismiss_reason = left(coalesce(p_args->>'reason', ''), 500),
      closed_at = now(), routing_status = case when routing_status in ('pending','error') then 'none' else routing_status end, updated_at = now()
     where id = v.id returning * into v;
  else
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown action'));
  end if;
  return core.feedback_json(v, p_actor);
end $$;

do $$
declare f text;
begin
  for f in select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'core' and p.proname in ('feedback_json','feedback_list','feedback_act','feedback_before_insert') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
