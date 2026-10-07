-- Ikisai Booking · planificador con sonda (core.schedule_tick, #220): pg_cron solo despierta la Edge de Booking si la sonda
-- de su schema dice que hay trabajo. Toca solo el schema booking.

-- SES: comunicaciones por enviar o consultar, o avisos de plazo pendientes (lo mismo que miran booking.ses_due y
-- booking.ses_deadlines).
create or replace function booking.ses_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from booking.ses_communications
                  where status in ('preparada','en_proceso','error') and (next_attempt_at is null or next_attempt_at <= now()))
      or exists (select 1 from booking.reservations r join booking.reservation_finance f on f.id = r.id and f.deleted_at is null
                  where r.deleted_at is null and r.archived_at is null and r.ses_enabled and r.status in ('confirmada','en_ejecucion')
                    and f.payment_registered_at <= now() - interval '12 hours'
                    and not exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.kind = 'RH' and c.status in ('en_proceso','aceptada'))
                    and not exists (select 1 from booking.ses_deadline_notices n where n.reservation_id = r.id and n.legal_start_at = f.payment_registered_at));
$$;

-- Calendar: trabajos pendientes ya disponibles, o en curso con el bloqueo caducado (un tick que murió a medias).
create or replace function booking.calendar_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from booking.calendar_sync_jobs
                  where (status = 'pending' and available_at <= now())
                     or (status = 'running' and (locked_until is null or locked_until <= now())));
$$;

select core.schedule_tick('booking', 'ses/tick', '*/5 * * * *', 'booking.ses_has_work');
-- sustituye el tick de Calendar sin sonda (core 0050, mismo nombre de trabajo)
select core.schedule_tick('booking', 'calendar/tick', '*/5 * * * *', 'booking.calendar_has_work');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
