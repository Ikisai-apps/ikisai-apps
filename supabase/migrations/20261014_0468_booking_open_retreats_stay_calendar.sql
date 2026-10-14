-- Ikisai Booking · O2, parte 2 (aprobada por el usuario el 14-10-2026, coordinacion/booking/o2/O2_PREPARACION.md):
--   1. Retiros visibles para huéspedes: `guests_visible` y `public_summary` en la reserva (solo el personal), y la lectura
--      `portal_open_retreats` para Guests con título, fechas y resumen, **sin precio**. «Apuntarme» llega después, con las
--      sugerencias del núcleo (PETICIONES P23 y P24).
--   2. Estancias en Google Calendar: las de outsider en un segundo calendario y las del staff en un tercero (decisión del
--      usuario), con su propia cola. Título «Marta (+1)»; sin contacto ni notas. Sin calendario configurado no se proyecta
--      nada y las reservas siguen igual. El guardado nunca depende de Google.
-- Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- 1. Retiros visibles para huéspedes
-- ---------------------------------------------------------------------------
alter table booking.reservations
  add column guests_visible boolean not null default false,
  add column public_summary text check (public_summary is null or length(public_summary) <= 500);
select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive','organizer_notes',
  'guests_visible','public_summary']);

-- Para cualquier huésped de Guests: los retiros abiertos con fechas en el rango. `joined`: ya tiene una entrada en él.
create or replace function booking.portal_open_retreats(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid; v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('reservation_id', r.id, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
             'summary', r.public_summary,
             'joined', exists (select 1 from booking.account_guests(v_actor) g join booking.events e on e.id = g.event_id where e.reservation_id = r.id))
             order by r.start_date, r.title)
      from booking.reservations r
     where r.deleted_at is null and r.archived_at is null and r.guests_visible
       and r.status in ('pre_reservada','confirmada','en_ejecucion')
       and r.start_date is not null and r.end_date is not null
       and r.start_date < v_range.d_to and v_range.d_from <= r.end_date), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- 2. Estancias en Google Calendar (tablas cerradas, como las de las reservas)
-- ---------------------------------------------------------------------------
create table booking.stay_calendar_links (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  stay_id uuid not null unique references booking.stays(id) on delete cascade,
  calendar_id text not null,
  provider_event_id text,
  generation integer not null default 1,
  sync_status text not null default 'pending' check (sync_status in ('pending','synced','error','deleted')),
  payload_hash text,
  last_synced_at timestamptz,
  last_error text -- código corto, nunca datos personales
);
select core.register_table('booking', 'booking', 'stay_calendar_links', array[]::text[], '{}', '{}');

create table booking.stay_calendar_jobs (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  stay_id uuid not null references booking.stays(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','running','done','error','superseded')),
  attempts integer not null default 0,
  available_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text
);
select core.register_table('booking', 'booking', 'stay_calendar_jobs', array[]::text[], '{}', '{}');
create unique index stay_calendar_jobs_pending_uidx on booking.stay_calendar_jobs (stay_id) where status = 'pending';
create index stay_calendar_jobs_due_idx on booking.stay_calendar_jobs (available_at) where status in ('pending','running');

create or replace function booking.stay_calendar_enqueue(p_stay uuid)
returns void language plpgsql as $$
begin
  if p_stay is null then return; end if;
  insert into booking.stay_calendar_jobs (stay_id) values (p_stay)
  on conflict (stay_id) where status = 'pending' do update set attempts = 0, available_at = now(), last_error = null;
end $$;

create or replace function booking.stay_calendar_enqueue_trg()
returns trigger language plpgsql as $$
begin
  -- (un `case` no sirve: plpgsql resuelve los dos campos para cualquier tabla)
  if tg_table_name = 'stays' then perform booking.stay_calendar_enqueue(new.id);
  else perform booking.stay_calendar_enqueue(new.stay_id); end if;
  return null;
end $$;
create trigger stays_calendar_enqueue after insert or update on booking.stays
  for each row execute function booking.stay_calendar_enqueue_trg();
-- el título lleva el nombre y cuántos más
create trigger stay_persons_calendar_enqueue after insert or update on booking.stay_persons
  for each row execute function booking.stay_calendar_enqueue_trg();

-- Nombre de pila para el título: la primera persona de la estancia o, si no hay, el de la cuenta.
create or replace function booking.stay_calendar_names(p_stay booking.stays)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'first', coalesce(
      (select split_part(btrim(sp.name), ' ', 1) from booking.stay_persons sp where sp.stay_id = p_stay.id and sp.deleted_at is null order by sp.created_at, sp.name limit 1),
      nullif(split_part(btrim((select display_name from core.profiles where user_id = p_stay.account_id)), ' ', 1), '')),
    'count', (select count(*) from booking.stay_persons sp where sp.stay_id = p_stay.id and sp.deleted_at is null));
$$;

-- args: { limit?: int (0 = solo contar), kinds: ['outsider' | 'staff'] (los que tienen calendario) }
-- Devuelve { jobs: [{ jobId, stayId, attempts, stay: {id, kind, from_date, to_date, deleted_at, first, count}, link }], pending }.
create or replace function booking.stay_calendar_claim(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_limit int := least(greatest(coalesce((p->'args'->>'limit')::int, 10), 0), 50);
  v_kinds text[] := coalesce((select array_agg(x) from jsonb_array_elements_text(p->'args'->'kinds') x), '{}');
  v_jobs jsonb; v_pending int;
begin
  delete from booking.stay_calendar_jobs where status in ('done','superseded') and updated_at < now() - interval '30 days';
  with due as (
    select j.id from booking.stay_calendar_jobs j join booking.stays s on s.id = j.stay_id
     where ((j.status = 'pending' and j.available_at <= now()) or (j.status = 'running' and j.locked_until < now()))
       and s.kind = any(v_kinds)
     order by j.available_at, j.created_at
     limit v_limit
     for update of j skip locked
  ), claimed as (
    update booking.stay_calendar_jobs j set status = 'running', locked_until = now() + interval '2 minutes'
      from due where j.id = due.id
    returning j.id, j.stay_id, j.attempts, j.available_at, j.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'jobId', c.id, 'stayId', c.stay_id, 'attempts', c.attempts,
    'stay', (select jsonb_build_object('id', s.id, 'kind', s.kind, 'from_date', s.from_date, 'to_date', s.to_date, 'deleted_at', s.deleted_at)
                    || booking.stay_calendar_names(s) from booking.stays s where s.id = c.stay_id),
    'link', (select jsonb_build_object('calendarId', l.calendar_id, 'providerEventId', l.provider_event_id, 'generation', l.generation,
                    'syncStatus', l.sync_status, 'payloadHash', l.payload_hash) from booking.stay_calendar_links l where l.stay_id = c.stay_id)
  ) order by c.available_at, c.created_at), '[]'::jsonb) into v_jobs from claimed c;
  select count(*) into v_pending from booking.stay_calendar_jobs j join booking.stays s on s.id = j.stay_id
   where j.status in ('pending','running') and s.kind = any(v_kinds)
     and not exists (select 1 from jsonb_array_elements(v_jobs) x where (x->>'jobId')::uuid = j.id);
  return jsonb_build_object('jobs', v_jobs, 'pending', v_pending);
end $$;

-- args: { jobId, outcome: 'done' | 'retry' | 'fatal' | 'blocked', error?, calendarId?, link?: { syncStatus, providerEventId, generation, payloadHash } }
-- Como `calendar_report`: `blocked` devuelve el trabajo a la cola sin gastar intentos.
create or replace function booking.stay_calendar_report(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); j booking.stay_calendar_jobs; v_outcome text := a->>'outcome'; v_link jsonb := a->'link';
  v_code text; v_attempts int; v_status text; v_next timestamptz;
begin
  if v_outcome is null or v_outcome not in ('done','retry','fatal','blocked') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid outcome'));
  end if;
  select * into j from booking.stay_calendar_jobs where id = (a->>'jobId')::uuid for update;
  if j.id is null or j.status <> 'running' then return jsonb_build_object('ignored', true); end if;
  if v_outcome = 'done' then
    update booking.stay_calendar_jobs set status = 'done', locked_until = null, last_error = null where id = j.id;
    if jsonb_typeof(v_link) = 'object' then
      insert into booking.stay_calendar_links (stay_id, calendar_id, provider_event_id, generation, payload_hash, sync_status, last_synced_at)
      values (j.stay_id, coalesce(a->>'calendarId', 'unknown'), v_link->>'providerEventId', coalesce((v_link->>'generation')::int, 1),
              v_link->>'payloadHash', v_link->>'syncStatus', now())
      on conflict (stay_id) do update set calendar_id = excluded.calendar_id, provider_event_id = excluded.provider_event_id,
        generation = excluded.generation, payload_hash = excluded.payload_hash, sync_status = excluded.sync_status,
        last_synced_at = excluded.last_synced_at, last_error = null;
    end if;
    return jsonb_build_object('status', 'done');
  end if;
  v_code := booking.calendar_error_code(a->>'error');
  if v_outcome = 'blocked' then
    v_status := case when exists (select 1 from booking.stay_calendar_jobs o where o.stay_id = j.stay_id and o.status = 'pending') then 'superseded' else 'pending' end;
    update booking.stay_calendar_jobs set status = v_status, locked_until = null, last_error = v_code, available_at = now() + interval '5 minutes' where id = j.id;
    return jsonb_build_object('status', 'blocked');
  end if;
  v_attempts := j.attempts + 1;
  if v_outcome = 'fatal' or v_attempts >= 8 then v_status := 'error';
  elsif exists (select 1 from booking.stay_calendar_jobs o where o.stay_id = j.stay_id and o.status = 'pending') then v_status := 'superseded';
  else v_status := 'pending'; v_next := now() + least(interval '6 hours', interval '1 minute' * power(4, v_attempts - 1));
  end if;
  update booking.stay_calendar_jobs set status = v_status, attempts = v_attempts, locked_until = null, last_error = v_code,
    available_at = coalesce(v_next, available_at) where id = j.id;
  if v_status = 'error' then
    insert into booking.stay_calendar_links (stay_id, calendar_id, sync_status, last_error)
    values (j.stay_id, coalesce(a->>'calendarId', 'unknown'), 'error', v_code)
    on conflict (stay_id) do update set sync_status = 'error', last_error = excluded.last_error;
  end if;
  return jsonb_build_object('status', v_status, 'attempts', v_attempts, 'nextAttemptAt', v_next);
end $$;

-- El mismo tick (`calendar/tick`) procesa las dos colas: la sonda mira también la de estancias.
create or replace function booking.calendar_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from booking.calendar_sync_jobs
                  where (status = 'pending' and available_at <= now())
                     or (status = 'running' and (locked_until is null or locked_until <= now())))
      or exists (select 1 from booking.stay_calendar_jobs
                  where (status = 'pending' and available_at <= now())
                     or (status = 'running' and (locked_until is null or locked_until <= now())));
$$;

-- claim y report son del worker: sin roles de usuario, solo por la ruta de sistema.
select core.allow_read('booking', 'booking.stay_calendar_claim', 'action', '{}');
select core.allow_read('booking', 'booking.stay_calendar_report', 'action', '{}');
select core.allow_read('guests', 'booking.portal_open_retreats', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
