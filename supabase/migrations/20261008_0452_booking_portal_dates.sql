-- Ikisai Booking · fase 2 de los portales, parte 1: fecha definitiva, fechas posibles, bloqueos, disponibilidad y avisos
-- (Organizers B6, B7a–c y B8; ajustes de Booking aprobados por Core el 7-10-2026). «Ikisai fija y el organizador propone»:
-- el organizador marca posibilidades y nunca fija la fecha. Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- B7a · fecha definitiva (solo el personal)
-- ---------------------------------------------------------------------------
alter table booking.reservations add column dates_definitive boolean not null default false;
alter table booking.reservations add constraint reservations_definitive_dates check (not dates_definitive or (start_date is not null and end_date is not null));

select core.register_table('booking', 'booking', 'reservations', array[
  'title','event_type','status','priority','start_date','end_date','expected_guests','minors_count',
  'contact_name','contact_phone','contact_email','customer_type',
  'uses_accommodation','requires_meals','meal_plan_requested','menu_style_requested','meal_notes',
  'uses_interpretation_center','uses_outdoors','uses_pool','special_setup','technical_support',
  'customer_notes','briefing_received','internal_notes','archived_at',
  'ses_enabled','ses_disabled_reason','ses_disabled_note','collect_guest_data','dates_definitive']);

-- ---------------------------------------------------------------------------
-- B7b · fechas posibles: las propone Ikisai (personal) o el organizador (portal); nunca bloquean
-- ---------------------------------------------------------------------------
create table booking.reservation_date_options (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  start_date date not null,
  end_date date not null,
  arrival_time time,
  departure_time time,
  proposed_by text not null default 'ikisai' check (proposed_by in ('ikisai','organizer')),
  organizer_ok boolean not null default false,
  position numeric not null default 0,
  constraint reservation_date_options_range check (end_date > start_date)
);
create index reservation_date_options_reservation_idx on booking.reservation_date_options (reservation_id, position) where deleted_at is null;
create trigger reservation_date_options_forbid_reparent before update on booking.reservation_date_options
  for each row execute function booking.forbid_reparent('reservation_id');
select core.register_table('booking', 'booking', 'reservation_date_options',
  array['reservation_id','start_date','end_date','arrival_time','departure_time','proposed_by','organizer_ok','position'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- B6 · bloqueos manuales del personal (el motivo es interno: el portal solo ve «ocupado»)
-- ---------------------------------------------------------------------------
create table booking.date_blocks (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  start_date date not null,
  end_date date not null,
  reason text check (reason is null or length(reason) <= 300),
  constraint date_blocks_range check (end_date > start_date)
);
create index date_blocks_range_idx on booking.date_blocks (start_date, end_date) where deleted_at is null;
select core.register_table('booking', 'booking', 'date_blocks', array['start_date','end_date','reason'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Cola de avisos del portal al comercial (Inicio y Tasks), que vacía `portal/tick`. Tabla cerrada.
-- ---------------------------------------------------------------------------
create table booking.portal_notices (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  kind text not null check (kind in ('fechas','quiere_confirmar','comentario')),
  actor uuid references auth.users(id),
  notified_at timestamptz,
  attempts integer not null default 0
);
create index portal_notices_pending_idx on booking.portal_notices (created_at) where notified_at is null;
select core.register_table('booking', 'booking', 'portal_notices', array[]::text[], '{}', '{}');

-- ---------------------------------------------------------------------------
-- Disponibilidad. Noches [entrada, salida). `ocupado`: bloqueo, o reserva viva con evento (confirmada, en ejecución o
-- cerrada) o pre-reservada con fecha definitiva. `en_opcion`: pre-reserva, negociación o estudio con fecha definitiva o con
-- opciones propuestas por Ikisai. La reserva propia no cuenta.
-- ---------------------------------------------------------------------------
create or replace function booking.range_availability(p_start date, p_end date, p_own uuid)
returns text language sql stable as $$
  select case
    when exists (select 1 from booking.date_blocks b where b.deleted_at is null and b.start_date < p_end and p_start < b.end_date)
      or exists (select 1 from booking.reservations r
                  where r.deleted_at is null and r.archived_at is null and r.id is distinct from p_own
                    and r.start_date < p_end and p_start < r.end_date
                    and (r.status in ('confirmada','en_ejecucion','cerrada') or (r.status = 'pre_reservada' and r.dates_definitive)))
      then 'ocupado'
    when exists (select 1 from booking.reservations r
                  where r.deleted_at is null and r.archived_at is null and r.id is distinct from p_own
                    and r.status in ('en_estudio','negociacion','pre_reservada')
                    and ((r.dates_definitive and r.start_date < p_end and p_start < r.end_date)
                      or exists (select 1 from booking.reservation_date_options o where o.reservation_id = r.id and o.deleted_at is null
                                  and o.proposed_by = 'ikisai' and o.start_date < p_end and p_start < o.end_date)))
      then 'en_opcion'
    else 'libre' end;
$$;

-- ¿Puede el organizador escribir sobre esta reserva desde su portal? (ámbito y reserva viva, no cancelada ni perdida)
create or replace function booking.portal_reservation_row(p jsonb)
returns booking.reservations language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null and archived_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  return v_r;
end $$;

-- B6 · disponibilidad por fin de semana (viernes a domingo: noches de viernes y sábado), sin decir quién. Máximo 18 meses.
create or replace function booking.portal_availability(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_from date; v_to date; v_today date := (now() at time zone 'Europe/Madrid')::date;
begin
  v_r := booking.portal_reservation_row(p);
  begin v_from := coalesce((p->'args'->>'from')::date, v_today); v_to := coalesce((p->'args'->>'to')::date, v_from + 365); exception when others then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'from y to deben ser fechas')); end;
  v_from := greatest(v_from, v_today);
  v_to := least(v_to, v_from + interval '18 months');
  return jsonb_build_object('from', v_from, 'to', v_to, 'weekends', coalesce((
    select jsonb_agg(jsonb_build_object('start', f::date, 'end', (f + interval '2 days')::date, 'status', booking.range_availability(f::date, (f + interval '2 days')::date, v_r.id)) order by f)
      from generate_series(v_from + ((5 - extract(isodow from v_from)::int + 7) % 7), v_to, interval '7 days') f), '[]'::jsonb));
end $$;

-- B7c · fechas para el portal: definitiva, opciones de Ikisai o calendario libre.
create or replace function booking.portal_dates(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations; v_e booking.events; v_mode text;
begin
  v_r := booking.portal_reservation_row(p);
  select * into v_e from booking.events where reservation_id = v_r.id and deleted_at is null;
  v_mode := case when v_r.dates_definitive then 'fixed'
                 when exists (select 1 from booking.reservation_date_options o where o.reservation_id = v_r.id and o.deleted_at is null and o.proposed_by = 'ikisai') then 'ikisai_options'
                 else 'calendar' end;
  return jsonb_build_object('mode', v_mode,
    'definitive', case when v_mode = 'fixed' then jsonb_build_object('start', v_r.start_date, 'end', v_r.end_date, 'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time) end,
    'options', case when v_mode = 'fixed' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', o.id, 'start', o.start_date, 'end', o.end_date, 'arrival_time', o.arrival_time, 'departure_time', o.departure_time,
          'proposed_by', o.proposed_by, 'organizer_ok', o.organizer_ok, 'availability', booking.range_availability(o.start_date, o.end_date, v_r.id)) order by o.position, o.start_date)
        from booking.reservation_date_options o
       where o.reservation_id = v_r.id and o.deleted_at is null and o.proposed_by = case when v_mode = 'ikisai_options' then 'ikisai' else 'organizer' end), '[]'::jsonb) end);
end $$;

-- B8 · fechas posibles del organizador: con opciones de Ikisai marca cuáles le vienen bien; sin ellas, sustituye las suyas.
-- Nunca fija la fecha. Avisa al comercial por la cola.
create or replace function booking.portal_set_date_preferences(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_r booking.reservations; v_ops jsonb := '[]'::jsonb; v_item jsonb; o booking.reservation_date_options; v_ok boolean;
  v_start date; v_end date; v_ikisai boolean; v_pos int := 0; v_out jsonb;
begin
  v_r := booking.portal_reservation_row(p);
  if v_r.status in ('cancelada','perdida') then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_r.id)); end if;
  if v_r.dates_definitive then perform core.fail('DATES_FIXED', 422, jsonb_build_object('reservation_id', v_r.id)); end if;
  if jsonb_typeof(p->'args'->'options') <> 'array' or jsonb_array_length(p->'args'->'options') > 20 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'options debe ser una lista (como mucho 20)'));
  end if;
  v_ikisai := exists (select 1 from booking.reservation_date_options where reservation_id = v_r.id and deleted_at is null and proposed_by = 'ikisai');

  if v_ikisai then
    for v_item in select * from jsonb_array_elements(p->'args'->'options') loop
      if v_item ? 'start' or not (v_item ? 'option_id') then perform core.fail('DATE_NOT_OFFERED', 422, jsonb_build_object('reservation_id', v_r.id)); end if;
      select * into o from booking.reservation_date_options where id = (v_item->>'option_id')::uuid and reservation_id = v_r.id and deleted_at is null and proposed_by = 'ikisai';
      if o.id is null then perform core.fail('DATE_NOT_OFFERED', 422, jsonb_build_object('option_id', v_item->>'option_id')); end if;
      v_ok := coalesce((v_item->>'ok')::boolean, false);
      if v_ok and booking.range_availability(o.start_date, o.end_date, v_r.id) = 'ocupado' then
        perform core.fail('DATE_UNAVAILABLE', 422, jsonb_build_object('option_id', o.id));
      end if;
      if o.organizer_ok is distinct from v_ok then
        v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.reservation_date_options', 'id', o.id, 'expectedRevision', o.revision, 'fields', jsonb_build_object('organizer_ok', v_ok));
      end if;
    end loop;
  else
    for o in select * from booking.reservation_date_options where reservation_id = v_r.id and deleted_at is null and proposed_by = 'organizer' loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.reservation_date_options', 'id', o.id, 'expectedRevision', o.revision);
    end loop;
    for v_item in select * from jsonb_array_elements(p->'args'->'options') loop
      begin v_start := (v_item->>'start')::date; v_end := (v_item->>'end')::date; exception when others then v_start := null; end;
      if v_start is null or v_end is null or v_end <= v_start or v_start < (now() at time zone 'Europe/Madrid')::date then
        perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'cada opción necesita start < end, sin fechas pasadas'));
      end if;
      if booking.range_availability(v_start, v_end, v_r.id) = 'ocupado' then perform core.fail('DATE_UNAVAILABLE', 422, jsonb_build_object('start', v_start, 'end', v_end)); end if;
      v_pos := v_pos + 1;
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.reservation_date_options', 'id', gen_random_uuid(), 'fields',
        jsonb_build_object('reservation_id', v_r.id, 'start_date', v_start, 'end_date', v_end, 'proposed_by', 'organizer', 'organizer_ok', true, 'position', v_pos));
    end loop;
  end if;

  if v_ops = '[]'::jsonb then return jsonb_build_object('reservation_id', v_r.id, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  insert into booking.portal_notices (reservation_id, kind, actor) values (v_r.id, 'fechas', (p->>'actor')::uuid);
  return jsonb_build_object('reservation_id', v_r.id, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Avisos pendientes para el tick y su marca (acciones del sistema)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_notices_due(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind, 'reservation_id', n.reservation_id,
      'code', r.code, 'title', r.title, 'created_at', n.created_at) order by n.created_at), '[]'::jsonb))
    from (select * from booking.portal_notices where notified_at is null and attempts < 20 order by created_at limit 20) n
    join booking.reservations r on r.id = n.reservation_id;
$$;

create or replace function booking.portal_notice_mark(p jsonb)
returns jsonb language plpgsql as $$
begin
  if coalesce((p->'args'->>'ok')::boolean, false) then
    update booking.portal_notices set notified_at = now(), attempts = attempts + 1 where id = (p->'args'->>'id')::uuid;
  else
    update booking.portal_notices set attempts = attempts + 1 where id = (p->'args'->>'id')::uuid;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function booking.portal_has_work()
returns boolean language sql stable as $$ select exists (select 1 from booking.portal_notices where notified_at is null and attempts < 20) $$;

select core.allow_read('organizers', 'booking.portal_availability', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_dates', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_set_date_preferences', 'action', '{editor,owner}');
select core.allow_read('booking', 'booking.portal_notices_due', 'action', '{}');
select core.allow_read('booking', 'booking.portal_notice_mark', 'action', '{}');
select core.schedule_tick('booking', 'portal/tick', '*/5 * * * *', 'booking.portal_has_work');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
