-- Ikisai Booking · cobro del alojamiento a la carta (VG 27-10-2026): en jornadas abiertas, «Alojar a alguien» anota las
-- noches y el precio por noche (de la tarifa), se cobra en el momento (efectivo, Bizum o tarjeta en el datáfono) o queda
-- pendiente, y al cobrar Booking manda el ingreso a Finance (`invoices.record_app_entry`, source_ref
-- `booking:stay:<id>`), con la sesión de la persona, desde booking-api (`POST walkins/:id/send/finance`).
-- - `booking.walkin_charges`: un cobro por asignación de cama. `amount_cents = nights × price_cents`. Cobrado = `method` y
--   `paid_at` a la vez. El resultado del envío a Finance (`finance_entry_id`, `finance_sent_at` o `finance_error`) lo anota
--   la app tras la llamada. Solo lo ven y escriben editor y owner (importes).
-- - `booking.walkin_charge_for_send`: lo que necesita la Edge para el apunte (sin datos personales de más).
-- Toca solo el schema booking.

create table booking.walkin_charges (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  assignment_id uuid not null references booking.room_assignments(id),
  guest_id uuid references booking.guests(id),
  nights integer not null check (nights between 1 and 60),
  price_cents integer not null check (price_cents >= 0),
  amount_cents integer not null check (amount_cents >= 0),
  method text check (method is null or method in ('cash', 'bizum', 'card')),
  paid_at timestamptz,
  finance_entry_id uuid,
  finance_sent_at timestamptz,
  finance_error text check (finance_error is null or char_length(finance_error) <= 300),
  constraint walkin_charges_amount check (amount_cents = nights * price_cents),
  constraint walkin_charges_paid check ((method is null) = (paid_at is null)),
  constraint walkin_charges_sent_needs_paid check (finance_sent_at is null or paid_at is not null)
);
create unique index walkin_charges_assignment_live on booking.walkin_charges (assignment_id) where deleted_at is null;
create index walkin_charges_event_idx on booking.walkin_charges (event_id) where deleted_at is null;
select core.register_table('booking', 'booking', 'walkin_charges',
  array['event_id','assignment_id','guest_id','nights','price_cents','amount_cents','method','paid_at','finance_entry_id','finance_sent_at','finance_error'],
  '{editor,owner}', '{editor,owner}');

-- Para la Edge: el cobro con lo que va al apunte de Finance.
create or replace function booking.walkin_charge_for_send(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v jsonb;
begin
  begin v_id := (p->'args'->>'id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object(
      'id', c.id, 'event_id', c.event_id, 'nights', c.nights, 'price_cents', c.price_cents, 'amount_cents', c.amount_cents,
      'method', c.method, 'paid_at', c.paid_at, 'paid_day', (c.paid_at at time zone 'Europe/Madrid')::date,
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
select core.allow_read('booking', 'booking.walkin_charge_for_send', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
