-- Ikisai Booking · tanda 27 (MUELA-067 §4 y MUELA-038, «B2»): estado de SES de varias reservas en una lectura, para la
-- bandeja #/ses y los avisos de Inicio. Sustituye a las N llamadas a `booking.ses_status`. Solo lee: no hay escrituras nuevas.
-- Sin nombres ni documentos de huéspedes: de ellos solo salen recuentos, y solo para quien puede ver huéspedes (owner o
-- editor con `scopes.guests`, la misma regla que `canSeeGuests` en `_domain/booking/guests.ts`).

create or replace function booking.actor_sees_guests(p_actor uuid)
returns boolean language sql stable as $$
  select coalesce((select m.role = 'owner' or (m.role = 'editor' and m.scopes->'guests' = 'true'::jsonb)
                     from core.memberships m where m.app = 'booking' and m.user_id = p_actor), false);
$$;

-- Reservas que entran:
-- - confirmadas, en ejecución o cerradas, sin archivar, que terminaron hace menos de 30 días;
-- - con SES activo y el pago registrado en los últimos 90 días sin comunicación aceptada (el plazo legal no se esconde);
-- - cualquiera con una comunicación sin resolver (preparada, enviando, en proceso o con error);
-- - canceladas, perdidas o con SES desactivado que conservan una comunicación aceptada: hay que anularla.
create or replace function booking.ses_overview(p jsonb)
returns jsonb language sql stable as $$
  with sees as (select booking.actor_sees_guests((p->>'actor')::uuid) as ok),
  picked as (
    select r.* from booking.reservations r
      left join booking.reservation_finance f on f.id = r.id and f.deleted_at is null
     where r.deleted_at is null
       and ((r.status in ('confirmada','en_ejecucion','cerrada') and r.archived_at is null and (r.end_date is null or r.end_date >= current_date - 30))
         or (r.ses_enabled and r.status in ('confirmada','en_ejecucion','cerrada') and f.payment_registered_at >= now() - interval '90 days'
             and not exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.deleted_at is null and c.kind = 'RH' and c.status = 'aceptada'))
         or exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.deleted_at is null
                     and c.status in ('preparada','enviando','en_proceso','error'))
         or ((r.status in ('cancelada','perdida') or not r.ses_enabled)
             and exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.deleted_at is null and c.kind = 'RH' and c.status = 'aceptada')))
     order by r.start_date nulls last, r.created_at
     limit 200
  )
  select jsonb_build_object(
    'generated_at', now(),
    'settings', (select jsonb_build_object('environment', coalesce(s.environment, 'pre'), 'paused', coalesce(s.paused, false))
                   from (select 1) x left join booking.ses_settings s on s.deleted_at is null limit 1),
    'items', coalesce((select jsonb_agg(jsonb_build_object(
      'reservation', jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'status', r.status, 'start_date', r.start_date,
        'end_date', r.end_date, 'expected_guests', r.expected_guests, 'final_guests', e.final_guests, 'event_id', e.id,
        'archived_at', r.archived_at, 'ses_enabled', r.ses_enabled, 'ses_disabled_reason', r.ses_disabled_reason,
        'ses_disabled_note', r.ses_disabled_note, 'collect_guest_data', r.collect_guest_data),
      'payment', jsonb_build_object('registered_at', f.payment_registered_at, 'date', f.payment_date),
      'communications', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'kind', c.kind, 'status', c.status, 'environment', c.environment,
          'cancels_id', c.cancels_id, 'lot_id', c.lot_id, 'ses_code', c.ses_code, 'error_code', c.error_code, 'error_text', c.error_text,
          'legal_start_at', c.legal_start_at, 'snapshot', c.snapshot, 'attempts', c.attempts, 'sent_at', c.sent_at, 'accepted_at', c.accepted_at,
          'cancelled_at', c.cancelled_at, 'created_at', c.created_at, 'guests', coalesce(cardinality(c.guest_ids), 0)) order by c.created_at desc)
        from booking.ses_communications c where c.reservation_id = r.id and c.deleted_at is null), '[]'::jsonb),
      'guests', case when (select ok from sees) and e.id is not null then (
        select jsonb_build_object(
          'total', count(*),
          'incomplete', count(*) filter (where cardinality(booking.guest_missing(g, 'ses')) > 0),
          'unsigned', count(*) filter (where booking.signs_own_entry(g, r.start_date) and g.signed_at is null),
          'ready', count(*) filter (where cardinality(booking.guest_missing(g, 'ses')) = 0
                                      and not (booking.signs_own_entry(g, r.start_date) and g.signed_at is null)),
          'arrived', count(*) filter (where g.arrived_at is not null),
          'pending_report', count(*) filter (where g.arrived_at is not null and g.ses_status <> 'enviado_SES'
            and not exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.deleted_at is null and c.kind = 'PV'
                             and c.status in ('preparada','enviando','en_proceso','aceptada','error') and g.id = any(c.guest_ids))))
          from booking.guests g where g.event_id = e.id and g.deleted_at is null and g.ses_status <> 'no_aplica')
        else null end
    ) order by r.start_date nulls last, r.created_at)
    from picked r
    left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
    left join booking.reservation_finance f on f.id = r.id and f.deleted_at is null), '[]'::jsonb));
$$;

select core.allow_read('booking', 'booking.ses_overview', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
