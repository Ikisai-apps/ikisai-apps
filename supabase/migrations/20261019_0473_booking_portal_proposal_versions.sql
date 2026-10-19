-- Ikisai Booking · tanda 27 (petición de Organizers, «Comparar versiones»): `booking.portal_proposals` con
-- `include_history: true` devuelve también las versiones sustituidas y caducadas, con el mismo formato, su `status` y, en
-- las sustituidas, `superseded_by_version`. Nunca borradores ni rechazadas. Sin el argumento, lo de siempre (enviadas y
-- aceptadas): el portal de hoy no cambia hasta que Organizers pida el historial.

create or replace function booking.portal_proposals(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_history boolean := coalesce(p->'args'->>'include_history', '') = 'true';
begin
  v_r := booking.portal_reservation_row(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'nature', x.nature, 'start_date', x.start_date, 'end_date', x.end_date,
        'persons', x.persons, 'subtotal', x.subtotal, 'adjustments', x.adjustments, 'vat_amount', x.vat_amount, 'total', x.total, 'deposit_amount', x.deposit_amount,
        'valid_until', x.valid_until, 'includes', x.includes, 'excludes', x.excludes, 'sent_at', x.sent_at, 'decided_at', x.decided_at,
        'superseded_by_version', case when x.status = 'sustituida' then (select min(y.version) from booking.proposals y where y.reservation_id = x.reservation_id
            and y.deleted_at is null and y.version > x.version and y.status in ('enviada','aceptada','sustituida','caducada')) end,
        'conditions', (select jsonb_build_object('name', c.name, 'text', booking.conditions_text(c.id), 'prices_include_vat', c.prices_include_vat, 'vat_rate', c.vat_rate,
            'deposit_percent', c.deposit_percent, 'deposit_minimum', c.deposit_minimum, 'deposit_days', c.deposit_days, 'deposit_days_short', c.deposit_days_short,
            'short_notice_days', c.short_notice_days,
            'tiers', coalesce((select jsonb_agg(jsonb_build_object('min_days_before', t.min_days_before, 'deposit_refund_pct', t.deposit_refund_pct, 'extra_costs', t.extra_costs)
              order by t.min_days_before desc) from booking.cancellation_tiers t where t.conditions_id = c.id and t.deleted_at is null), '[]'::jsonb))
          from booking.conditions c where c.id = x.conditions_id),
        'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'unit', l.unit, 'quantity', l.quantity, 'unit_amount', l.unit_amount,
            'discount_pct', l.discount_pct, 'amount', l.amount) order by l.position) from booking.proposal_lines l where l.proposal_id = x.id and l.deleted_at is null), '[]'::jsonb))
      order by x.version desc)
      from booking.proposals x where x.reservation_id = v_r.id and x.deleted_at is null and (x.status in ('enviada','aceptada') or (v_history and x.status in ('sustituida','caducada')))), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
