-- Ikisai Booking · Alojamiento libre, tarjeta 5 (VG 27-10-2026; hueco 6 del inventario): ajustes y devoluciones del cobro
-- del alojamiento, con un único apunte en Finance por cobro (`booking:stay:<id del cobro>`, Finance §17.2; patrón F1, con
-- las cabeceras de servidor del #867).
-- - Ajuste: se cambian las noches o el precio por noche del cobro, y el importe vuelve a ser noches × precio.
-- - Devolución: `refund_cents` (hasta lo cobrado), `refund_method` y `refunded_at`. El apunte va por lo cobrado menos lo
--   devuelto, con una línea de detalle negativa y el método de la devolución en negativo. Así los métodos y el desglose
--   suman el importe, como exige Finance.
-- - Cualquier cambio en importe, cobro o devolución de un cobro ya enviado borra `finance_sent_at`: queda «por reenviar».
--   El reenvío sustituye el apunte (mismo `source_ref`), sin duplicarlo; si el apunte ya está en la gestoría, Finance
--   responde ENTRY_LOCKED.
-- Además:
-- - la retención de la plaza por defecto pasa a 2 horas (Core por VG para el fin de semana; se cambia por evento);
-- - `booking.event_reservations_for_invoices({event_ids})`, para la vista Evento de Finance (#904): reserva, evento y
--   estado, sin datos personales.
-- Toca solo el schema booking.

alter table booking.walkin_charges
  add column refund_cents integer not null default 0,
  add column refund_method text check (refund_method is null or refund_method in ('cash', 'bizum', 'bitcoin', 'card')),
  add column refunded_at timestamptz,
  add constraint walkin_charges_refund_range check (refund_cents >= 0 and refund_cents <= amount_cents),
  add constraint walkin_charges_refund_paid check (refund_cents = 0 or paid_at is not null),
  add constraint walkin_charges_refund_fields check ((refund_cents = 0) = (refund_method is null) and (refund_method is null) = (refunded_at is null));
select core.register_table('booking', 'booking', 'walkin_charges',
  array['event_id','assignment_id','guest_id','nights','price_cents','amount_cents','method','paid_at','finance_entry_id','finance_sent_at','finance_error',
        'refund_cents','refund_method','refunded_at'],
  '{editor,owner}', '{editor,owner}');

-- Un cambio de dinero en un cobro ya enviado lo deja por reenviar (el reenvío sustituye el apunte).
create or replace function booking.walkin_charge_stale()
returns trigger language plpgsql as $$
begin
  if old.finance_sent_at is not null and new.finance_sent_at is not distinct from old.finance_sent_at
     and (new.nights, new.price_cents, new.amount_cents, new.method, new.paid_at, new.refund_cents, new.refund_method, new.refunded_at)
         is distinct from (old.nights, old.price_cents, old.amount_cents, old.method, old.paid_at, old.refund_cents, old.refund_method, old.refunded_at) then
    new.finance_sent_at := null;
  end if;
  return new;
end $$;
create trigger walkin_charges_stale before update on booking.walkin_charges
  for each row execute function booking.walkin_charge_stale();

-- Para la Edge: la de 0487 con la devolución.
create or replace function booking.walkin_charge_for_send(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v jsonb;
begin
  begin v_id := (p->'args'->>'id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object(
      'id', c.id, 'event_id', c.event_id, 'nights', c.nights, 'price_cents', c.price_cents, 'amount_cents', c.amount_cents,
      'method', c.method, 'paid_at', c.paid_at, 'paid_day', (c.paid_at at time zone 'Europe/Madrid')::date,
      'refund_cents', c.refund_cents, 'refund_method', c.refund_method,
      'title', r.title, 'guest', btrim(coalesce(g.first_name, '') || coalesce(' ' || upper(left(nullif(btrim(g.last_name_1), ''), 1)) || '.', '')),
      'space', s.name, 'bed', b.label, 'from_date', a.from_date, 'to_date', a.to_date)
    into v
    from booking.walkin_charges c
    join booking.events e on e.id = c.event_id
    join booking.reservations r on r.id = e.reservation_id
    join booking.room_assignments a on a.id = c.assignment_id
    left join booking.guests g on g.id = c.guest_id
    left join booking.spaces s on s.id = a.space_id
    left join booking.beds b on b.id = a.bed_id
   where c.id = v_id and c.deleted_at is null;
  return jsonb_build_object('charge', v);
end $$;

alter table booking.reservations alter column lodging_hold_hours set default 2;

-- Finance (#904): a qué reserva y en qué estado está cada evento, para sumar alojamiento y barra en su vista Evento.
create or replace function booking.event_reservations_for_invoices(p jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('reservation_id', r.id, 'event_id', e.id, 'status', r.status) order by e.id), '[]'::jsonb)
    from booking.events e join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
   where e.deleted_at is null
     and e.id in (select x::uuid from jsonb_array_elements_text(coalesce(p->'args'->'event_ids', '[]'::jsonb)) x
                   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 200)
$$;
select core.allow_read('invoices', 'booking.event_reservations_for_invoices', 'function', '{reader,editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
