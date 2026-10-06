-- Ikisai Booking · Calendar: resultado «blocked» en la cola (docs/booking/API.md §7.3).
-- Cuando el fallo no es del trabajo sino del acceso (calendario sin compartir con la cuenta de servicio, credenciales
-- rechazadas), el trabajo vuelve a `pending` sin gastar intentos y con un código legible en `last_error`.
-- Lo arregla una persona, no un reintento: el worker hace una sola llamada a Google por vuelta mientras dure.

-- args: { jobId, outcome: 'done' | 'retry' | 'fatal' | 'blocked', error?: código corto, calendarId?,
--         link?: { syncStatus: 'synced' | 'deleted', providerEventId, generation, htmlLink, payloadHash,
--                  sourceReservationRevision, sourceEventRevision } }
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
  v_newer boolean;
begin
  if v_outcome is null or v_outcome not in ('done','retry','fatal','blocked') then
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
    else
      -- Trabajo sin cambios que anotar (p. ej. reserva cerrada): si el enlace arrastraba un código de bloqueo, se limpia.
      update booking.calendar_links set last_error = null where reservation_id = j.reservation_id and sync_status <> 'error';
    end if;
    return jsonb_build_object('status', 'done');
  end if;

  v_code := booking.calendar_error_code(a->>'error');
  v_newer := exists (select 1 from booking.calendar_sync_jobs o where o.reservation_id = j.reservation_id and o.status = 'pending');

  if v_outcome = 'blocked' then
    -- Vuelve a la cola tal cual; si ya hay un trabajo más nuevo esperando, ese recoge el testigo.
    update booking.calendar_sync_jobs
      set status = case when v_newer then 'superseded' else 'pending' end, locked_until = null, last_error = v_code, available_at = now()
      where id = j.id;
    update booking.calendar_sync_jobs set last_error = v_code where reservation_id = j.reservation_id and status = 'pending';
    update booking.calendar_links set last_error = v_code where reservation_id = j.reservation_id;
    return jsonb_build_object('status', 'pending', 'attempts', j.attempts, 'blocked', true);
  end if;

  v_attempts := j.attempts + 1;
  if v_outcome = 'fatal' or v_attempts >= 8 then
    v_status := 'error';
  elsif v_newer then
    v_status := 'superseded';
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

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
