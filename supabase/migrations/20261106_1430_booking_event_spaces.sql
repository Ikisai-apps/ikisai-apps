-- Ikisai Booking · espacios de un evento (decisión de VG del 06-11-2026, booking-U1). Los usos generales de cada espacio
-- (alojamiento, eventos, trabajo…) viven en Recursos y los edita Central; lo propio de cada reserva vive aquí: qué espacios
-- usa ESTE evento. Una fila por espacio marcado. Alimenta el montaje y lo que lean Flow y Food de ese evento.
-- Toca solo el schema booking.

create table booking.event_spaces (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  space_id uuid not null references booking.spaces(id)
);
create unique index event_spaces_event_space_idx on booking.event_spaces (event_id, space_id) where deleted_at is null;
create index event_spaces_space_idx on booking.event_spaces (space_id) where deleted_at is null;
create trigger event_spaces_forbid_reparent before update on booking.event_spaces
  for each row execute function booking.forbid_reparent('event_id');
select core.register_table('booking', 'booking', 'event_spaces', array['event_id','space_id']);

-- Una marca no cambia de espacio (se quita y se pone otra), y solo se marca un espacio vivo.
create or replace function booking.event_space_row()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.space_id is distinct from old.space_id then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.event_spaces', 'field', 'space_id'));
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and not exists (select 1 from booking.spaces s where s.id = new.space_id and s.deleted_at is null) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.event_spaces', 'id', new.id, 'field', 'space_id'));
  end if;
  return new;
end $$;
create trigger event_spaces_row before insert or update on booking.event_spaces
  for each row execute function booking.event_space_row();
