-- Ikisai Booking · factura a petición de las noches (VG, vg-38: ticket de Finance siempre y factura con NIF a petición;
-- contrato con Finance del 27-10-2026). Booking no guarda los datos fiscales: la ruta los reenvía a Finance
-- (`worker/entry-invoice`), uno por cobro (`booking:stay:<cobro>`).
-- - `booking.stay_charges_of({request_id, visitor_id})` (acción de sistema): los cobros de la solicitud aceptada del visitante
--   (las fichas de `booking.stay_guests_of`, 1419), con si están cobrados, enviados a Finance y devueltos. Solo el visitante
--   dueño.
-- Toca solo el schema booking.

create or replace function booking.stay_charges_of(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := coalesce(p->'args', '{}'::jsonb); q booking.visitor_requests;
begin
  select * into q from booking.visitor_requests where id = nullif(a->>'request_id', '')::uuid and deleted_at is null;
  if q.id is null or q.kind <> 'stay' or q.visitor_id is distinct from nullif(a->>'visitor_id', '')::uuid then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests'));
  end if;
  if q.status <> 'aceptada' then return jsonb_build_object('status', q.status, 'charges', '[]'::jsonb); end if;
  return jsonb_build_object('status', q.status, 'charges', coalesce((
    select jsonb_agg(jsonb_build_object('id', c.id, 'amount_cents', c.amount_cents, 'refund_cents', c.refund_cents,
             'paid', c.paid_at is not null, 'sent', c.finance_sent_at is not null) order by c.created_at, c.id)
      from booking.walkin_charges c where c.guest_id in (select booking.stay_guests_of(q)) and c.deleted_at is null), '[]'::jsonb));
end $$;
select core.allow_read('booking', 'booking.stay_charges_of', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
