-- Ikisai Core · uso semántico de funcionalidades: perspectiva «Uso» del Revisor de QA (coordinacion/ampliacion/USO.md,
-- aprobado por el usuario el 7-10-2026). Solo agregados diarios: nunca un evento por clic.
-- El catálogo sale del código al compilar (lo sube la publicación). La audiencia, la frecuencia y las decisiones las pone el
-- dueño del ecosistema desde el Revisor. Detalle por persona solo de internos que aceptaron el aviso, durante 180 días.

create table core.usage_features (
  feature_id text primary key check (feature_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$'),
  app text not null references core.apps(id),
  label text not null default '',
  kind text,
  parent_id text,
  catalogued boolean not null default false,          -- declarada por una versión publicada (false: solo vista por telemetría)
  active boolean not null default false,
  introduced_release text,
  last_seen_release text,
  removed_release text,
  generation smallint not null default 1,
  generation_release text,
  generation_at timestamptz not null default now(),
  audience jsonb not null default '{"teams": [], "people": []}'::jsonb,
  frequency text not null default 'normal' check (frequency in ('frequent','normal','occasional','rare_critical','do_not_evaluate')),
  decision text check (decision in ('keep','review_later','do_not_evaluate')),
  decision_reason text,
  review_after date,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index usage_features_app_idx on core.usage_features (app, active);

-- Totales del día por dispositivo: el servidor guarda el máximo (reintentos y envíos repetidos sin red no cuentan dos veces).
-- user_key = id de la persona solo para internos en producción que aceptaron el aviso; si no, el uuid cero.
create table core.usage_daily (
  day date not null,
  feature_id text not null,
  generation smallint not null,
  actor text not null check (actor in ('internal','guest','organizer','agent')),
  context text not null check (context in ('production','qa','reviewer')),
  user_key uuid not null default '00000000-0000-0000-0000-000000000000',
  device_id uuid not null,
  exposures integer not null default 0, activations integer not null default 0, successes integer not null default 0, errors integer not null default 0,
  sessions_exposed integer not null default 0, sessions_activated integer not null default 0, sessions_succeeded integer not null default 0,
  repeated_attempts integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, feature_id, generation, actor, context, user_key, device_id)
);
create index usage_daily_feature_idx on core.usage_daily (feature_id, day);
create index usage_daily_user_idx on core.usage_daily (user_key, day) where user_key <> '00000000-0000-0000-0000-000000000000';

create table core.usage_consents (
  user_id uuid primary key references auth.users(id) on delete cascade,
  consented_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['usage_features','usage_daily','usage_consents'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('revoke all on core.%I from public, anon, authenticated', t);
    execute format('grant all on core.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Escritura desde las apps
-- ---------------------------------------------------------------------------

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

create or replace function core.usage_consent(p_actor uuid, p_accept boolean)
returns jsonb language plpgsql as $$
declare v_at timestamptz;
begin
  if p_accept then
    insert into core.usage_consents (user_id) values (p_actor) on conflict (user_id) do nothing;
  end if;
  select consented_at into v_at from core.usage_consents where user_id = p_actor;
  return jsonb_build_object('consentedAt', v_at);
end $$;

-- ---------------------------------------------------------------------------
-- Catálogo (lo sube la publicación) y generaciones
-- ---------------------------------------------------------------------------

create or replace function core.usage_catalog_ingest(p_app text, p_release text, p_features jsonb)
returns jsonb language plpgsql as $$
declare v jsonb; v_ids text[] := '{}'; v_new int := 0; v_removed int;
begin
  if not exists (select 1 from core.apps where id = p_app) then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  if jsonb_typeof(p_features) <> 'array' or jsonb_array_length(p_features) > 5000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'features must be an array')); end if;
  for v in select * from jsonb_array_elements(p_features) loop
    if coalesce(v->>'id', '') !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$' or split_part(v->>'id', '.', 1) <> p_app then continue; end if;
    v_ids := v_ids || (v->>'id');
    insert into core.usage_features (feature_id, app, label, kind, parent_id, catalogued, active, introduced_release, last_seen_release, generation_release)
    values (v->>'id', p_app, left(coalesce(nullif(v->>'label', ''), v->>'id'), 120), left(v->>'kind', 20), left(v->>'parent', 120), true, true, p_release, p_release, p_release)
    on conflict (feature_id) do update set label = left(coalesce(nullif(excluded.label, ''), core.usage_features.label), 120), kind = excluded.kind,
      parent_id = excluded.parent_id, catalogued = true, active = true, removed_release = null, last_seen_release = p_release,
      introduced_release = coalesce(core.usage_features.introduced_release, p_release), updated_at = now();
    if not found then v_new := v_new + 1; end if;
  end loop;
  update core.usage_features set active = false, removed_release = p_release, updated_at = now()
   where app = p_app and catalogued and active and not (feature_id = any (v_ids));
  get diagnostics v_removed = row_count;
  return jsonb_build_object('features', array_length(v_ids, 1), 'removed', v_removed);
end $$;

create or replace function core.usage_bump_generation(p_features text[], p_release text)
returns integer language plpgsql as $$
declare v_n int;
begin
  update core.usage_features set generation = generation + 1, generation_release = left(p_release, 80), generation_at = now(), updated_at = now()
   where feature_id = any (p_features);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Revisor › Uso (solo el dueño del ecosistema). p_teams: {team_id: {name, users: [uuid]}} desde la proyección de Central.
-- ---------------------------------------------------------------------------

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
    'activity', case when v_activity >= 20 then 'alta' when v_activity >= 5 then 'media' when v_activity > 0.5 then 'baja' else 'dormida' end,
    'last30', jsonb_build_object('exposures', s.exp, 'activations', s.act, 'successes', s.succ, 'errors', s.err,
       'target', jsonb_build_object('exposures', s.t_exp, 'activations', s.t_act), 'others', jsonb_build_object('exposures', s.o_exp, 'activations', s.o_act),
       'qaActivations', s.qa_act),
    'lastProductiveUse', v_last,
    'feedback', jsonb_build_object(
      'open', (select count(*) from core.feedback_reports r where r.node_id = p_feature.feature_id and r.status = 'open'),
      'pendingVerify', (select count(*) from core.feedback_reports r where r.node_id = p_feature.feature_id and r.status = 'open' and core.feedback_display(r) = 'pending_verify')));
end $$;

create or replace function core.usage_review(p_actor uuid, p_app text, p_teams jsonb)
returns jsonb language plpgsql stable as $$
begin
  if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'usage review is for the ecosystem owner')); end if;
  return coalesce((select jsonb_agg(core.usage_feature_stats(f, coalesce(p_teams, '{}'::jsonb)) order by f.app, f.feature_id)
    from core.usage_features f where (p_app is null or p_app = 'all' or f.app = p_app) and (f.active or not f.catalogued)), '[]'::jsonb);
end $$;

create or replace function core.usage_feature_detail(p_actor uuid, p_feature text, p_teams jsonb)
returns jsonb language plpgsql stable as $$
declare f core.usage_features; v_today date := (now() at time zone 'Europe/Madrid')::date; v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'usage review is for the ecosystem owner')); end if;
  select * into f from core.usage_features where feature_id = p_feature;
  if f.feature_id is null then perform core.fail('NOT_FOUND', 404); end if;
  return core.usage_feature_stats(f, coalesce(p_teams, '{}'::jsonb)) || jsonb_build_object(
    'byPerson', coalesce((select jsonb_agg(jsonb_build_object('userId', d.user_key, 'name', coalesce(nullif(p.display_name, ''), 'Sin nombre'),
        'exposures', d.e, 'activations', d.a, 'successes', d.s, 'errors', d.x, 'lastUse', d.last) order by d.a desc)
      from (select user_key, sum(exposures) e, sum(activations) a, sum(successes) s, sum(errors) x, max(day) filter (where activations > 0) last
              from core.usage_daily where feature_id = f.feature_id and context = 'production' and actor = 'internal' and user_key <> v_zero and day > v_today - 30
             group by user_key) d left join core.profiles p on p.user_id = d.user_key), '[]'::jsonb),
    'unattributed', (select jsonb_build_object('exposures', coalesce(sum(exposures), 0), 'activations', coalesce(sum(activations), 0))
       from core.usage_daily where feature_id = f.feature_id and context = 'production' and user_key = v_zero and day > v_today - 30),
    'byContext', coalesce((select jsonb_object_agg(context, a) from (select context, sum(activations) a from core.usage_daily
       where feature_id = f.feature_id and day > v_today - 30 group by context) c), '{}'::jsonb));
end $$;

create or replace function core.usage_decide(p_actor uuid, p_feature text, p_args jsonb)
returns jsonb language plpgsql as $$
declare f core.usage_features;
begin
  if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'usage review is for the ecosystem owner')); end if;
  select * into f from core.usage_features where feature_id = p_feature for update;
  if f.feature_id is null then perform core.fail('NOT_FOUND', 404); end if;
  if p_args ? 'decision' and coalesce(p_args->>'decision', 'clear') not in ('keep','review_later','do_not_evaluate','clear') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid decision'));
  end if;
  if p_args ? 'frequency' and p_args->>'frequency' not in ('frequent','normal','occasional','rare_critical','do_not_evaluate') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid frequency'));
  end if;
  update core.usage_features set
    decision = case when p_args ? 'decision' then nullif(p_args->>'decision', 'clear') else decision end,
    decision_reason = case when p_args ? 'decision' then left(p_args->>'reason', 500) else decision_reason end,
    review_after = case when p_args ? 'decision' then (p_args->>'reviewAfter')::date else review_after end,
    decided_by = case when p_args ? 'decision' then p_actor else decided_by end,
    decided_at = case when p_args ? 'decision' then now() else decided_at end,
    frequency = coalesce(p_args->>'frequency', frequency),
    audience = case when p_args ? 'audience' then jsonb_build_object('teams', coalesce(p_args->'audience'->'teams', '[]'::jsonb), 'people', coalesce(p_args->'audience'->'people', '[]'::jsonb)) else audience end,
    generation = case when coalesce((p_args->>'newGeneration')::boolean, false) then generation + 1 else generation end,
    generation_at = case when coalesce((p_args->>'newGeneration')::boolean, false) then now() else generation_at end,
    updated_at = now()
  where feature_id = p_feature returning * into f;
  return to_jsonb(f) - 'decided_by';
end $$;

-- Retención: el detalle por persona dura 180 días; después se agrega sin persona ni dispositivo (pg_cron mensual).
create or replace function core.usage_anonymize()
returns integer language plpgsql as $$
declare v_zero constant uuid := '00000000-0000-0000-0000-000000000000'; v_cut date := (now() at time zone 'Europe/Madrid')::date - 180; v_n int;
begin
  insert into core.usage_daily as d (day, feature_id, generation, actor, context, user_key, device_id, exposures, activations, successes, errors,
    sessions_exposed, sessions_activated, sessions_succeeded, repeated_attempts)
  select day, feature_id, generation, actor, context, v_zero, v_zero, sum(exposures), sum(activations), sum(successes), sum(errors),
         sum(sessions_exposed), sum(sessions_activated), sum(sessions_succeeded), sum(repeated_attempts)
    from core.usage_daily where day < v_cut and (user_key <> v_zero or device_id <> v_zero)
   group by day, feature_id, generation, actor, context
  on conflict (day, feature_id, generation, actor, context, user_key, device_id) do update set
    exposures = d.exposures + excluded.exposures, activations = d.activations + excluded.activations, successes = d.successes + excluded.successes,
    errors = d.errors + excluded.errors, sessions_exposed = d.sessions_exposed + excluded.sessions_exposed,
    sessions_activated = d.sessions_activated + excluded.sessions_activated, sessions_succeeded = d.sessions_succeeded + excluded.sessions_succeeded,
    repeated_attempts = d.repeated_attempts + excluded.repeated_attempts;
  delete from core.usage_daily where day < v_cut and (user_key <> v_zero or device_id <> v_zero);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- Envoltorios para la Edge y la publicación (service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_usage_batch(p_app text, p_actor uuid, p_device uuid, p_items jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.usage_batch(p_app, p_actor, p_device, p_items) $$;
create or replace function public.core_usage_consent(p_actor uuid, p_accept boolean) returns jsonb
language sql security definer set search_path = '' as $$ select core.usage_consent(p_actor, p_accept) $$;
create or replace function public.core_usage_review(p_actor uuid, p_app text, p_teams jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.usage_review(p_actor, p_app, p_teams) $$;
create or replace function public.core_usage_feature_detail(p_actor uuid, p_feature text, p_teams jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.usage_feature_detail(p_actor, p_feature, p_teams) $$;
create or replace function public.core_usage_decide(p_actor uuid, p_feature text, p_args jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.usage_decide(p_actor, p_feature, p_args) $$;

do $$
declare f text;
begin
  for f in select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname = 'core' and p.proname like 'usage\_%') or (n.nspname = 'public' and p.proname like 'core\_usage\_%') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-usage-anonymize', '23 4 1 * *', $c$select core.usage_anonymize()$c$)$q$;
  end if;
end $$;
