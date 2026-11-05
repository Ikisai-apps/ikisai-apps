-- Ikisai Booking · «Alójate aquí» (contrato con Guests, VG 05-11): el contacto del visitante y el pedido de prueba.
-- - B-32: `booking_visitor_requests` y `booking_visitor_stay` devuelven también `contact`, el teléfono o correo que el propio
--   visitante dejó, para que Guests lo rellene en su siguiente pedido. Solo lo ve ese visitante (las dos lecturas filtran
--   por su `visitor_id`); al personal le llega como siempre por la tabla.
-- - G-12 (dirección y staff eligen en cada pedido si es una prueba o se cobra): `visitor_requests.is_test`. Desde el
--   visitante solo vale si es un miembro (`core.visitor_member`); si no, se ignora. Una prueba no se cobra: total 0 y, si
--   pedía pagar en línea, se paga en recepción (nunca abre la pasarela). Si alguien la acepta, sus cobros salen a 0 € y
--   Finance no apunta nada. Recepción la ve como «Prueba» y la puede descartar. Las lecturas del visitante devuelven `test`.
-- Toca solo el schema booking.

alter table booking.visitor_requests add column is_test boolean not null default false;
select core.register_table('booking', 'booking', 'visitor_requests', array['event_id','via_code','visitor_id','kind','name','contact','note','status','guest_id','decided_at',
  'from_date','to_date','persons','rate_id','total_cents','pay_mode','hold_bed_ids','hold_until','number','is_test'],
  '{editor,owner}', '{editor,owner}');

-- Después del guard (que calcula el total y el modo de pago): por nombre, los triggers before van en orden alfabético.
create or replace function booking.visitor_request_test()
returns trigger language plpgsql as $$
begin
  if new.kind <> 'stay' then new.is_test := false; return new; end if;
  if core.is_public_batch() and new.is_test and core.visitor_member(new.visitor_id) is null then new.is_test := false; end if;
  if new.is_test then
    new.total_cents := 0;
    if new.pay_mode = 'online' then new.pay_mode := 'hold'; end if;
  end if;
  return new;
end $$;
create trigger visitor_requests_test before insert on booking.visitor_requests
  for each row execute function booking.visitor_request_test();

create or replace function booking.visitor_item(q booking.visitor_requests)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', q.id, 'event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
           'created_at', q.created_at, 'decided_at', q.decided_at,
           'from', q.from_date, 'to', q.to_date, 'persons', q.persons, 'mode_id', q.rate_id, 'total_cents', q.total_cents, 'pay', q.pay_mode,
           'hold_until', q.hold_until, 'hold_expired', q.kind = 'stay' and q.pay_mode in ('hold', 'online') and q.status = 'pendiente' and (q.hold_until is null or q.hold_until <= now()),
           'number', q.number, 'stay_status', booking.stay_status_of(q), 'beds', booking.stay_beds_of(q),
           'paid_at', (select max(c.paid_at) from booking.walkin_charges c where q.guest_id is not null and c.guest_id = q.guest_id and c.deleted_at is null),
           'missing', booking.stay_missing_of(q),
           'paid_online', exists (select 1 from booking.stay_payments sp where sp.request_id = q.id and sp.status = 'paid'),
           -- 1419: lo que se devolvería si cancela ahora (solo lo pagado en línea y aún sin cancelar)
           'cancel', case when q.kind = 'stay' and q.status in ('pendiente', 'aceptada') and exists (select 1 from booking.stay_payments sp
             where sp.request_id = q.id and sp.status in ('paid', 'partially_refunded') and sp.deleted_at is null) then booking.stay_cancel_quote_of(q, now()) end,
           -- 1428: lo que dejó el propio visitante (B-32) y si es una prueba (G-12)
           'contact', q.contact, 'test', q.is_test)
    from booking.events e where e.id = q.event_id
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
