-- Ikisai Booking · código público del evento (VG, visión V0.2, 27-10-2026): el QR de entrada de visitantes a
-- ven.ikisai.com lleva un código corto que no se puede adivinar, y una lectura pública (sin sesión) devuelve solo lo
-- público del evento a partir de él.
-- - `booking.events.public_code`: 10 caracteres de un alfabeto sin ambigüedades (sin 0/O ni 1/I/L), al azar con
--   `gen_random_uuid` (aleatorio fuerte), único. Lo pone un trigger al crear el evento y se rellena para los que ya hay.
--   «Regenerar» en la ficha lo cambia (un update normal con un código nuevo del cliente; el formato lo comprueban la base
--   y el dominio), y el QR anterior deja de valer.
-- - `core.allow_public_read('booking_event', 'booking.public_event')`: {code} → {code, name, starts_on, ends_on, kind,
--   status ('abierto' | 'cerrado'), joinable, summary}. Sin precio, organizador, huéspedes ni ids. Código desconocido,
--   cancelado o borrado: null. La sirve la Edge del portal que abre ven.ikisai.com.
-- Toca solo el schema booking.

create or replace function booking.new_public_code()
returns text language plpgsql volatile as $$
declare
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := decode(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''), 'hex');
  v_out text := '';
  i int;
begin
  for i in 0..9 loop
    v_out := v_out || substr(v_alphabet, (get_byte(v_bytes, i * 3) % length(v_alphabet)) + 1, 1);
  end loop;
  return v_out;
end $$;

alter table booking.events add column public_code text
  check (public_code is null or public_code ~ '^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$');
create unique index events_public_code_idx on booking.events (public_code) where public_code is not null;

create or replace function booking.event_public_code()
returns trigger language plpgsql as $$
declare v_try int := 0;
begin
  if new.public_code is null then
    loop
      new.public_code := booking.new_public_code();
      exit when not exists (select 1 from booking.events where public_code = new.public_code);
      v_try := v_try + 1;
      if v_try > 5 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no public code')); end if;
    end loop;
  end if;
  return new;
end $$;
create trigger events_public_code before insert on booking.events
  for each row execute function booking.event_public_code();

-- Los eventos que ya hay
do $$
declare r record; v text;
begin
  for r in select id from booking.events where public_code is null loop
    loop
      v := booking.new_public_code();
      exit when not exists (select 1 from booking.events where public_code = v);
    end loop;
    update booking.events set public_code = v where id = r.id;
  end loop;
end $$;

select core.register_table('booking', 'booking', 'events', array[
  'reservation_id','responsible_name','arrival_time','departure_time','final_guests',
  'meal_plan_confirmed','menu_style_confirmed','room_distribution','rooms_count','setup_style','technical_needs',
  'reinforced_cleaning','extra_support','preparation_status','accommodation_status','kitchen_status','cleaning_status',
  'traveler_registration_status','operational_notes','closed_at','incidents','post_event_notes','public_code']);

-- Lectura pública: solo lo público del evento, por su código.
create or replace function booking.public_event(p jsonb)
returns jsonb language sql stable as $$
  select case when r.id is null then null else jsonb_build_object(
      'code', e.public_code, 'name', r.title, 'starts_on', r.start_date, 'ends_on', r.end_date, 'kind', r.event_type,
      'status', case when r.status in ('pre_reservada', 'confirmada', 'en_ejecucion') and r.archived_at is null then 'abierto' else 'cerrado' end,
      'joinable', r.guests_visible and r.archived_at is null and r.status in ('pre_reservada', 'confirmada', 'en_ejecucion'),
      'summary', case when r.guests_visible then r.public_summary end) end
    from booking.events e
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.status not in ('cancelada', 'perdida')
   where e.deleted_at is null and e.public_code = upper(btrim(coalesce(p->>'code', '')))
$$;
select core.allow_public_read('booking_event', 'booking.public_event');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
