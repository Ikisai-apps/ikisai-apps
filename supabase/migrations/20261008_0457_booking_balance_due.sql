-- Ikisai Booking · el saldo vence N horas después de terminar el evento (decisión del usuario, 8-10-2026; 24 por defecto),
-- como ajuste versionado de las condiciones. Toca solo el schema booking.

alter table booking.conditions add column balance_due_hours_after_end integer not null default 24 check (balance_due_hours_after_end between 0 and 2160);
select core.register_table('booking', 'booking', 'conditions', array['name','deposit_percent','deposit_minimum','deposit_days',
  'deposit_days_short','short_notice_days','prices_include_vat','vat_rate','text','is_default','active','minimum_total','balance_due_hours_after_end'], '{editor,owner}', '{owner}');

create or replace function booking.portal_contract(p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_p booking.proposals; v_c booking.conditions; v_r booking.reservations; v_f booking.reservation_finance; v_e booking.events;
  v_accepted date; v_days int; v_deposit numeric; v_hours int; v_balance_at timestamptz; v_balance_date date;
begin
  select * into v_p from booking.proposals where reservation_id = p_reservation and status = 'aceptada' and deleted_at is null;
  if v_p.id is null then return null; end if;
  select * into v_c from booking.conditions where id = v_p.conditions_id;
  select * into v_r from booking.reservations where id = p_reservation;
  select * into v_f from booking.reservation_finance where id = p_reservation and deleted_at is null;
  select * into v_e from booking.events where reservation_id = p_reservation and deleted_at is null;
  -- saldo: `balance_due_hours_after_end` horas después del final del evento (con hora de salida, desde ella; si no, desde el
  -- final del día de salida)
  v_hours := coalesce(v_c.balance_due_hours_after_end, 24);
  if v_r.end_date is not null and v_e.departure_time is not null then
    v_balance_at := ((v_r.end_date + v_e.departure_time)::timestamp at time zone 'Europe/Madrid') + make_interval(hours => v_hours);
    v_balance_date := (v_balance_at at time zone 'Europe/Madrid')::date;
  elsif v_r.end_date is not null then
    v_balance_date := v_r.end_date + ceil(v_hours / 24.0)::int;
  end if;
  v_accepted := (coalesce(v_p.decided_at, now()) at time zone 'Europe/Madrid')::date;
  v_days := case when v_r.start_date is not null and v_r.start_date - v_accepted < coalesce(v_c.short_notice_days, 15)
                 then coalesce(v_c.deposit_days_short, 2) else coalesce(v_c.deposit_days, 5) end;
  v_deposit := coalesce(v_p.deposit_amount, 0);
  return jsonb_build_object(
    'proposal_version', v_p.version, 'total', v_p.total, 'deposit_required', v_deposit,
    'prices_include_vat', coalesce(v_c.prices_include_vat, true), 'vat_amount', v_p.vat_amount,
    'payment_type', v_f.payment_type,
    'due', jsonb_build_array(
      jsonb_build_object('kind', 'senal', 'date', v_accepted + v_days, 'amount', v_deposit),
      jsonb_build_object('kind', 'saldo', 'date', v_balance_date, 'at', v_balance_at, 'hours_after_end', v_hours,
        'amount', greatest(coalesce(v_p.total, 0) - v_deposit, 0))));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
