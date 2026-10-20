-- Ikisai Booking · tanda 30 (MUELA-086 §3, firmado en la 067): el personal de solo lectura ve los precios del
-- calendario («Fines de semana libres»). Son tarifas, no costes. Solo lee, y solo lo justo para calcular el precio en el
-- dispositivo con el mismo dominio (`priceCalendar`): las tarifas activas (sin «incluye», notas ni datos del portal), las
-- condiciones por defecto (señal, IVA y mínimo; sin el texto), las fechas de los bloqueos (sin su motivo interno) y las
-- fechas ofrecidas por Ikisai a las reservas abiertas. Las reservas ya las lee el lector.

create or replace function booking.price_calendar_source(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'rates', coalesce((select jsonb_agg(jsonb_build_object(
        'id', r.id, 'name', r.name, 'layer', r.layer, 'unit', r.unit, 'amount', r.amount, 'service', r.service,
        'min_persons', r.min_persons, 'max_persons', r.max_persons, 'event_types', r.event_types,
        'valid_from', r.valid_from, 'valid_to', r.valid_to, 'active', r.active, 'position', r.position) order by r.position, r.id)
      from booking.rates r where r.deleted_at is null and r.active), '[]'::jsonb),
    'conditions', (select jsonb_build_object('id', c.id, 'deposit_percent', c.deposit_percent, 'deposit_minimum', c.deposit_minimum,
        'prices_include_vat', c.prices_include_vat, 'vat_rate', c.vat_rate, 'minimum_total', c.minimum_total)
      from booking.conditions c where c.deleted_at is null and c.active
      order by c.is_default desc, c.created_at, c.id limit 1),
    'blocks', coalesce((select jsonb_agg(jsonb_build_object('start_date', b.start_date, 'end_date', b.end_date) order by b.start_date, b.id)
      from booking.date_blocks b where b.deleted_at is null and b.end_date >= current_date), '[]'::jsonb),
    'options', coalesce((select jsonb_agg(jsonb_build_object('reservation_id', o.reservation_id, 'start_date', o.start_date,
        'end_date', o.end_date, 'proposed_by', o.proposed_by) order by o.start_date, o.id)
      from booking.reservation_date_options o
      join booking.reservations r on r.id = o.reservation_id and r.deleted_at is null
        and r.status in ('en_estudio','negociacion','pre_reservada') and r.archived_at is null
     where o.deleted_at is null and o.proposed_by = 'ikisai' and o.end_date >= current_date), '[]'::jsonb));
$$;

select core.allow_read('booking', 'booking.price_calendar_source', 'function', '{reader,editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
