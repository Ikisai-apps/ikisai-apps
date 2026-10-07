-- Ikisai Core · feedback y QA transversal (coordinacion/ampliacion/FEEDBACK.md, contrato §3.7).
-- El reporte guarda la observación; Tasks solo recibe el trabajo operativo (espacio y retiro). Los fallos de aplicación se
-- quedan en la vista de QA y en el buzón de cada agente (decisión del usuario, 7-10-2026).
-- Sin FK a tablas de apps: `scope` lleva solo ids. Las imágenes van en core.files, bucket privado `feedback-media`.

create table core.feedback_reports (
  id uuid primary key,                                         -- lo genera el cliente: idempotencia
  code text not null unique,                                   -- FB_AAAA_NNN, lo pone el servidor
  request_id text not null,
  digest text not null,                                        -- huella del contenido enviado, para detectar un id reutilizado
  reporter_user_id uuid not null references auth.users(id) on delete cascade,
  reporter_kind text not null check (reporter_kind in ('internal','organizer','guest')),
  origin_app text not null references core.apps(id),
  subject text not null check (subject in ('application','event','space')),
  intent text not null check (intent in ('bug','improvement','idea','problem','suggestion')),
  blocking boolean not null default false,                     -- «Me bloquea»
  node_id text check (node_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){0,7}$'),
  node_path jsonb not null default '[]'::jsonb,
  node_meta jsonb not null default '{}'::jsonb,
  scope jsonb not null default '{}'::jsonb,                    -- reservation_id, guest_id, space_id: solo ids
  category text,
  message text not null check (char_length(message) between 1 and 4000),
  context jsonb not null default '{}'::jsonb,                  -- lista blanca técnica (la limpia la Edge), ≤ 8 KB
  source_route text,
  destination text not null check (destination in ('qa','organizer','operations')),
  routing_status text not null check (routing_status in ('none','pending','routed','error')),
  routing_error text,
  routing_attempts integer not null default 0,
  next_routing_at timestamptz,
  status text not null default 'open' check (status in ('open','verified','dismissed')),
  released_build text,                                         -- versión publicada que dice arreglarlo (código FB en el PR)
  released_at timestamptz,
  reopen_count integer not null default 0,
  supporters_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz, verified_by uuid references auth.users(id), verified_build text,
  dismissed_at timestamptz, dismissed_by uuid references auth.users(id), dismiss_reason text,
  closed_at timestamptz,
  check (pg_column_size(context) <= 8192)
);
create index feedback_reports_app_idx on core.feedback_reports (origin_app, status, created_at desc);
create index feedback_reports_node_idx on core.feedback_reports (origin_app, node_id) where status = 'open';
create index feedback_reports_reporter_idx on core.feedback_reports (reporter_user_id, created_at desc);
create index feedback_reports_scope_idx on core.feedback_reports using gin (scope);
create index feedback_reports_routing_idx on core.feedback_reports (next_routing_at) where routing_status in ('pending','error');

create table core.feedback_attachments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references core.feedback_reports(id) on delete cascade,
  file_id uuid not null references core.files(id),
  kind text not null default 'image' check (kind = 'image'),
  created_at timestamptz not null default now(),
  unique (report_id, file_id)
);

create table core.feedback_task_links (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references core.feedback_reports(id) on delete cascade,
  sequence integer not null,
  external_ref text not null unique,                           -- <código>:<secuencia>, idempotencia en Tasks
  task_id uuid,
  task_status text,                                            -- copiado de Tasks por el worker: «hecha» = pendiente de verificar
  task_status_at timestamptz,
  created_at timestamptz not null default now(),
  unique (report_id, sequence)
);

create table core.feedback_supporters (
  report_id uuid not null references core.feedback_reports(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (report_id, user_id)
);

do $$
declare t text;
begin
  foreach t in array array['feedback_reports','feedback_attachments','feedback_task_links','feedback_supporters'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('revoke all on core.%I from public, anon, authenticated', t);
    execute format('grant all on core.%I to service_role', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Reglas
-- ---------------------------------------------------------------------------

-- Dueño del ecosistema: owner de Central. Ve todos los pins de «¿Lo compruebas?» y puede verificar (decisión del usuario).
create or replace function core.feedback_is_ecosystem_owner(p_actor uuid)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships where app = 'central' and user_id = p_actor and role = 'owner')
$$;

create or replace function core.feedback_is_internal(p_actor uuid)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships m join core.apps a on a.id = m.app where m.user_id = p_actor and a.kind is distinct from 'portal')
$$;

-- Quién ve un reporte (FEEDBACK.md §2.8). Fuera de ámbito se trata como inexistente.
create or replace function core.feedback_can_see(p_report core.feedback_reports, p_actor uuid)
returns boolean language sql stable as $$
  select p_report.reporter_user_id = p_actor
    or (p_report.reporter_kind = 'internal' and core.feedback_is_internal(p_actor))
    or (p_report.reporter_kind <> 'internal' and (
          core.feedback_is_ecosystem_owner(p_actor)
          or exists (select 1 from core.memberships where app = 'booking' and user_id = p_actor and role in ('editor','owner'))
          or (exists (select 1 from core.feedback_task_links l where l.report_id = p_report.id)
              and exists (select 1 from core.memberships where app = 'tasks' and user_id = p_actor and role in ('editor','owner')))
          or (p_report.subject = 'event' and exists (
                select 1 from core.memberships m, jsonb_array_elements(case when jsonb_typeof(m.scopes->'grants') = 'array' then m.scopes->'grants' else '[]'::jsonb end) g
                 where m.app = 'organizers' and m.user_id = p_actor and g->>'reservation_id' = p_report.scope->>'reservation_id'))))
$$;

-- Quién gestiona (descartar, verificar, «sigue fallando»): editor u owner de la app de origen, o el dueño del ecosistema.
-- Verificar lo puede hacer además quien lo informó.
create or replace function core.feedback_can_manage(p_report core.feedback_reports, p_actor uuid)
returns boolean language sql stable as $$
  select core.feedback_is_ecosystem_owner(p_actor)
    or exists (select 1 from core.memberships where app = case when p_report.reporter_kind = 'internal' then p_report.origin_app else 'booking' end
                and user_id = p_actor and role in ('editor','owner'))
$$;

create or replace function core.feedback_display(p_report core.feedback_reports)
returns text language sql stable as $$
  select case
    when p_report.status = 'dismissed' then 'dismissed'
    when p_report.status = 'verified' then 'verified'
    when p_report.released_at is not null then 'pending_verify'
    when (select l.task_status from core.feedback_task_links l where l.report_id = p_report.id order by l.sequence desc limit 1) = 'done' then 'pending_verify'
    when exists (select 1 from core.feedback_task_links l where l.report_id = p_report.id) then 'in_progress'
    else 'open' end
$$;

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
    'releasedBuild', p_report.released_build, 'reopenCount', p_report.reopen_count, 'createdAt', p_report.created_at,
    'verifiedAt', p_report.verified_at, 'verifiedBuild', p_report.verified_build, 'dismissReason', p_report.dismiss_reason)
$$;

-- Destino determinista (FEEDBACK.md §4).
create or replace function core.feedback_route(p_subject text, p_reporter_kind text)
returns jsonb language sql immutable as $$
  select case
    when p_subject = 'application' then jsonb_build_object('destination', 'qa', 'routing', 'none')
    when p_subject = 'space' then jsonb_build_object('destination', 'operations', 'routing', 'pending')
    when p_reporter_kind = 'guest' then jsonb_build_object('destination', 'organizer', 'routing', 'none')
    else jsonb_build_object('destination', 'operations', 'routing', 'pending') end
$$;

-- ---------------------------------------------------------------------------
-- Operaciones (las llama la Edge del kit con el actor autenticado)
-- ---------------------------------------------------------------------------

create or replace function core.feedback_create(p_app text, p_actor uuid, p_report jsonb, p_digest text)
returns jsonb language plpgsql as $$
declare
  v_member core.memberships; v_kind text; v_app core.apps; v_existing core.feedback_reports; v_row core.feedback_reports;
  v_route jsonb; v_id uuid; v_att uuid; v_scope jsonb := coalesce(p_report->'scope', '{}'::jsonb); v_grants jsonb; v_key text;
begin
  select * into v_app from core.apps where id = p_app;
  select * into v_member from core.memberships where app = p_app and user_id = p_actor;
  if v_member.user_id is null then perform core.fail('NO_MEMBERSHIP', 403, jsonb_build_object('app', p_app)); end if;
  if exists (select 1 from core.profiles where user_id = p_actor and kind = 'agent') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'agents do not report feedback')); end if;
  v_kind := case p_app when 'organizers' then 'organizer' when 'guests' then 'guest' else 'internal' end;
  begin v_id := (p_report->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id must be a uuid')); end if;

  select * into v_existing from core.feedback_reports where id = v_id;
  if v_existing.id is not null then
    if v_existing.reporter_user_id <> p_actor or v_existing.digest <> p_digest then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('id', v_id)); end if;
    return core.feedback_json(v_existing, p_actor) || jsonb_build_object('replayed', true);
  end if;

  if (select count(*) from core.feedback_reports where reporter_user_id = p_actor and created_at > now() - interval '24 hours') >= 30 then
    perform core.fail('FEEDBACK_RATE_LIMITED', 429, jsonb_build_object('limit', 30, 'window', '24h'));
  end if;
  if jsonb_typeof(v_scope) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'scope must be an object')); end if;
  for v_key in select jsonb_object_keys(v_scope) loop
    if v_key not in ('reservation_id','guest_id','space_id') or coalesce(v_scope->>v_key, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'scope takes only reservation_id, guest_id, space_id uuids', 'key', v_key));
    end if;
  end loop;
  -- Un portal solo informa dentro de su ámbito; el reporte de evento o espacio necesita la reserva.
  if v_kind <> 'internal' then
    v_grants := case when jsonb_typeof(v_member.scopes->'grants') = 'array' then v_member.scopes->'grants' else '[]'::jsonb end;
    if p_report->>'subject' <> 'application' and v_scope->>'reservation_id' is null then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id required'));
    end if;
    if v_scope->>'reservation_id' is not null and not exists (select 1 from jsonb_array_elements(v_grants) g where g->>'reservation_id' = lower(v_scope->>'reservation_id')
         and (v_kind <> 'guest' or v_scope->>'guest_id' is null or g->>'guest_id' = lower(v_scope->>'guest_id'))) then
      perform core.fail('OUT_OF_SCOPE', 404);
    end if;
  end if;
  if jsonb_typeof(coalesce(p_report->'attachmentIds', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_report->'attachmentIds', '[]'::jsonb)) > 3 then
    perform core.fail('FEEDBACK_TOO_MANY_ATTACHMENTS', 422, jsonb_build_object('max', 3));
  end if;

  v_route := core.feedback_route(p_report->>'subject', v_kind);
  insert into core.feedback_reports (id, code, request_id, digest, reporter_user_id, reporter_kind, origin_app, subject, intent, blocking,
    node_id, node_path, node_meta, scope, category, message, context, source_route, destination, routing_status, next_routing_at)
  values (v_id, core.next_code('FB'), p_report->>'requestId', p_digest, p_actor, v_kind, p_app, p_report->>'subject', p_report->>'intent',
    coalesce((p_report->>'blocking')::boolean, false), nullif(p_report->'node'->>'id', ''), coalesce(p_report->'node'->'path', '[]'::jsonb),
    coalesce(p_report->'node'->'meta', '{}'::jsonb), v_scope, nullif(p_report->>'category', ''), p_report->>'message',
    coalesce(p_report->'context', '{}'::jsonb), nullif(p_report->>'sourceRoute', ''), v_route->>'destination', v_route->>'routing',
    case when v_route->>'routing' = 'pending' then now() end)
  returning * into v_row;

  for v_att in select (x)::uuid from jsonb_array_elements_text(coalesce(p_report->'attachmentIds', '[]'::jsonb)) x loop
    if not exists (select 1 from core.files f where f.id = v_att and f.bucket = 'feedback-media' and f.created_by = p_actor and f.status = 'verified') then
      perform core.fail('FEEDBACK_ATTACHMENT_INVALID', 422, jsonb_build_object('fileId', v_att));
    end if;
    insert into core.feedback_attachments (report_id, file_id) values (v_row.id, v_att);
  end loop;
  return core.feedback_json(v_row, p_actor);
end $$;

-- Lista: lo que el actor ve. Filtros: app, node, status (open|pending_verify|verified|dismissed|all), mine, pin (pendientes de
-- verificar que le tocan: suyos o, si es dueño del ecosistema, todos), limit.
create or replace function core.feedback_list(p_app text, p_actor uuid, p_filters jsonb)
returns jsonb language plpgsql stable as $$
declare v_limit int := least(greatest(coalesce((p_filters->>'limit')::int, 100), 1), 500); v_status text := coalesce(p_filters->>'status', 'open');
begin
  return coalesce((select jsonb_agg(core.feedback_json(s.r, p_actor) order by (s.r).blocking desc, (s.r).created_at desc)
    from (select r from core.feedback_reports r
           where core.feedback_can_see(r, p_actor)
             and (p_filters->>'app' is null or r.origin_app = p_filters->>'app')
             and (p_filters->>'node' is null or r.node_id = p_filters->>'node')
             and (coalesce((p_filters->>'mine')::boolean, false) = false or r.reporter_user_id = p_actor)
             and (v_status = 'all' or core.feedback_display(r) = v_status or (v_status = 'open' and core.feedback_display(r) in ('open','in_progress')))
             and (coalesce((p_filters->>'pin')::boolean, false) = false or r.reporter_user_id = p_actor or core.feedback_is_ecosystem_owner(p_actor))
           order by r.blocking desc, r.created_at desc limit v_limit) s), '[]'::jsonb);
end $$;

-- Árbol de «Sugerencias y QA»: nodos con reportes de esa app (solo internos).
create or replace function core.feedback_tree(p_app text, p_actor uuid)
returns jsonb language plpgsql stable as $$
begin
  if not core.feedback_is_internal(p_actor) then perform core.fail('FORBIDDEN', 403); end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', node_id, 'path', path, 'open', open, 'pendingVerify', pending, 'verified', verified, 'total', total) order by node_id)
    from (select coalesce(r.node_id, p_app) node_id, (array_agg(r.node_path order by r.created_at desc))[1] path,
                 count(*) filter (where core.feedback_display(r) in ('open','in_progress')) open,
                 count(*) filter (where core.feedback_display(r) = 'pending_verify') pending,
                 count(*) filter (where r.status = 'verified') verified, count(*) total
            from core.feedback_reports r where r.origin_app = p_app and r.reporter_kind = 'internal' and r.status <> 'dismissed'
           group by coalesce(r.node_id, p_app)) t), '[]'::jsonb);
end $$;

create or replace function core.feedback_get(p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v core.feedback_reports;
begin
  select * into v from core.feedback_reports where id = p_id or code = p_id::text;
  if v.id is null or not core.feedback_can_see(v, p_actor) then perform core.fail('OUT_OF_SCOPE', 404); end if;
  return jsonb_build_object('report', core.feedback_json(v, p_actor), 'context', v.context, 'sourceRoute', v.source_route, 'reporterUserId', v.reporter_user_id,
    'attachments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'fileId', a.file_id, 'bucket', f.bucket, 'path', f.path, 'mime', f.mime) order by a.created_at)
                             from core.feedback_attachments a join core.files f on f.id = a.file_id where a.report_id = v.id), '[]'::jsonb),
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('sequence', l.sequence, 'externalRef', l.external_ref, 'taskId', l.task_id, 'status', l.task_status) order by l.sequence)
                       from core.feedback_task_links l where l.report_id = v.id), '[]'::jsonb));
end $$;

-- Por código (FB_2026_001), para el deep link de Tasks y el script local.
create or replace function core.feedback_get_by_code(p_actor uuid, p_code text)
returns jsonb language plpgsql stable as $$
declare v_id uuid;
begin
  select id into v_id from core.feedback_reports where code = upper(p_code);
  if v_id is null then perform core.fail('OUT_OF_SCOPE', 404); end if;
  return core.feedback_get(p_actor, v_id);
end $$;

create or replace function core.feedback_act(p_actor uuid, p_id uuid, p_action text, p_args jsonb)
returns jsonb language plpgsql as $$
declare v core.feedback_reports;
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
  elsif p_action = 'dismiss' then
    if not core.feedback_can_manage(v, p_actor) then perform core.fail('FORBIDDEN', 403); end if;
    update core.feedback_reports set status = 'dismissed', dismissed_at = now(), dismissed_by = p_actor, dismiss_reason = left(coalesce(p_args->>'reason', ''), 500),
      closed_at = now(), routing_status = case when routing_status in ('pending','error') then 'none' else routing_status end, updated_at = now()
     where id = v.id returning * into v;
  else
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown action'));
  end if;
  return core.feedback_json(v, p_actor);
end $$;

-- ---------------------------------------------------------------------------
-- Enrutado y publicación (worker, pipeline de publicación)
-- ---------------------------------------------------------------------------

-- Reportes que hay que enviar a Tasks: devuelve lo mínimo para la petición (sin datos personales) y reserva la secuencia.
create or replace function core.feedback_routing_claim(p_limit int default 20)
returns jsonb language plpgsql as $$
declare v core.feedback_reports; v_out jsonb := '[]'::jsonb; v_seq int;
begin
  for v in select * from core.feedback_reports where routing_status in ('pending','error') and coalesce(next_routing_at, now()) <= now() and status = 'open'
            order by created_at limit least(greatest(p_limit, 1), 100) for update skip locked loop
    select coalesce(max(sequence), 0) into v_seq from core.feedback_task_links where report_id = v.id;
    -- Una secuencia nueva solo si la última ya tiene tarea (reapertura); si no, se reintenta la misma (idempotente en Tasks).
    if v_seq = 0 or exists (select 1 from core.feedback_task_links where report_id = v.id and sequence = v_seq and task_id is not null) then
      v_seq := v_seq + 1;
      insert into core.feedback_task_links (report_id, sequence, external_ref) values (v.id, v_seq, v.code || ':' || v_seq);
    end if;
    update core.feedback_reports set routing_attempts = routing_attempts + 1,
      next_routing_at = now() + least(interval '6 hours', interval '1 minute' * power(4, least(routing_attempts, 6))) where id = v.id;
    v_out := v_out || jsonb_build_object('reportId', v.id, 'code', v.code, 'externalRef', v.code || ':' || v_seq, 'subject', v.subject,
      'category', v.category, 'reporterKind', v.reporter_kind, 'originApp', v.origin_app, 'message', left(v.message, 4000), 'scope', v.scope, 'blocking', v.blocking);
  end loop;
  return v_out;
end $$;

create or replace function core.feedback_routing_result(p_external_ref text, p_task_id uuid, p_error text)
returns void language plpgsql as $$
declare v_report uuid;
begin
  select report_id into v_report from core.feedback_task_links where external_ref = p_external_ref;
  if v_report is null then perform core.fail('NOT_FOUND', 404); end if;
  if p_error is null then
    update core.feedback_task_links set task_id = p_task_id, task_status = coalesce(task_status, 'open'), task_status_at = now() where external_ref = p_external_ref;
    update core.feedback_reports set routing_status = 'routed', routing_error = null, next_routing_at = null, updated_at = now() where id = v_report;
  else
    update core.feedback_reports set routing_status = 'error', routing_error = left(p_error, 200), updated_at = now() where id = v_report;
  end if;
end $$;

create or replace function core.feedback_task_status(p_updates jsonb)
returns integer language plpgsql as $$
declare v jsonb; v_n int := 0;
begin
  for v in select * from jsonb_array_elements(coalesce(p_updates, '[]'::jsonb)) loop
    update core.feedback_task_links set task_status = v->>'status', task_status_at = now()
     where external_ref = v->>'externalRef' and task_status is distinct from v->>'status';
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end $$;

create or replace function core.feedback_open_task_refs(p_limit int default 200)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(l.external_ref), '[]'::jsonb) from (
    select l.external_ref from core.feedback_task_links l join core.feedback_reports r on r.id = l.report_id
     where r.status = 'open' and l.task_id is not null and l.task_status is distinct from 'done' order by l.created_at limit p_limit) l
$$;

-- El pipeline de publicación marca los reportes cuyo código aparece en los commits publicados: pasan a «pendiente de verificar».
create or replace function core.feedback_mark_released(p_codes text[], p_build text)
returns integer language plpgsql as $$
declare v_n int;
begin
  update core.feedback_reports set released_at = now(), released_build = left(p_build, 80), updated_at = now()
   where code = any (select upper(c) from unnest(p_codes) c) and status = 'open' and released_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

-- Conservación: reportes de huéspedes y organizadores, 12 meses después de cerrarse (con sus imágenes en core.files).
create or replace function core.feedback_purge()
returns integer language plpgsql as $$
declare v_n int;
begin
  with gone as (delete from core.feedback_reports where reporter_kind <> 'internal' and closed_at < now() - interval '12 months' returning id)
  select count(*) into v_n from gone;
  return v_n;
end $$;

-- Un lector puede adjuntar imágenes a su comentario (solo en el bucket de feedback).
create or replace function core.file_create(p_app text, p_actor uuid, p_bucket text, p_filename text, p_mime text, p_size bigint, p_sha256 text)
returns jsonb language plpgsql as $$
declare v_role text; v_id uuid := gen_random_uuid(); v_ext text; v_path text; v_safe text;
begin
  select role into v_role from core.memberships where app = p_app and user_id = p_actor;
  if v_role is null then perform core.fail('NO_MEMBERSHIP', 403); end if;
  if v_role = 'reader' and p_bucket <> 'feedback-media' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'readers cannot upload')); end if;
  if p_filename is null or length(p_filename) = 0 or length(p_filename) > 255 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid filename')); end if;
  if p_sha256 !~ '^[0-9a-f]{64}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid sha256')); end if;
  v_ext := lower(coalesce(nullif(regexp_replace(p_filename, '^.*\.', ''), p_filename), ''));
  if v_ext !~ '^[a-z0-9]{1,8}$' then v_ext := 'bin'; end if;
  v_safe := regexp_replace(regexp_replace(lower(p_filename), '[^a-z0-9._()-]+', '_', 'g'), '_+', '_', 'g');
  v_path := format('%s/%s/%s/%s', p_app, to_char(now(), 'YYYY'), v_id, v_safe);
  insert into core.files (id, app, bucket, path, filename, mime, size, sha256, created_by)
  values (v_id, p_app, p_bucket, v_path, p_filename, p_mime, p_size, p_sha256, p_actor);
  return jsonb_build_object('id', v_id, 'bucket', p_bucket, 'path', v_path, 'sha256', p_sha256, 'size', p_size, 'mime', p_mime, 'filename', p_filename,
    'duplicateOf', (select f.id from core.files f where f.app = p_app and f.sha256 = p_sha256 and f.status = 'verified' and f.id <> v_id order by f.created_at limit 1));
end $$;

-- ---------------------------------------------------------------------------
-- Envoltorios para la Edge (service_role)
-- ---------------------------------------------------------------------------
create or replace function public.core_feedback_create(p_app text, p_actor uuid, p_report jsonb, p_digest text) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_create(p_app, p_actor, p_report, p_digest) $$;
create or replace function public.core_feedback_list(p_app text, p_actor uuid, p_filters jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_list(p_app, p_actor, p_filters) $$;
create or replace function public.core_feedback_tree(p_app text, p_actor uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_tree(p_app, p_actor) $$;
create or replace function public.core_feedback_get(p_actor uuid, p_id uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_get(p_actor, p_id) $$;
create or replace function public.core_feedback_get_by_code(p_actor uuid, p_code text) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_get_by_code(p_actor, p_code) $$;
create or replace function public.core_feedback_act(p_actor uuid, p_id uuid, p_action text, p_args jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_act(p_actor, p_id, p_action, p_args) $$;
create or replace function public.core_feedback_routing_claim(p_limit int) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_routing_claim(p_limit) $$;
create or replace function public.core_feedback_routing_result(p_external_ref text, p_task_id uuid, p_error text) returns void
language sql security definer set search_path = '' as $$ select core.feedback_routing_result(p_external_ref, p_task_id, p_error) $$;
create or replace function public.core_feedback_task_status(p_updates jsonb) returns integer
language sql security definer set search_path = '' as $$ select core.feedback_task_status(p_updates) $$;
create or replace function public.core_feedback_open_task_refs(p_limit int) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_open_task_refs(p_limit) $$;
create or replace function public.core_feedback_mark_released(p_codes text[], p_build text) returns integer
language sql security definer set search_path = '' as $$ select core.feedback_mark_released(p_codes, p_build) $$;

do $$
declare f text;
begin
  for f in select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname = 'core' and p.proname like 'feedback\_%') or (n.nspname = 'public' and p.proname like 'core\_feedback\_%') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;

-- Limpieza diaria de los reportes de portales (solo donde existe pg_cron).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-feedback-purge', '41 3 * * *', $c$select core.feedback_purge()$c$)$q$;
  end if;
end $$;
