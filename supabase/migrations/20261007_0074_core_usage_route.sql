-- Ikisai Core · uso: pista de ruta por función para «Ir al sitio» (petición de UI, kit 0.17).
alter table core.usage_features add column if not exists route_hint text check (route_hint is null or char_length(route_hint) <= 200);

create or replace function core.usage_batch(p_app text, p_actor uuid, p_device uuid, p_items jsonb)
returns jsonb language plpgsql as $$
declare
  v_kind text; v_member core.memberships; v_item jsonb; v_feature text; v_actor text; v_user uuid; v_context text; v_day date; v_n int := 0;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  select * into v_member from core.memberships where app = p_app and user_id = p_actor;
  if v_member.user_id is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  select kind into v_kind from core.profiles where user_id = p_actor;
  if v_kind in ('agent','service') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'usage is recorded for people')); end if;
  if p_device is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'deviceId required')); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'items must be an array of at most 500')); end if;
  v_actor := case p_app when 'organizers' then 'organizer' when 'guests' then 'guest' else 'internal' end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_feature := v_item->>'featureId';
    if v_feature is null or v_feature !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$' or split_part(v_feature, '.', 1) <> p_app then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'featureId must start with the app id', 'featureId', v_feature));
    end if;
    begin v_day := (v_item->>'day')::date; exception when others then v_day := null; end;
    if v_day is null or v_day > (now() at time zone 'Europe/Madrid')::date + 1 or v_day < (now() at time zone 'Europe/Madrid')::date - 14 then continue; end if;
    v_context := coalesce(v_item->>'context', 'production');
    if v_context not in ('production','qa','reviewer') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid context')); end if;
    -- Persona solo para internos en producción con el aviso aceptado; portales, QA y revisor, sin persona.
    v_user := case when v_actor = 'internal' and v_context = 'production' and exists (select 1 from core.usage_consents c where c.user_id = p_actor) then p_actor else v_zero end;
    insert into core.usage_features (feature_id, app, label) values (v_feature, p_app, v_feature) on conflict (feature_id) do nothing;
    -- Pista de ruta para «Ir al sitio» desde el Revisor › Uso: la última pantalla donde se vio (ruta real sin consulta).
    if coalesce(v_item->>'route', '') <> '' then
      update core.usage_features set route_hint = left(split_part(v_item->>'route', '?', 1), 200) where feature_id = v_feature and route_hint is distinct from left(split_part(v_item->>'route', '?', 1), 200);
    end if;
    insert into core.usage_daily as d (day, feature_id, generation, actor, context, user_key, device_id, exposures, activations, successes, errors,
      sessions_exposed, sessions_activated, sessions_succeeded, repeated_attempts)
    values (v_day, v_feature, greatest(1, least(coalesce((v_item->>'generation')::int, 1), 999)), v_actor, v_context, v_user, p_device,
      least(greatest(coalesce((v_item->>'exposures')::int, 0), 0), 100000), least(greatest(coalesce((v_item->>'activations')::int, 0), 0), 100000),
      least(greatest(coalesce((v_item->>'successes')::int, 0), 0), 100000), least(greatest(coalesce((v_item->>'errors')::int, 0), 0), 100000),
      least(greatest(coalesce((v_item->>'sessionsExposed')::int, 0), 0), 10000), least(greatest(coalesce((v_item->>'sessionsActivated')::int, 0), 0), 10000),
      least(greatest(coalesce((v_item->>'sessionsSucceeded')::int, 0), 0), 10000), least(greatest(coalesce((v_item->>'repeatedAttempts')::int, 0), 0), 100000))
    on conflict (day, feature_id, generation, actor, context, user_key, device_id) do update set
      exposures = greatest(d.exposures, excluded.exposures), activations = greatest(d.activations, excluded.activations),
      successes = greatest(d.successes, excluded.successes), errors = greatest(d.errors, excluded.errors),
      sessions_exposed = greatest(d.sessions_exposed, excluded.sessions_exposed), sessions_activated = greatest(d.sessions_activated, excluded.sessions_activated),
      sessions_succeeded = greatest(d.sessions_succeeded, excluded.sessions_succeeded), repeated_attempts = greatest(d.repeated_attempts, excluded.repeated_attempts),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('accepted', v_n);
end $$;

create or replace function core.usage_feature_stats(p_feature core.usage_features, p_teams jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_today date := (now() at time zone 'Europe/Madrid')::date; v_targets uuid[] := '{}'; v_team text; v_has_audience boolean;
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  s record; v_activity numeric; v_age int; v_insight text; v_ever boolean; v_last date;
begin
  for v_team in select jsonb_array_elements_text(coalesce(p_feature.audience->'teams', '[]'::jsonb)) loop
    v_targets := v_targets || coalesce((select array_agg(u::uuid) from jsonb_array_elements_text(coalesce(p_teams->v_team->'users', '[]'::jsonb)) u), '{}');
  end loop;
  v_targets := v_targets || coalesce((select array_agg(u::uuid) from jsonb_array_elements_text(coalesce(p_feature.audience->'people', '[]'::jsonb)) u), '{}');
  v_has_audience := array_length(v_targets, 1) is not null;

  select
    coalesce(sum(exposures) filter (where context = 'production'), 0) exp, coalesce(sum(activations) filter (where context = 'production'), 0) act,
    coalesce(sum(successes) filter (where context = 'production'), 0) succ, coalesce(sum(errors) filter (where context = 'production'), 0) err,
    coalesce(sum(exposures) filter (where context = 'production' and user_key = any (v_targets)), 0) t_exp,
    coalesce(sum(activations) filter (where context = 'production' and user_key = any (v_targets)), 0) t_act,
    coalesce(sum(exposures) filter (where context = 'production' and actor = 'internal' and user_key <> v_zero and not (user_key = any (v_targets))), 0) o_exp,
    coalesce(sum(activations) filter (where context = 'production' and actor = 'internal' and user_key <> v_zero and not (user_key = any (v_targets))), 0) o_act,
    coalesce(sum(activations) filter (where context in ('qa','reviewer')), 0) qa_act
  into s from core.usage_daily where feature_id = p_feature.feature_id and generation = p_feature.generation and day > v_today - 30;

  select coalesce(sum(least(a, 5) * power(2, -(v_today - day) / 30.0)), 0) into v_activity
    from (select day, sum(activations) a from core.usage_daily where feature_id = p_feature.feature_id and context = 'production' group by day) x;
  select max(day), bool_or(activations > 0) into v_last, v_ever from core.usage_daily where feature_id = p_feature.feature_id and context = 'production' and activations > 0;
  v_age := (now()::date - p_feature.generation_at::date);

  v_insight := case
    when not p_feature.active and p_feature.catalogued and v_last is not null and v_last > v_today - 30 then 'ORPHANED_USAGE_ID'
    when not p_feature.catalogued and v_last is not null then 'ORPHANED_USAGE_ID'
    when p_feature.frequency = 'do_not_evaluate' or p_feature.decision = 'do_not_evaluate' then 'NOT_EVALUATED'
    when p_feature.decision in ('keep','review_later') and coalesce(p_feature.review_after, v_today) > v_today then 'KEPT'
    when v_age < 14 then 'NEW'
    when v_has_audience and s.t_exp = 0 and s.o_exp > 0 then 'TARGET_CANNOT_REACH_FEATURE'
    when v_has_audience and s.t_exp >= 20 and s.t_act = 0 then 'TARGET_NOT_ADOPTING'
    when v_has_audience and s.o_act >= 10 and s.o_act > 5 * greatest(s.t_act, 1) then 'USED_BY_WRONG_AUDIENCE'
    when s.exp = 0 and p_feature.frequency = 'rare_critical' then 'RARE_AS_EXPECTED'
    when s.exp = 0 then 'POSSIBLY_INACCESSIBLE'
    when s.exp >= 20 and s.act = 0 then 'IGNORED'
    when s.act >= 10 and (s.succ + s.err) > 0 and s.err::numeric / greatest(s.act, 1) > 0.2 then 'HIGH_ERROR'
    when s.act >= 10 and (s.succ + s.err) > 0 and s.succ::numeric / greatest(s.act, 1) < 0.6 then 'FRICTION'
    when coalesce(v_ever, false) and v_last < v_today - 60 and p_feature.frequency not in ('rare_critical','occasional') then 'DORMANT'
    when v_activity >= 20 then 'HIGH_ACTIVITY'
    else 'HEALTHY' end;

  return jsonb_build_object('featureId', p_feature.feature_id, 'app', p_feature.app, 'label', p_feature.label, 'kind', p_feature.kind, 'parent', p_feature.parent_id,
    'active', p_feature.active, 'catalogued', p_feature.catalogued, 'insight', v_insight, 'audience', p_feature.audience, 'frequency', p_feature.frequency,
    'decision', p_feature.decision, 'reviewAfter', p_feature.review_after, 'generation', p_feature.generation, 'generationRelease', p_feature.generation_release,
    'introducedRelease', p_feature.introduced_release, 'removedRelease', p_feature.removed_release,
    'routeRaw', p_feature.route_hint,
    'activity', case when v_activity >= 20 then 'alta' when v_activity >= 5 then 'media' when v_activity > 0.5 then 'baja' else 'dormida' end,
    'last30', jsonb_build_object('exposures', s.exp, 'activations', s.act, 'successes', s.succ, 'errors', s.err,
       'target', jsonb_build_object('exposures', s.t_exp, 'activations', s.t_act), 'others', jsonb_build_object('exposures', s.o_exp, 'activations', s.o_act),
       'qaActivations', s.qa_act),
    'lastProductiveUse', v_last,
    'feedback', jsonb_build_object(
      'open', (select count(*) from core.feedback_reports r where r.node_id = p_feature.feature_id and r.status = 'open'),
      'pendingVerify', (select count(*) from core.feedback_reports r where r.node_id = p_feature.feature_id and r.status = 'open' and core.feedback_display(r) = 'pending_verify')));
end $$;

do $$
declare f text;
begin
  for f in select 'core.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'core' and p.proname in ('usage_batch','usage_feature_stats') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
