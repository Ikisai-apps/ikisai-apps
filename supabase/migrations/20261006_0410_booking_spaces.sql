-- Ikisai Booking · ampliación V2, bloque 1: espacios, camas y asignación de alojamiento por evento.
-- Referencia: docs/booking/API.md §15.1 (visto bueno de Core, ronda 15). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Inventario de espacios: habitaciones, salas y zonas
-- ---------------------------------------------------------------------------
create table booking.spaces (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null check (kind in ('habitacion','sala','zona_exterior','otro')),
  zone text check (zone is null or length(zone) <= 120),
  capacity integer check (capacity is null or capacity >= 0),
  accessible boolean not null default false,
  active boolean not null default true,
  position numeric not null default 0,
  notes text
);
create index spaces_position_idx on booking.spaces (zone, position) where deleted_at is null;
create trigger spaces_assign_code before insert on booking.spaces
  for each row execute function booking.assign_code('ESP');

select core.register_table('booking', 'booking', 'spaces', array['name','kind','zone','capacity','accessible','active','position','notes']);

-- ---------------------------------------------------------------------------
-- Camas de cada habitación
-- ---------------------------------------------------------------------------
create table booking.beds (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  space_id uuid not null references booking.spaces(id),
  label text not null check (length(btrim(label)) between 1 and 80),
  kind text not null default 'individual' check (kind in ('individual','doble','litera','sofa_cama','supletoria')),
  capacity integer not null default 1 check (capacity between 1 and 2),
  active boolean not null default true,
  position numeric not null default 0
);
create index beds_space_idx on booking.beds (space_id, position) where deleted_at is null;
create trigger beds_forbid_reparent before update on booking.beds
  for each row execute function booking.forbid_reparent('space_id');

select core.register_table('booking', 'booking', 'beds', array['space_id','label','kind','capacity','active','position']);

-- ---------------------------------------------------------------------------
-- Quién duerme (o está) dónde en un evento
-- ---------------------------------------------------------------------------
create table booking.room_assignments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  space_id uuid not null references booking.spaces(id),
  bed_id uuid references booking.beds(id),
  guest_id uuid references booking.guests(id),
  group_label text check (group_label is null or length(btrim(group_label)) between 1 and 120),
  persons integer not null default 1 check (persons >= 1),
  from_date date,
  to_date date,
  notes text,
  constraint room_assignments_who check ((guest_id is not null and group_label is null and persons = 1) or (guest_id is null and group_label is not null)),
  constraint room_assignments_dates check (from_date is null or to_date is null or to_date > from_date)
);
create index room_assignments_event_idx on booking.room_assignments (event_id) where deleted_at is null;
create index room_assignments_bed_idx on booking.room_assignments (bed_id) where deleted_at is null and bed_id is not null;
create trigger room_assignments_forbid_reparent before update on booking.room_assignments
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'room_assignments', array['event_id','space_id','bed_id','guest_id','group_label','persons','from_date','to_date','notes']);

-- ---------------------------------------------------------------------------
-- Invariantes del bloque, al final de cada lote. En SQL y no solo en la Edge: dos dispositivos que asignan la misma
-- cama sin red no deben poder colarla al sincronizar (Core, ronda 15).
-- ---------------------------------------------------------------------------
create or replace function booking.check_space_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid; v_other uuid;
begin
  -- nada vivo colgando de algo borrado
  select b.id into v_id from booking.beds b join booking.spaces s on s.id = b.space_id
   where b.deleted_at is null and s.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.beds', 'id', v_id)); end if;

  select a.id into v_id from booking.room_assignments a
    join booking.events e on e.id = a.event_id
    join booking.spaces s on s.id = a.space_id
    left join booking.beds b on b.id = a.bed_id
   where a.deleted_at is null and (e.deleted_at is not null or s.deleted_at is not null or b.deleted_at is not null) limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.room_assignments', 'id', v_id)); end if;

  -- la cama es de ese espacio
  select a.id into v_id from booking.room_assignments a join booking.beds b on b.id = a.bed_id
   where a.deleted_at is null and b.space_id <> a.space_id limit 1;
  if v_id is not null then perform core.fail('BED_SPACE_MISMATCH', 422, jsonb_build_object('id', v_id)); end if;

  -- el huésped es de ese evento y está vivo
  select a.id into v_id from booking.room_assignments a join booking.guests g on g.id = a.guest_id
   where a.deleted_at is null and (g.deleted_at is not null or g.event_id <> a.event_id) limit 1;
  if v_id is not null then perform core.fail('GUEST_MISMATCH', 422, jsonb_build_object('table', 'booking.room_assignments', 'id', v_id)); end if;

  -- regla dura: una cama, una ocupación por noche, entre eventos de reservas vivas y no canceladas ni archivadas.
  -- Las noches van de la fecha de entrada (incluida) a la de salida (excluida): la salida de uno puede ser la entrada del otro.
  with live as (
    select a.id, a.bed_id,
           coalesce(a.from_date, r.start_date) as d_from,
           coalesce(a.to_date, r.end_date) as d_to
      from booking.room_assignments a
      join booking.events e on e.id = a.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
     where a.deleted_at is null and a.bed_id is not null
       and r.status not in ('cancelada','perdida') and r.archived_at is null
  )
  select x.id, y.id into v_id, v_other from live x join live y
    on x.bed_id = y.bed_id and x.id < y.id and x.d_from < y.d_to and y.d_from < x.d_to
   limit 1;
  if v_id is not null then perform core.fail('BED_OVERBOOKED', 422, jsonb_build_object('id', v_id, 'conflictsWith', v_other)); end if;
end $$;

select core.add_validate_hook('booking', 'booking.check_space_invariants');

-- ---------------------------------------------------------------------------
-- Proyección del inventario para Tasks (incidencias de mantenimiento ligadas a un espacio). Sin ocupación ni huéspedes.
-- ---------------------------------------------------------------------------
create view booking.tasks_space_projection as
select s.id as space_id, s.code, s.name, s.kind, s.zone, s.active, s.revision
  from booking.spaces s
 where s.deleted_at is null;

revoke all on booking.tasks_space_projection from public, anon, authenticated;
grant select on booking.tasks_space_projection to service_role;
select core.allow_read('tasks', 'booking.tasks_space_projection', 'view');
select core.allow_read('booking', 'booking.tasks_space_projection', 'view');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
