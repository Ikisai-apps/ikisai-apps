-- 0121 · Quien organiza contesta a sus asistentes (X6 del triaje de Organizers del 05-11; línea de Core del sprint). Amplía la
-- 0117 (RESPUESTAS_CASA.md):
-- - además de la casa a quien organiza, contesta quien organiza (editor u owner de Organizers con ese retiro en su ámbito) a
--   un comentario de un asistente sobre el retiro (`reporter_kind = guest`, `subject = event`). La casa sigue sin contestar a
--   los huéspedes;
-- - cada respuesta guarda de quién es (`author_kind`: `house` u `organizer`);
-- - el informe trae su última respuesta (`reply`: texto, firma y fecha), la que pinta Guests en «Lo que me has enviado», y si
--   quien lo pide puede contestar (`canReply`). La firma: «Ikisai» para la casa y el nombre de quien organiza para sus
--   respuestas (el asistente ya lo conoce).

alter table core.feedback_replies add column if not exists author_kind text not null default 'house';
do $$ begin
  alter table core.feedback_replies add constraint feedback_replies_author_kind_check check (author_kind in ('house', 'organizer'));
exception when duplicate_object then null; end $$;

-- ¿Contesta como quien organiza? Editor u owner de Organizers con ese retiro en `scopes.grants`, a un comentario de huésped.
create or replace function core.feedback_can_reply_as_organizer(p_report core.feedback_reports, p_actor uuid)
returns boolean language sql stable as $$
  select p_actor is not null and p_report.reporter_user_id is distinct from p_actor
     and p_report.reporter_kind = 'guest' and p_report.subject = 'event' and p_report.scope ? 'reservation_id'
     and exists (select 1 from core.memberships m, jsonb_array_elements(case when jsonb_typeof(m.scopes->'grants') = 'array' then m.scopes->'grants' else '[]'::jsonb end) g
                  where m.app = 'organizers' and m.user_id = p_actor and m.role in ('editor', 'owner')
                    and lower(g->>'reservation_id') = lower(p_report.scope->>'reservation_id'))
$$;

create or replace function core.feedback_can_reply(p_report core.feedback_reports, p_actor uuid)
returns boolean language sql stable as $$
  select (p_actor is not null and p_report.reporter_user_id is distinct from p_actor
     and p_report.reporter_kind = 'organizer' and p_report.scope ? 'reservation_id'
     and not core.is_portal_account(p_actor)
     and (core.feedback_is_ecosystem_owner(p_actor)
          or exists (select 1 from core.memberships m where m.app = 'booking' and m.user_id = p_actor and m.role in ('editor', 'owner'))))
    or core.feedback_can_reply_as_organizer(p_report, p_actor)
$$;

create or replace function core.feedback_reply(p_actor uuid, p_report uuid, p_message text)
returns jsonb language plpgsql as $$
declare r core.feedback_reports; v_id uuid; v_at timestamptz;
begin
  select * into r from core.feedback_reports where id = p_report;
  -- Lo que no se ve responde igual que lo que no existe.
  if r.id is null or not core.feedback_can_see(r, p_actor) then perform core.fail('OUT_OF_SCOPE', 404, jsonb_build_object('report', p_report)); end if;
  if not core.feedback_can_reply(r, p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('report', p_report)); end if;
  if p_message is null or length(btrim(p_message)) not between 1 and 2000 then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'message', 'max', 2000));
  end if;
  insert into core.feedback_replies (report_id, author_user_id, message, author_kind)
  values (r.id, p_actor, btrim(p_message), case when core.feedback_can_reply_as_organizer(r, p_actor) then 'organizer' else 'house' end)
  returning id, created_at into v_id, v_at;
  return jsonb_build_object('id', v_id, 'created_at', v_at);
end $$;

-- La última respuesta de un informe, firmada: «Ikisai» la casa; quien organiza, con su nombre.
create or replace function core.feedback_last_reply(p_report uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('text', x.message, 'at', x.created_at, 'kind', x.author_kind,
           'from', case when x.author_kind = 'organizer' then coalesce(nullif(btrim(p.display_name), ''), 'Quien organiza') else 'Ikisai' end)
    from core.feedback_replies x left join core.profiles p on p.user_id = x.author_user_id
   where x.report_id = p_report
   order by x.created_at desc, x.id desc limit 1
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
    'reviewStatus', p_report.review_status, 'mergedInto', (select m.code from core.feedback_reports m where m.id = p_report.merged_into),
    'routeRaw', case when p_report.reporter_user_id = p_actor or core.feedback_is_ecosystem_owner(p_actor) then p_report.route_raw end,
    'releasedBuild', p_report.released_build, 'reopenCount', p_report.reopen_count, 'createdAt', p_report.created_at,
    'verifiedAt', p_report.verified_at, 'verifiedBuild', p_report.verified_build, 'dismissReason', p_report.dismiss_reason,
    'reply', core.feedback_last_reply(p_report.id), 'canReply', core.feedback_can_reply(p_report, p_actor))
$$;

do $$
declare f text;
begin
  foreach f in array array['core.feedback_can_reply_as_organizer(core.feedback_reports, uuid)', 'core.feedback_last_reply(uuid)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
