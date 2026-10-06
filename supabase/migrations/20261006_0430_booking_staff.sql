-- Ikisai Booking · ampliación V2, bloque 2: personal en eventos (turnos y necesidades de refuerzo).
-- Referencia: docs/booking/API.md §15.3 (visto bueno de Core, rondas 15 y 16). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Turnos del personal en un evento (C05 «asignaciones»). Solo el nombre de la persona: sin teléfono ni documento.
-- ---------------------------------------------------------------------------
create table booking.staff_assignments (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  person_name text not null check (length(btrim(person_name)) between 1 and 120),
  member_user_id uuid references auth.users(id),
  -- enlace tipado futuro a la ficha de personal (Encarna)
  person_ref_app text check (person_ref_app is null or person_ref_app = 'encarna'),
  person_ref_id text check (person_ref_id is null or length(person_ref_id) between 1 and 120),
  function text not null check (function in ('coordinacion_general','acogida_grupo','cocina','apoyo_cocina','limpieza_previa',
    'limpieza_rotacion','mantenimiento_guardia','soporte_tecnico','apoyo_logistico','cierre_evento','otra')),
  work_date date,
  planned_hours numeric(5,2) check (planned_hours is null or planned_hours >= 0),
  actual_hours numeric(5,2) check (actual_hours is null or actual_hours >= 0),
  status text not null default 'prevista' check (status in ('prevista','confirmada','realizada','cancelada')),
  notes text,
  position numeric not null default 0,
  constraint staff_assignments_ref check ((person_ref_app is null) = (person_ref_id is null)),
  -- un turno de un día no pasa de 24 horas
  constraint staff_assignments_day check (work_date is null or ((planned_hours is null or planned_hours <= 24) and (actual_hours is null or actual_hours <= 24)))
);
create index staff_assignments_event_idx on booking.staff_assignments (event_id, position) where deleted_at is null;
create trigger staff_assignments_forbid_reparent before update on booking.staff_assignments
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'staff_assignments', array['event_id','person_name','member_user_id','person_ref_app',
  'person_ref_id','function','work_date','planned_hours','actual_hours','status','notes','position']);

-- ---------------------------------------------------------------------------
-- Necesidades de refuerzo (C05 «refuerzos»). Pasan a «cubierto» a mano: no se cruzan solas con los turnos.
-- ---------------------------------------------------------------------------
create table booking.staff_needs (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  need_type text not null check (need_type in ('cocina','limpieza','mantenimiento','tecnico','acogida','mixto')),
  persons integer not null default 1 check (persons >= 1),
  priority text not null default 'media' check (priority in ('baja','media','alta','urgente')),
  status text not null default 'detectado' check (status in ('detectado','buscando','cubierto')),
  notes text
);
create index staff_needs_event_idx on booking.staff_needs (event_id) where deleted_at is null;
create trigger staff_needs_forbid_reparent before update on booking.staff_needs
  for each row execute function booking.forbid_reparent('event_id');

select core.register_table('booking', 'booking', 'staff_needs', array['event_id','need_type','persons','priority','status','notes']);

-- ---------------------------------------------------------------------------
-- Invariantes del bloque, al final de cada lote: nada vivo colgando de un evento borrado.
-- ---------------------------------------------------------------------------
create or replace function booking.check_staff_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select a.id into v_id from booking.staff_assignments a join booking.events e on e.id = a.event_id
   where a.deleted_at is null and e.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.staff_assignments', 'id', v_id)); end if;

  select n.id into v_id from booking.staff_needs n join booking.events e on e.id = n.event_id
   where n.deleted_at is null and e.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'booking.staff_needs', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('booking', 'booking.check_staff_invariants');

-- ---------------------------------------------------------------------------
-- Proyección para Invoices (coste de personal por evento). Sin nombres: `staff_ref` es un identificador estable
-- (miembro, ficha de personal o la propia asignación). Invoices pone las tarifas por función.
-- ---------------------------------------------------------------------------
create view booking.invoices_staff_hours_projection as
select a.id as assignment_id, a.event_id, e.code as event_code, r.id as reservation_id, r.code as reservation_code,
       a.function, coalesce(a.member_user_id::text, a.person_ref_id, a.id::text) as staff_ref,
       a.work_date, a.planned_hours, a.actual_hours, a.status, a.revision
  from booking.staff_assignments a
  join booking.events e on e.id = a.event_id and e.deleted_at is null
  join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null
 where a.deleted_at is null;

revoke all on booking.invoices_staff_hours_projection from public, anon, authenticated;
grant select on booking.invoices_staff_hours_projection to service_role;
select core.allow_read('invoices', 'booking.invoices_staff_hours_projection', 'view');
select core.allow_read('booking', 'booking.invoices_staff_hours_projection', 'view');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
