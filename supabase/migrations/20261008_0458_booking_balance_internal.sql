-- Ikisai Booking · corrección (aclaración del usuario, 8-10-2026): las 24 h tras el fin del evento son el plazo máximo
-- INTERNO para exigir el saldo, no un vencimiento que vea el organizador. Se renombra el ajuste y el portal deja de ver la
-- fecha del saldo (solo su importe). Toca solo el schema booking.

alter table booking.conditions rename column balance_due_hours_after_end to balance_deadline_hours_after_end;
select core.register_table('booking', 'booking', 'conditions', array['name','deposit_percent','deposit_minimum','deposit_days',
  'deposit_days_short','short_notice_days','prices_include_vat','vat_rate','text','is_default','active','minimum_total','balance_deadline_hours_after_end'], '{editor,owner}', '{owner}');

create or replace function booking.portal_contract(p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_p booking.proposals; v_c booking.conditions; v_r booking.reservations; v_f booking.reservation_finance;
  v_accepted date; v_days int; v_deposit numeric;
begin
  select * into v_p from booking.proposals where reservation_id = p_reservation and status = 'aceptada' and deleted_at is null;
  if v_p.id is null then return null; end if;
  select * into v_c from booking.conditions where id = v_p.conditions_id;
  select * into v_r from booking.reservations where id = p_reservation;
  select * into v_f from booking.reservation_finance where id = p_reservation and deleted_at is null;
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
      -- el saldo, solo con su importe: el plazo máximo es interno de Ikisai y el portal no lo ve
      jsonb_build_object('kind', 'saldo', 'amount', greatest(coalesce(v_p.total, 0) - v_deposit, 0))));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
