-- 0117 · La casa contesta a quien organiza (línea de Core del 28-10; diseño en
-- MUELA/equipo/feedback/organizers/RESPUESTAS_CASA.md). Respuestas a un informe del núcleo, de momento solo a los de quien
-- organiza sobre su retiro (`reporter_kind = organizer`, con `scope.reservation_id`). Contesta la casa: editor u owner de
-- Booking o el dueño del ecosistema, nunca una cuenta de portal. Las ve quien escribió el informe y quien puede verlo
-- (`core.feedback_can_see`); a quien organiza se le enseñan firmadas «Ikisai», sin el autor.

create table if not exists core.feedback_replies (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references core.feedback_reports(id) on delete cascade,
  author_user_id uuid not null references auth.users(id),
  message text not null check (length(btrim(message)) between 1 and 2000),
  created_at timestamptz not null default now(),
  -- Cuándo lo vio quien escribió el informe (`null`: sin ver).
  read_at timestamptz
);
create index if not exists feedback_replies_report_idx on core.feedback_replies (report_id, created_at);
alter table core.feedback_replies enable row level security;
revoke all on core.feedback_replies from public, anon, authenticated;
grant all on core.feedback_replies to service_role;

-- ¿Puede contestar? Quien es de la casa: el dueño del ecosistema o editor u owner de Booking, y nunca una cuenta de portal.
create or replace function core.feedback_can_reply(p_report core.feedback_reports, p_actor uuid)
returns boolean language sql stable as $$
  select p_actor is not null and p_report.reporter_user_id is distinct from p_actor
     and p_report.reporter_kind = 'organizer' and p_report.scope ? 'reservation_id'
     and not core.is_portal_account(p_actor)
     and (core.feedback_is_ecosystem_owner(p_actor)
          or exists (select 1 from core.memberships m where m.app = 'booking' and m.user_id = p_actor and m.role in ('editor', 'owner')))
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
  insert into core.feedback_replies (report_id, author_user_id, message) values (r.id, p_actor, btrim(p_message))
  returning id, created_at into v_id, v_at;
  return jsonb_build_object('id', v_id, 'created_at', v_at);
end $$;

-- Las respuestas de un informe, para quien puede verlo. Quien lo escribió no ve quién contestó.
create or replace function core.feedback_replies_of(p_actor uuid, p_report uuid)
returns jsonb language plpgsql stable as $$
declare r core.feedback_reports; v_reporter boolean;
begin
  select * into r from core.feedback_reports where id = p_report;
  if r.id is null or not core.feedback_can_see(r, p_actor) then perform core.fail('OUT_OF_SCOPE', 404, jsonb_build_object('report', p_report)); end if;
  v_reporter := r.reporter_user_id = p_actor;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'message', x.message, 'created_at', x.created_at, 'read', x.read_at is not null,
                                        'author', case when v_reporter then null else coalesce(p.display_name, 'Ikisai') end) order by x.created_at)
      from core.feedback_replies x left join core.profiles p on p.user_id = x.author_user_id
     where x.report_id = r.id), '[]'::jsonb));
end $$;

-- Las respuestas a mis informes (las de los últimos 180 días), con su retiro, para Mis retiros y «Lo que me has enviado».
create or replace function core.feedback_replies_mine(p_actor uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id, 'report_id', f.id, 'report_code', f.code, 'reservation_id', f.scope->>'reservation_id',
           'message', x.message, 'created_at', x.created_at, 'read', x.read_at is not null) order by x.created_at desc), '[]'::jsonb))
    from core.feedback_replies x join core.feedback_reports f on f.id = x.report_id
   where f.reporter_user_id = p_actor and x.created_at > now() - interval '180 days';
$$;

-- Marca como vistas las respuestas a mis informes; las de los informes de otros no se tocan.
create or replace function core.feedback_replies_read(p_actor uuid, p_ids uuid[])
returns jsonb language plpgsql as $$
declare n int;
begin
  update core.feedback_replies x set read_at = now()
    from core.feedback_reports f
   where f.id = x.report_id and f.reporter_user_id = p_actor and x.read_at is null and x.id = any (coalesce(p_ids, '{}'));
  get diagnostics n = row_count;
  return jsonb_build_object('read', n);
end $$;

create or replace function public.core_feedback_reply(p_actor uuid, p_report uuid, p_message text) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_reply(p_actor, p_report, p_message) $$;
create or replace function public.core_feedback_replies_of(p_actor uuid, p_report uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_replies_of(p_actor, p_report) $$;
create or replace function public.core_feedback_replies_mine(p_actor uuid) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_replies_mine(p_actor) $$;
create or replace function public.core_feedback_replies_read(p_actor uuid, p_ids uuid[]) returns jsonb
language sql security definer set search_path = '' as $$ select core.feedback_replies_read(p_actor, p_ids) $$;

do $$
declare f text;
begin
  foreach f in array array['core.feedback_can_reply(core.feedback_reports, uuid)', 'core.feedback_reply(uuid, uuid, text)',
                           'core.feedback_replies_of(uuid, uuid)', 'core.feedback_replies_mine(uuid)', 'core.feedback_replies_read(uuid, uuid[])',
                           'public.core_feedback_reply(uuid, uuid, text)', 'public.core_feedback_replies_of(uuid, uuid)',
                           'public.core_feedback_replies_mine(uuid)', 'public.core_feedback_replies_read(uuid, uuid[])'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
