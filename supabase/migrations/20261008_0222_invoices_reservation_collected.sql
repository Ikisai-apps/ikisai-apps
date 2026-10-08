-- Invoices · lo facturado y lo cobrado por reserva, para Booking (ronda 52). Toca solo el schema invoices.
--
-- Booking compara su aviso «Saldo pendiente: plazo máximo vencido» con lo cobrado de verdad, que es de Finance.
-- Lectura de app (no de portal): la llama Booking con `read/invoices.reservation_collected {reservation_ids}`.
-- Misma suma que `totals` de F1 (0220): facturas del retiro (asignadas a la reserva y sus rectificativas, que restan),
-- sin borradores ni anuladas. Solo importes y fecha: nada de clientes, números ni datos internos.
-- Una reserva sin facturas sale con ceros. Como mucho 500 ids por llamada; un id inválido es INVALID_OPERATION.

create or replace function invoices.reservation_collected(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_ids uuid[];
begin
  if jsonb_typeof(p->'args'->'reservation_ids') is distinct from 'array' or jsonb_array_length(p->'args'->'reservation_ids') > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'reservation_ids', 'reason', 'array of up to 500 uuids'));
  end if;
  begin
    select coalesce(array_agg(distinct x::uuid), '{}') into v_ids from jsonb_array_elements_text(p->'args'->'reservation_ids') x;
  exception when others then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'reservation_ids', 'reason', 'invalid uuid'));
  end;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'reservation_id', r.id,
        'invoiced', coalesce((select sum(i.total) from invoices.issued_invoices i
          where i.id in (select invoices.portal_reservation_invoice_ids(r.id)) and i.status <> 'anulada'), 0),
        'collected', coalesce((select sum(i.total) from invoices.issued_invoices i
          where i.id in (select invoices.portal_reservation_invoice_ids(r.id)) and i.status <> 'anulada' and i.payment_status = 'cobrada'), 0),
        'last_collected_at', (select max(i.paid_at) from invoices.issued_invoices i
          where i.id in (select invoices.portal_reservation_invoice_ids(r.id)) and i.status <> 'anulada' and i.payment_status = 'cobrada'))
      order by r.id)
    from unnest(v_ids) r(id)), '[]'::jsonb);
end $$;
select core.allow_read('booking', 'invoices.reservation_collected', 'function');

revoke all on function invoices.reservation_collected(jsonb) from public, anon, authenticated;
