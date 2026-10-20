-- Invoices · tanda 31: las emitidas de una reserva, una a una, para «Movimientos» del extracto de Booking. Toca solo el schema invoices.
--
-- Lectura de app (no de portal): Booking la llama con `read/invoices.reservation_movements {reservation_ids}`.
-- Las mismas facturas que `reservation_collected` (0222) y que `totals` de F1 (0220): las asignadas a la reserva y sus
-- rectificativas, que restan; sin borradores ni anuladas. Así la suma de `total` es `invoiced` y la de las cobradas, `collected`.
-- Por factura: número, fecha, concepto, propósito, si es rectificativa, importe y si está cobrada (con su fecha).
-- Nada del destinatario (nombre, NIF, país ni otros destinatarios) ni notas internas: Booking ya sabe de quién es la reserva.
-- Como mucho 500 ids por llamada; un id inválido es INVALID_OPERATION. Una reserva sin facturas no sale.

create or replace function invoices.reservation_movements(p jsonb)
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
        'issued_invoice_id', i.id,
        'full_number', i.full_number,
        'issue_date', i.issue_date,
        'concept', i.description,
        'purpose', i.purpose,
        'kind', case when i.invoice_type like 'R%' then 'rectificativa' else 'factura' end,
        'total', i.total,
        'collected', i.payment_status = 'cobrada',
        'paid_at', case when i.payment_status = 'cobrada' then i.paid_at end)
      order by r.id, i.issue_date, i.full_number)
    from unnest(v_ids) r(id)
    join invoices.issued_invoices i on i.id in (select invoices.portal_reservation_invoice_ids(r.id))
    where i.status <> 'anulada'), '[]'::jsonb);
end $$;
select core.allow_read('booking', 'invoices.reservation_movements', 'function');

revoke all on function invoices.reservation_movements(jsonb) from public, anon, authenticated;
