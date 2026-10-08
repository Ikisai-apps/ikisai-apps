-- Ikisai Booking · fase 3 de los portales: lo contratado para el portal (F1) y el proyecto del retiro y sus extras en Tasks
-- (B13; formato de Tasks en docs/tasks/API.md §23, #309). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- F1 · lo contratado (nunca lo pagado, que da Finance): propuesta aceptada, señal, vencimientos y forma de pago acordada.
-- Vencimientos: la señal a los `deposit_days` de la aceptación (o `deposit_days_short` si la entrada está a menos de
-- `short_notice_days`); el saldo el día de entrada.
-- ---------------------------------------------------------------------------
create or replace function booking.portal_contract(p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_p booking.proposals; v_c booking.conditions; v_r booking.reservations; v_f booking.reservation_finance; v_accepted date; v_days int; v_deposit numeric;
begin
  select * into v_p from booking.proposals where reservation_id = p_reservation and status = 'aceptada' and deleted_at is null;
  if v_p.id is null then return null; end if;
  select * into v_c from booking.conditions where id = v_p.conditions_id;
  select * into v_r from booking.reservations where id = p_reservation;
  select * into v_f from booking.reservation_finance where id = p_reservation and deleted_at is null;
  v_accepted := (coalesce(v_p.decided_at, now()) at time zone 'Europe/Madrid')::date;
  v_days := case when v_r.start_date is not null and v_r.start_date - v_accepted < coalesce(v_c.short_notice_days, 15)
                 then coalesce(v_c.deposit_days_short, 2) else coalesce(v_c.deposit_days, 5) end;
  v_deposit := coalesce(v_p.deposit_amount, 0);
  return jsonb_build_object(
    'proposal_version', v_p.version, 'total', v_p.total, 'deposit_required', v_deposit,
    'prices_include_vat', coalesce(v_c.prices_include_vat, true), 'vat_amount', v_p.vat_amount,
    'payment_type', v_f.payment_type,
    'due', jsonb_build_array(
      jsonb_build_object('kind', 'senal', 'date', v_accepted + v_days, 'amount', v_deposit),
      jsonb_build_object('kind', 'saldo', 'date', v_r.start_date, 'amount', greatest(coalesce(v_p.total, 0) - v_deposit, 0))));
end $$;

create or replace function booking.portal_reservation_detail(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations; v_e booking.events; v_contract jsonb;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  select * into v_e from booking.events where reservation_id = v_res and deleted_at is null;
  v_contract := booking.portal_contract(v_res);
  return jsonb_build_object(
    'id', v_r.id, 'code', v_r.code, 'title', v_r.title, 'status', v_r.status, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
    'revision', v_r.revision, 'event_type', v_r.event_type, 'dates_definitive', v_r.dates_definitive, 'organizer_notes', v_r.organizer_notes,
    'special_setup', v_r.special_setup, 'technical_support', v_r.technical_support,
    'expected_guests', v_r.expected_guests, 'final_guests', v_e.final_guests, 'minors_count', v_r.minors_count,
    'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time,
    'meal_plan', coalesce(v_e.meal_plan_confirmed, v_r.meal_plan_requested), 'meal_plan_confirmed', v_e.meal_plan_confirmed is not null,
    'menu_style', coalesce(v_e.menu_style_confirmed, v_r.menu_style_requested), 'menu_style_confirmed', v_e.menu_style_confirmed is not null,
    'uses_accommodation', v_r.uses_accommodation, 'requires_meals', v_r.requires_meals, 'uses_interpretation_center', v_r.uses_interpretation_center,
    'uses_outdoors', v_r.uses_outdoors, 'uses_pool', v_r.uses_pool,
    'mode', booking.guest_mode(v_res), 'confirmed', v_e.id is not null, 'contract', v_contract,
    'lodging', coalesce((select jsonb_agg(jsonb_build_object('space', s.name, 'kind', s.kind, 'zone', s.zone, 'persons', x.persons) order by s.zone nulls last, s.position)
      from (select a.space_id, sum(a.persons)::int persons from booking.room_assignments a where a.event_id = v_e.id and a.deleted_at is null group by a.space_id) x
      join booking.spaces s on s.id = x.space_id), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- B13 · proyecto del retiro en Tasks y una tarea por extra contratado. Estado sincronizado en tablas cerradas; el tick
-- calcula qué falta (como la cola de Calendar) y llama a Tasks con la cuenta de servicio.
-- ---------------------------------------------------------------------------
create table booking.tasks_projects (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null unique references booking.reservations(id),
  project_id text check (project_id is null or length(project_id) <= 80),
  synced_date date,
  synced_title text,
  synced_state text check (synced_state is null or synced_state in ('confirmed','cancelled')),
  last_status text check (last_status is null or length(last_status) <= 40),
  synced_at timestamptz
);
select core.register_table('booking', 'booking', 'tasks_projects', array[]::text[], '{}', '{}');

create table booking.tasks_extras (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  proposal_line_id uuid not null unique references booking.proposal_lines(id),
  task_id text check (task_id is null or length(task_id) <= 80),
  synced_at timestamptz not null default now()
);
select core.register_table('booking', 'booking', 'tasks_extras', array[]::text[], '{}', '{}');

-- Proyectos que crear, renombrar, archivar o desarchivar: reservas confirmadas (o en ejecución o cerradas) con fecha cuya
-- sincronización no coincide, y reservas canceladas, perdidas o archivadas que ya tenían proyecto activo.
create or replace function booking.tasks_projects_due(p_limit int)
returns table (reservation_id uuid, code text, title text, start_date date, state text)
language sql stable as $$
  select r.id, r.code, r.title, r.start_date,
         case when r.deleted_at is null and r.archived_at is null and r.status in ('confirmada','en_ejecucion','cerrada') then 'confirmed' else 'cancelled' end
    from booking.reservations r
    left join booking.tasks_projects t on t.reservation_id = r.id
   where r.start_date is not null and r.code is not null
     and (
       (r.deleted_at is null and r.archived_at is null and r.status in ('confirmada','en_ejecucion','cerrada')
         and (t.id is null or t.synced_state is distinct from 'confirmed' or t.synced_date is distinct from r.start_date or t.synced_title is distinct from r.title))
       or (t.synced_state = 'confirmed' and (r.deleted_at is not null or r.archived_at is not null or r.status in ('cancelada','perdida')))
     )
   order by r.start_date
   limit greatest(1, least(coalesce(p_limit, 20), 50));
$$;

-- Extras contratados (líneas de extra de la propuesta aceptada) de reservas con proyecto ya creado, sin tarea todavía.
create or replace function booking.tasks_extras_due(p_limit int)
returns table (proposal_line_id uuid, reservation_id uuid, code text, start_date date, description text, quantity numeric, line_position numeric)
language sql stable as $$
  select l.id, r.id, r.code, r.start_date, l.description, l.quantity, l.position
    from booking.proposal_lines l
    join booking.rates rt on rt.id = l.rate_id and rt.layer = 'extra'
    join booking.proposals p on p.id = l.proposal_id and p.status = 'aceptada' and p.deleted_at is null
    join booking.reservations r on r.id = p.reservation_id and r.deleted_at is null and r.archived_at is null and r.status in ('confirmada','en_ejecucion','cerrada')
    join booking.tasks_projects t on t.reservation_id = r.id and t.synced_state = 'confirmed' and t.project_id is not null
   where l.deleted_at is null and not exists (select 1 from booking.tasks_extras x where x.proposal_line_id = l.id)
   order by r.start_date, l.position
   limit greatest(1, least(coalesce(p_limit, 50), 100));
$$;

create or replace function booking.tasks_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from booking.tasks_projects_due(1)) or exists (select 1 from booking.tasks_extras_due(1));
$$;

create or replace function booking.tasks_due(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'projects', coalesce((select jsonb_agg(to_jsonb(x)) from booking.tasks_projects_due(20) x), '[]'::jsonb),
    'extras', coalesce((select jsonb_agg(to_jsonb(x)) from booking.tasks_extras_due(50) x), '[]'::jsonb));
$$;

create or replace function booking.tasks_project_mark(p jsonb)
returns jsonb language plpgsql as $$
declare v_a jsonb := p->'args';
begin
  insert into booking.tasks_projects (reservation_id, project_id, synced_date, synced_title, synced_state, last_status, synced_at)
  values ((v_a->>'reservation_id')::uuid, v_a->>'project_id', (v_a->>'date')::date, v_a->>'title', v_a->>'state', v_a->>'status', now())
  on conflict (reservation_id) do update set project_id = coalesce(excluded.project_id, booking.tasks_projects.project_id),
    synced_date = excluded.synced_date, synced_title = excluded.synced_title, synced_state = excluded.synced_state,
    last_status = excluded.last_status, synced_at = now(), updated_at = now(), revision = booking.tasks_projects.revision + 1;
  return jsonb_build_object('ok', true);
end $$;

create or replace function booking.tasks_extra_mark(p jsonb)
returns jsonb language plpgsql as $$
begin
  insert into booking.tasks_extras (proposal_line_id, task_id) values ((p->'args'->>'proposal_line_id')::uuid, p->'args'->>'task_id')
  on conflict (proposal_line_id) do nothing;
  return jsonb_build_object('ok', true);
end $$;

select core.allow_read('booking', 'booking.tasks_due', 'action', '{}');
select core.allow_read('booking', 'booking.tasks_project_mark', 'action', '{}');
select core.allow_read('booking', 'booking.tasks_extra_mark', 'action', '{}');
select core.schedule_tick('booking', 'tasks/tick', '*/5 * * * *', 'booking.tasks_has_work');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
