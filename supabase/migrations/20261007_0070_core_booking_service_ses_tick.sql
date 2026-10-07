-- Ikisai Core · identidad de servicio de Booking y planificador de SES.HOSPEDAJES (peticiones de Booking, SES-2).
-- Booking avisa a Tasks del plazo legal de SES desde su worker (sin persona): escribe en Tasks como «Booking (sistema)».

create or replace function core.service_grants(p_name text)
returns jsonb language sql immutable as $$
  select case p_name
    when 'feedback' then jsonb_build_object('displayName', 'Feedback (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    when 'booking' then jsonb_build_object('displayName', 'Booking (sistema)', 'memberships', jsonb_build_array(jsonb_build_object('app', 'tasks', 'role', 'editor')))
    else null end
$$;
revoke all on function core.service_grants(text) from public, anon, authenticated;
grant execute on function core.service_grants(text) to service_role;

-- SES: cada 5 minutos, solo si hay comunicaciones por enviar o consultar, o avisos de plazo pendientes (consulta de Booking).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    execute $q$select cron.schedule('ikisai-booking-ses-tick', '*/5 * * * *', $c$select core.worker_tick('booking', 'ses/tick')
      where exists (select 1 from booking.ses_communications where status in ('preparada','en_proceso','error') and (next_attempt_at is null or next_attempt_at <= now()))
         or exists (select 1 from booking.reservations r join booking.reservation_finance f on f.id = r.id
                     where r.deleted_at is null and r.archived_at is null and r.ses_enabled and r.status in ('confirmada','en_ejecucion')
                       and f.payment_registered_at <= now() - interval '12 hours'
                       and not exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.kind = 'RH' and c.status in ('en_proceso','aceptada'))
                       and not exists (select 1 from booking.ses_deadline_notices n where n.reservation_id = r.id and n.legal_start_at = f.payment_registered_at))$c$)$q$;
  end if;
end $$;
