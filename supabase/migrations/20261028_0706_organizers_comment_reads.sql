-- Organizers · «Comentarios de tus asistentes»: leídos y sin leer (diseño en MUELA/equipo/feedback/organizers/
-- COMENTARIOS_LEIDOS.md, línea de Core del 27-10-2026). Quien organiza ve «Nuevo» en lo que no ha visto, y Dirección tiene
-- un KPI de «sin leer» de verdad (el de 0705 contaba los abiertos).
-- `organizers.comment_reads`: una fila por persona y comentario visto. Solo ids y la hora: ni el texto ni el nombre de nadie.
-- Cada persona escribe solo la suya (también dirección con «todos»), de un comentario de asistente de ese retiro, y no se
-- cambia nunca. Sin purga: no guarda datos personales (los informes los gestiona el núcleo).

create table organizers.comment_reads (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null,
  report_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  read_at timestamptz not null default now()
);
create index comment_reads_report_idx on organizers.comment_reads (report_id) where deleted_at is null;
select core.register_table('organizers', 'organizers', 'comment_reads', array['reservation_id','report_id','user_id','read_at'], '{editor,owner}', '{editor,owner}');

create or replace function organizers.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_actor uuid := nullif(p->>'actor', '')::uuid;
  v_res uuid;
  c record;
begin
  for c in select table_name, op, before, after from core.changes
            where app = p->>'app' and cursor = (p->>'cursor')::bigint and schema_name = 'organizers' and op <> 'call' loop
    if c.before is not null and (c.before->>'reservation_id' is distinct from c.after->>'reservation_id'
        or (c.table_name = 'answers' and (c.before->>'guest_id' is distinct from c.after->>'guest_id' or c.before->>'question_id' is distinct from c.after->>'question_id'))) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name));
    end if;
    if c.table_name = 'comment_reads' and c.before is not null then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.comment_reads'));
    end if;
    if c.table_name in ('materials','questions') and c.before is not null and c.before->>'owner_id' is distinct from c.after->>'owner_id' then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
    if v_actor is null or v_actor = core.service_actor('organizers') then continue; end if;
    v_res := (c.after->>'reservation_id')::uuid;
    if c.table_name = 'comment_reads' then
      -- Cada persona apunta solo lo suyo, de un comentario de asistente de ese retiro, con cualquier acceso al retiro
      -- (también «todos» de dirección: leer no es cambiar el retiro).
      if c.after->>'user_id' is distinct from v_actor::text then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.comment_reads', 'field', 'user_id'));
      end if;
      if not core.portal_in_scope('organizers', v_actor, v_res, null) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
      if not exists (select 1 from core.feedback_reports f
                      where f.id = (c.after->>'report_id')::uuid and f.origin_app = 'guests' and f.subject = 'event'
                        and f.scope->>'reservation_id' = v_res::text) then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.comment_reads', 'field', 'report_id'));
      end if;
      continue;
    end if;
    if c.table_name = 'answers' then
      if not core.portal_in_scope('guests', v_actor, v_res, (c.after->>'guest_id')::uuid)
         or not exists (select 1 from organizers.questions q where q.id = (c.after->>'question_id')::uuid and q.reservation_id = v_res) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
    elsif not organizers.own_grant(v_actor, v_res) then
      -- Con «todos» (dirección) se ve, pero se propone: la sugerencia la aplica el organizador al aceptarla.
      if core.portal_in_scope('organizers', v_actor, v_res, null) then
        perform core.fail('SUGGESTION_REQUIRED', 403, jsonb_build_object('reservation_id', v_res, 'kind', 'propuesta_equipo'));
      end if;
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
    elsif c.table_name in ('materials','questions') and c.before is null and c.after->>'owner_id' is distinct from v_actor::text then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
  end loop;
end $$;

-- KPI de Dirección (0705): se añade `organizers.guest_comments_unread_30d`; el resto no cambia.
create or replace view organizers.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
upcoming as (
  select r.reservation_id,
         exists (select 1 from core.portal_links l
                  where l.app = 'organizers' and l.revoked_at is null and l.scope->>'reservation_id' = r.reservation_id::text) as with_organizer
    from booking.guests_kpi_projection r, today
   where r.start_date between today.d and today.d + 30),
comments as (
  select f.status,
         exists (select 1 from organizers.comment_reads r where r.report_id = f.id and r.deleted_at is null) as read
    from core.feedback_reports f
   where f.origin_app = 'guests' and f.subject = 'event' and f.destination = 'organizer' and f.created_at >= now() - interval '30 days'),
reports as (
  select 1 from core.feedback_reports f where f.origin_app = 'organizers' and f.created_at >= now() - interval '30 days')
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, k.period_start, k.period_end, k.direction, k.link, now() as computed_at
  from today, lateral (values
    -- Retiros confirmados que empiezan en los próximos 30 días y en los que quien organiza ya tiene acceso al portal.
    ('organizers.retreats_next_30d', 'Retiros próximos con quien organiza dentro',
      (select count(*) from upcoming where with_organizer)::numeric, 'count', today.d, today.d + 30, 'up', 'https://booking.ikisai.com/#/reservas'),
    -- Los mismos, sin ningún enlace de Organizers vivo: Dirección puede pedir que se lo envíen.
    ('organizers.retreats_without_access', 'Retiros próximos sin acceso de quien organiza',
      (select count(*) from upcoming where not with_organizer)::numeric, 'count', today.d, today.d + 30, 'down', 'https://booking.ikisai.com/#/reservas'),
    -- Comentarios de asistentes sobre su retiro (Guests → quien organiza) de los últimos 30 días que siguen abiertos.
    ('organizers.guest_comments_open_30d', 'Comentarios de asistentes abiertos (30 días)',
      (select count(*) from comments where status = 'open')::numeric, 'count', today.d - 30, today.d, 'down', null),
    -- Los mismos comentarios (30 días) que nadie con acceso de Organizers a ese retiro ha visto (organizers.comment_reads).
    ('organizers.guest_comments_unread_30d', 'Comentarios de asistentes sin leer (30 días)',
      (select count(*) from comments where not read)::numeric, 'count', today.d - 30, today.d, 'down', null),
    -- Informes (fallos, ideas y propuestas) que quien organiza ha enviado desde Organizers en los últimos 30 días.
    ('organizers.reports_sent_30d', 'Informes enviados desde Organizers (30 días)',
      (select count(*) from reports)::numeric, 'count', today.d - 30, today.d, null, null)
  ) as k(kpi, label, value, unit, period_start, period_end, direction, link);

revoke all on organizers.comment_reads from public, anon, authenticated;
grant all on organizers.comment_reads to service_role;
revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
