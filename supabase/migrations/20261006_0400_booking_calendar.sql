-- Ikisai Booking · fase B3: enlace con Google Calendar (docs/booking/API.md §2.6, §3.3 y §7.3).
-- Proyección de una sola dirección. Aquí viven el enlace por reserva, la cola de trabajos, los triggers que
-- encolan dentro de la transacción del guardado y las funciones que usa el worker de la Edge.
-- El guardado nunca depende de Google: solo deja un trabajo pendiente.

-- ---------------------------------------------------------------------------
-- Tablas cerradas: nadie las lee ni las escribe por el núcleo.
-- ---------------------------------------------------------------------------
create table booking.calendar_links (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null unique references booking.reservations(id) on delete cascade,
  provider text not null default 'google_calendar',
  calendar_id text not null,
  provider_event_id text,
  generation integer not null default 1,
  html_link text,
  source_reservation_revision bigint,
  source_event_revision bigint,
  sync_status text not null default 'pending' check (sync_status in ('pending','synced','error','deleted')),
  payload_hash text,
  last_synced_at timestamptz,
  last_error text -- código corto, nunca datos personales
);

select core.register_table('booking', 'booking', 'calendar_links', array[]::text[], '{}', '{}');

create table booking.calendar_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id) on delete cascade,
  desired_action text not null check (desired_action in ('upsert','delete')), -- informativo: el worker recalcula
  source_reservation_revision bigint not null,
  source_event_revision bigint,
  status text not null default 'pending' check (status in ('pending','running','done','error','superseded')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text
);

select core.register_table('booking', 'booking', 'calendar_sync_jobs', array[]::text[], '{}', '{}');

-- Como mucho un trabajo pendiente por reserva: un cambio nuevo actualiza el pendiente en vez de apilar otro.
create unique index calendar_sync_jobs_pending_uidx on booking.calendar_sync_jobs (reservation_id) where status = 'pending';
create index calendar_sync_jobs_due_idx on booking.calendar_sync_jobs (available_at) where status in ('pending','running');

-- ---------------------------------------------------------------------------
-- Encolado
-- ---------------------------------------------------------------------------
-- Código de error corto: mayúsculas, dígitos y guion bajo. Nunca texto libre (podría llevar datos personales).
create or replace function booking.calendar_error_code(p_raw text)
returns text language sql immutable as $$
  select coalesce(nullif(left(regexp_replace(upper(coalesce(p_raw, '')), '[^A-Z0-9_]', '', 'g'), 40), ''), 'UNKNOWN');
$$;

-- p_force: reintento manual; encola aunque el estado no sea publicable ni exista enlace.
create or replace function booking.calendar_enqueue(p_reservation uuid, p_force boolean default false)
returns boolean language plpgsql as $$
declare
  r booking.reservations;
  v_event_revision bigint;
  v_publishable boolean;
  v_linked boolean;
begin
  select * into r from booking.reservations where id = p_reservation;
  if r.id is null then return false; end if;
  v_publishable := r.status in ('pre_reservada','confirmada','en_ejecucion');
  v_linked := exists (select 1 from booking.calendar_links l where l.reservation_id = r.id);
  if not (p_force or v_publishable or v_linked) then return false; end if;
  select e.revision into v_event_revision from booking.events e where e.reservation_id = r.id;
  insert into booking.calendar_sync_jobs (reservation_id, desired_action, source_reservation_revision, source_event_revision)
  values (r.id,
          case when v_publishable and r.deleted_at is null and r.archived_at is null then 'upsert' else 'delete' end,
          r.revision, v_event_revision)
  on conflict (reservation_id) where status = 'pending' do update
    set desired_action = excluded.desired_action,
        source_reservation_revision = excluded.source_reservation_revision,
        source_event_revision = excluded.source_event_revision,
        attempts = 0, available_at = now(), last_error = null;
  return true;
end $$;

create or replace function booking.calendar_enqueue_reservation_trg()
returns trigger language plpgsql as $$
begin
  perform booking.calendar_enqueue(new.id);
  return null;
end $$;

create or replace function booking.calendar_enqueue_event_trg()
returns trigger language plpgsql as $$
begin
  perform booking.calendar_enqueue(new.reservation_id);
  return null;
end $$;

create trigger reservations_calendar_enqueue after insert or update on booking.reservations
  for each row execute function booking.calendar_enqueue_reservation_trg();
create trigger events_calendar_enqueue after insert or update on booking.events
  for each row execute function booking.calendar_enqueue_event_trg();

-- API.md §2.8: no se purga físicamente una reserva mientras su enlace conserve un evento vivo en Google.
create or replace function booking.calendar_guard_purge_trg()
returns trigger language plpgsql as $$
begin
  if exists (select 1 from booking.calendar_links l
             where l.reservation_id = old.id and l.provider_event_id is not null and l.sync_status <> 'deleted') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'calendar event still alive', 'reservation_id', old.id));
  end if;
  return old;
end $$;

create trigger reservations_calendar_guard_purge before delete on booking.reservations
  for each row execute function booking.calendar_guard_purge_trg();

-- ---------------------------------------------------------------------------
-- Funciones del worker (acciones: reciben { app, actor, role, args })
-- ---------------------------------------------------------------------------
-- args: { limit?: int (0 = solo contar), reservationIds?: uuid[] }
-- Devuelve { jobs: [{ jobId, reservationId, attempts, reservation, event, link }], pending }.
-- Las filas llevan solo lo necesario para el payload: sin huéspedes, sin importes y sin notas internas.
create or replace function booking.calendar_claim(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_limit int := least(greatest(coalesce((p->'args'->>'limit')::int, 10), 0), 50);
  v_ids uuid[];
  v_jobs jsonb;
  v_pending int;
begin
  if jsonb_typeof(p->'args'->'reservationIds') = 'array' then
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(p->'args'->'reservationIds') x;
  end if;
  -- Limpieza: los trabajos terminados de más de 30 días ya no aportan nada.
  delete from booking.calendar_sync_jobs where status in ('done','superseded') and updated_at < now() - interval '30 days';

  with due as (
    select j.id from booking.calendar_sync_jobs j
    where ((j.status = 'pending' and j.available_at <= now()) or (j.status = 'running' and j.locked_until < now()))
      and (v_ids is null or j.reservation_id = any(v_ids))
    order by j.available_at, j.created_at
    limit v_limit
    for update skip locked
  ), claimed as (
    update booking.calendar_sync_jobs j set status = 'running', locked_until = now() + interval '2 minutes'
    from due where j.id = due.id
    returning j.id, j.reservation_id, j.attempts, j.available_at, j.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', c.id, 'reservationId', c.reservation_id, 'attempts', c.attempts,
    'reservation', (select jsonb_build_object(
        'id', r.id, 'code', r.code, 'revision', r.revision, 'title', r.title, 'status', r.status,
        'start_date', r.start_date, 'end_date', r.end_date, 'expected_guests', r.expected_guests,
        'contact_name', r.contact_name, 'contact_phone', r.contact_phone, 'contact_email', r.contact_email,
        'uses_accommodation', r.uses_accommodation, 'requires_meals', r.requires_meals,
        'meal_plan_requested', r.meal_plan_requested, 'menu_style_requested', r.menu_style_requested,
        'customer_notes', r.customer_notes, 'archived_at', r.archived_at, 'deleted_at', r.deleted_at)
      from booking.reservations r where r.id = c.reservation_id),
    'event', (select jsonb_build_object(
        'id', e.id, 'code', e.code, 'revision', e.revision, 'deleted_at', e.deleted_at,
        'responsible_name', e.responsible_name, 'arrival_time', e.arrival_time, 'departure_time', e.departure_time,
        'final_guests', e.final_guests, 'meal_plan_confirmed', e.meal_plan_confirmed, 'menu_style_confirmed', e.menu_style_confirmed,
        'setup_style', e.setup_style, 'rooms_count', e.rooms_count,
        'preparation_status', e.preparation_status, 'accommodation_status', e.accommodation_status,
        'kitchen_status', e.kitchen_status, 'cleaning_status', e.cleaning_status, 'operational_notes', e.operational_notes)
      from booking.events e where e.reservation_id = c.reservation_id),
    'link', (select jsonb_build_object(
        'calendarId', l.calendar_id, 'providerEventId', l.provider_event_id, 'generation', l.generation,
        'htmlLink', l.html_link, 'syncStatus', l.sync_status, 'payloadHash', l.payload_hash)
      from booking.calendar_links l where l.reservation_id = c.reservation_id)
  ) order by c.available_at, c.created_at), '[]'::jsonb) into v_jobs from claimed c;

  select count(*) into v_pending from booking.calendar_sync_jobs j
  where j.status in ('pending','running') and not exists (select 1 from jsonb_array_elements(v_jobs) x where (x->>'jobId')::uuid = j.id);
  return jsonb_build_object('jobs', v_jobs, 'pending', v_pending);
end $$;

-- args: { jobId, outcome: 'done' | 'retry' | 'fatal', error?: código corto, calendarId?,
--         link?: { syncStatus: 'synced' | 'deleted', providerEventId, generation, htmlLink, payloadHash,
--                  sourceReservationRevision, sourceEventRevision } }
-- 'retry' = fallo recuperable (espera creciente; al octavo intento, error). 'fatal' = fallo definitivo.
create or replace function booking.calendar_report(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  j booking.calendar_sync_jobs;
  v_outcome text := a->>'outcome';
  v_link jsonb := a->'link';
  v_code text;
  v_attempts int;
  v_status text;
  v_next timestamptz;
begin
  if v_outcome is null or v_outcome not in ('done','retry','fatal') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid outcome'));
  end if;
  select * into j from booking.calendar_sync_jobs where id = (a->>'jobId')::uuid for update;
  if j.id is null or j.status <> 'running' then return jsonb_build_object('ignored', true); end if;

  if v_outcome = 'done' then
    update booking.calendar_sync_jobs set status = 'done', locked_until = null, last_error = null where id = j.id;
    if jsonb_typeof(v_link) = 'object' then
      insert into booking.calendar_links (reservation_id, calendar_id, provider_event_id, generation, html_link, payload_hash,
                                          source_reservation_revision, source_event_revision, sync_status, last_synced_at, last_error)
      values (j.reservation_id, coalesce(a->>'calendarId', 'unknown'), v_link->>'providerEventId', coalesce((v_link->>'generation')::int, 1),
              v_link->>'htmlLink', v_link->>'payloadHash', (v_link->>'sourceReservationRevision')::bigint,
              (v_link->>'sourceEventRevision')::bigint, v_link->>'syncStatus', now(), null)
      on conflict (reservation_id) do update
        set calendar_id = excluded.calendar_id, provider_event_id = excluded.provider_event_id, generation = excluded.generation,
            html_link = excluded.html_link, payload_hash = excluded.payload_hash,
            source_reservation_revision = excluded.source_reservation_revision, source_event_revision = excluded.source_event_revision,
            sync_status = excluded.sync_status, last_synced_at = excluded.last_synced_at, last_error = null;
    end if;
    return jsonb_build_object('status', 'done');
  end if;

  v_code := booking.calendar_error_code(a->>'error');
  v_attempts := j.attempts + 1;
  if v_outcome = 'fatal' or v_attempts >= 8 then
    v_status := 'error';
  elsif exists (select 1 from booking.calendar_sync_jobs o where o.reservation_id = j.reservation_id and o.status = 'pending') then
    v_status := 'superseded'; -- ya hay un trabajo más nuevo esperando: ese recoge el testigo
  else
    v_status := 'pending';
    v_next := now() + least(interval '6 hours', interval '1 minute' * power(4, v_attempts - 1));
  end if;
  update booking.calendar_sync_jobs
    set status = v_status, attempts = v_attempts, locked_until = null, last_error = v_code,
        available_at = coalesce(v_next, available_at)
    where id = j.id;
  if v_status = 'error' then
    insert into booking.calendar_links (reservation_id, calendar_id, sync_status, last_error)
    values (j.reservation_id, coalesce(a->>'calendarId', 'unknown'), 'error', v_code)
    on conflict (reservation_id) do update set sync_status = 'error', last_error = excluded.last_error;
  end if;
  return jsonb_build_object('status', v_status, 'attempts', v_attempts, 'nextAttemptAt', v_next);
end $$;

-- Lectura para la UI. args: { reservationIds?: uuid[] }. Sin ids: todas las reservas con enlace o con trabajo vivo.
-- pendingJob también es true si las revisiones de origen del enlace se han quedado atrás (contrato §8).
create or replace function booking.calendar_status(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_ids uuid[];
  v_items jsonb;
begin
  if jsonb_typeof(p->'args'->'reservationIds') = 'array' then
    select array_agg(x::uuid) into v_ids from jsonb_array_elements_text(p->'args'->'reservationIds') x;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'reservationId', r.id,
    'syncStatus', coalesce(l.sync_status, 'pending'),
    'lastSyncedAt', l.last_synced_at,
    'lastError', coalesce(l.last_error, j.last_error),
    'htmlLink', case when l.sync_status = 'synced' then l.html_link end,
    'pendingJob', j.id is not null or (l.sync_status = 'synced' and (
        l.source_reservation_revision is distinct from r.revision
        or l.source_event_revision is distinct from (select e.revision from booking.events e where e.reservation_id = r.id and e.deleted_at is null))),
    'attempts', coalesce(j.attempts, 0),
    'nextAttemptAt', case when j.status = 'pending' then j.available_at end
  ) order by r.start_date nulls last, r.id), '[]'::jsonb) into v_items
  from booking.reservations r
  left join booking.calendar_links l on l.reservation_id = r.id
  left join lateral (
    select * from booking.calendar_sync_jobs q
    where q.reservation_id = r.id and q.status in ('pending','running')
    order by (q.status = 'pending') desc, q.created_at desc limit 1) j on true
  where (l.id is not null or j.id is not null) and (v_ids is null or r.id = any(v_ids));
  return jsonb_build_object('items', v_items);
end $$;

-- Reintento manual. args: { reservationId }.
create or replace function booking.calendar_retry(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_id uuid := (p->'args'->>'reservationId')::uuid;
begin
  if v_id is null or not exists (select 1 from booking.reservations where id = v_id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('reservation_id', v_id));
  end if;
  perform booking.calendar_enqueue(v_id, true);
  update booking.calendar_links set sync_status = 'pending' where reservation_id = v_id and sync_status = 'error';
  return jsonb_build_object('queued', true);
end $$;

-- claim y report son del worker: se registran sin roles de usuario, así que solo entran por la ruta de sistema.
select core.allow_read('booking', 'booking.calendar_claim', 'action', '{}');
select core.allow_read('booking', 'booking.calendar_report', 'action', '{}');
select core.allow_read('booking', 'booking.calendar_status', 'function', '{reader,editor,owner}');
select core.allow_read('booking', 'booking.calendar_retry', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
