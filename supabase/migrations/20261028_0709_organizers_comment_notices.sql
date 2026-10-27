-- Ikisai Organizers · avisos por correo de comentarios nuevos de los asistentes (línea de Core del 28-10; diseño en
-- MUELA/equipo/feedback/organizers/COMENTARIOS_LEIDOS.md y AVISOS_COMENTARIOS.md). Toca solo el schema organizers.
--
-- Un correo por persona que organiza, como mucho cada hora, con los comentarios de sus asistentes que aún no ha visto
-- (`organizers.comment_reads`, 0706) y llegaron después del último aviso. Solo a quien tiene un enlace de Organizers vivo y
-- con ese retiro en su ámbito (no a Dirección con «todos»: vería los de todos los retiros). Lo envía el worker
-- `comment-notices/tick` de organizers-api, apagado hasta `IKISAI_ORGANIZER_MAIL=1` (y el SMTP de VG).
-- El correo no lleva el texto del comentario ni el nombre del asistente: el retiro, cuántos y el enlace a Mis retiros.

-- Interna: sin roles (nadie la lee ni la escribe por la sincronización; solo estas acciones de sistema), como las tablas
-- internas de Finance (0255).
create table if not exists organizers.comment_notices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  -- Hasta qué comentario (por `created_at`) ya se avisó: lo siguiente se cuenta desde aquí.
  cursor timestamptz not null,
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);
select core.register_table('organizers', 'organizers', 'comment_notices', array[]::text[], '{}', '{}', true);

-- La primera vez que se enciende no se avisa de todo el historial: solo de lo de las últimas 24 horas.
create or replace function organizers.comment_notices_pending(p_limit int)
returns table (user_id uuid, reservation_id uuid, comments int, newest timestamptz) language sql stable as $$
  with links as (
    select distinct l.user_id, (l.scope->>'reservation_id')::uuid as reservation_id
      from core.portal_links l
     where l.app = 'organizers' and l.revoked_at is null and l.scope ? 'reservation_id'
       and (l.expires_at is null or l.expires_at > now())
       and core.portal_in_scope('organizers', l.user_id, (l.scope->>'reservation_id')::uuid, null)),
  due as (
    select k.user_id, k.reservation_id, f.id, f.created_at
      from links k
      join core.feedback_reports f
        on f.origin_app = 'guests' and f.subject = 'event' and f.destination = 'organizer'
       and f.scope->>'reservation_id' = k.reservation_id::text
      left join organizers.comment_notices n on n.user_id = k.user_id
     where f.created_at > coalesce(n.cursor, now() - interval '24 hours')
       and (n.last_sent_at is null or n.last_sent_at <= now() - interval '1 hour')
       and not exists (select 1 from organizers.comment_reads r
                        where r.user_id = k.user_id and r.report_id = f.id and r.deleted_at is null))
  select d.user_id, d.reservation_id, count(*)::int, max(d.created_at)
    from due d
   where d.user_id in (select distinct user_id from due order by user_id limit greatest(1, least(coalesce(p_limit, 50), 200)))
   group by d.user_id, d.reservation_id
   order by d.user_id, max(d.created_at) desc;
$$;

create or replace function organizers.comment_notices_has_work()
returns boolean language sql stable as $$ select exists (select 1 from organizers.comment_notices_pending(1)) $$;

-- Lo que hay que avisar, por persona: `[{user_id, cursor, reservations: [{reservation_id, comments}]}]`.
create or replace function organizers.comment_notices_due(p jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('user_id', u.user_id, 'cursor', u.cursor, 'reservations', u.reservations) order by u.user_id), '[]'::jsonb)
    from (select x.user_id, max(x.newest) as cursor,
                 jsonb_agg(jsonb_build_object('reservation_id', x.reservation_id, 'comments', x.comments) order by x.newest desc) as reservations
            from organizers.comment_notices_pending(coalesce((p->'args'->>'limit')::int, 50)) x
           group by x.user_id) u;
$$;

-- Tras enviarlo: el cursor avanza hasta el comentario más nuevo avisado y empieza la hora de espera.
create or replace function organizers.comment_notices_sent(p jsonb)
returns jsonb language plpgsql as $$
declare v_user uuid; v_cursor timestamptz;
begin
  begin
    v_user := (p->'args'->>'user_id')::uuid; v_cursor := (p->'args'->>'cursor')::timestamptz;
  exception when others then v_user := null; end;
  if v_user is null or v_cursor is null then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'user_id and cursor are required'));
  end if;
  insert into organizers.comment_notices (user_id, cursor, last_sent_at) values (v_user, v_cursor, now())
  on conflict (user_id) do update set cursor = greatest(organizers.comment_notices.cursor, excluded.cursor), last_sent_at = now();
  return jsonb_build_object('ok', true);
end $$;

select core.allow_read('organizers', 'organizers.comment_notices_due', 'action', '{}');
select core.allow_read('organizers', 'organizers.comment_notices_sent', 'action', '{}');
select core.schedule_tick('organizers', 'comment-notices/tick', '*/15 * * * *', 'organizers.comment_notices_has_work');

revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
