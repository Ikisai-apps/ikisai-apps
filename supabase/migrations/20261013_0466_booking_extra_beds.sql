-- Ikisai Booking · supletorias activables por el organizador para su retiro (aprobado por el usuario el 13-10-2026,
-- coordinacion/booking/RESPUESTAS.md). El organizador elige **cuántas** por habitación; Booking elige cuáles (primero las
-- ocupadas, después por orden). Se cobra la activada aunque nadie la ocupe (y la ocupada sin activar, como hoy). Activar es
-- inmediato mientras la propuesta no esté aceptada; con propuesta aceptada queda pendiente y se avisa al comercial. El
-- «quién y dónde» es el reparto de siempre (`room_assignments` con `source = 'organizer'`, B17), ampliado a las activadas.
-- Para Guests (BG13), las activadas salen en `rooms[].beds` con `kind: 'supletoria'` y aparte en `extra_total`/`extra_free`;
-- `beds_total` y `beds_free` no cambian. Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Supletorias activadas por evento (una fila por cama)
-- ---------------------------------------------------------------------------
create table booking.event_extra_beds (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  bed_id uuid not null references booking.beds(id),
  -- quién la activó (sale de quién escribe, nunca del cliente)
  source text not null default 'staff' check (source in ('guest','organizer','staff')),
  -- active: activada · requested: pedida con la propuesta aceptada, pendiente de Ikisai · release_requested: activada y
  -- pedida su retirada con la propuesta aceptada (se sigue cobrando hasta que Ikisai la quite)
  status text not null default 'active' check (status in ('active','requested','release_requested'))
);
create unique index event_extra_beds_event_bed_idx on booking.event_extra_beds (event_id, bed_id) where deleted_at is null;
create index event_extra_beds_bed_idx on booking.event_extra_beds (bed_id) where deleted_at is null;
create trigger event_extra_beds_forbid_reparent before update on booking.event_extra_beds
  for each row execute function booking.forbid_reparent('event_id');
select core.register_table('booking', 'booking', 'event_extra_beds', array['event_id','bed_id','status']);

-- Quién activa sale de quién escribe. Solo se activa una supletoria viva (el resto de reglas, al final del lote).
create or replace function booking.event_extra_bed_row()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then new.source := booking.writer(); end if;
  if tg_op = 'UPDATE' then
    new.source := old.source;
    if new.bed_id is distinct from old.bed_id then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.event_extra_beds', 'field', 'bed_id')); end if;
  end if;
  if new.deleted_at is null and (tg_op = 'INSERT' or old.deleted_at is not null)
     and not exists (select 1 from booking.beds b where b.id = new.bed_id and b.deleted_at is null and b.kind = 'supletoria') then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.event_extra_beds', 'id', new.id, 'field', 'bed_id'));
  end if;
  return new;
end $$;
create trigger event_extra_beds_row before insert or update on booking.event_extra_beds
  for each row execute function booking.event_extra_bed_row();

-- ---------------------------------------------------------------------------
-- Ayudas
-- ---------------------------------------------------------------------------
-- ¿La usa otro evento solapado (activada o con alguien asignado)? Noches [entrada, salida), como `BED_OVERBOOKED`.
create or replace function booking.extra_bed_used_elsewhere(p_bed uuid, p_event uuid)
returns boolean language sql stable as $$
  with mine as (
    select r.start_date d_from, r.end_date d_to from booking.events e join booking.reservations r on r.id = e.reservation_id where e.id = p_event),
  other as (
    select e.id event_id, r.start_date, r.end_date from booking.events e
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
     where e.deleted_at is null and e.id <> p_event)
  select exists (
    select 1 from booking.room_assignments a join other o on o.event_id = a.event_id cross join mine
     where a.bed_id = p_bed and a.deleted_at is null and coalesce(a.from_date, o.start_date) < mine.d_to and mine.d_from < coalesce(a.to_date, o.end_date))
  or exists (
    select 1 from booking.event_extra_beds x join other o on o.event_id = x.event_id cross join mine
     where x.bed_id = p_bed and x.deleted_at is null and o.start_date < mine.d_to and mine.d_from < o.end_date);
$$;

-- Supletorias usables del evento en un espacio: las activadas (también con la retirada pedida) y las que el personal ya
-- ocupó sin activar (se cobran igual, como hoy).
create or replace function booking.event_extra_bed_ids(p_event uuid, p_space uuid)
returns setof uuid language sql stable as $$
  select b.id from booking.beds b
   where b.space_id = p_space and b.deleted_at is null and b.active and b.kind = 'supletoria'
     and (exists (select 1 from booking.event_extra_beds x where x.event_id = p_event and x.bed_id = b.id and x.deleted_at is null and x.status in ('active','release_requested'))
       or exists (select 1 from booking.room_assignments a where a.event_id = p_event and a.bed_id = b.id and a.deleted_at is null));
$$;

-- ¿Hay propuesta aceptada? Entonces activar o retirar cambia lo contratado y queda pendiente de Ikisai.
create or replace function booking.reservation_accepted(p_reservation uuid)
returns boolean language sql stable as $$
  select exists (select 1 from booking.proposals where reservation_id = p_reservation and status = 'aceptada' and deleted_at is null);
$$;

-- Al final del lote: una supletoria no puede estar activada por dos eventos solapados, ni activada por uno y ocupada por
-- otro. Las camas borradas (p. ej. quitadas en Recursos) no bloquean nada: su activación deja de contar.
create or replace function booking.check_extra_beds(p jsonb)
returns void language plpgsql as $$
declare v_id uuid; v_other uuid;
begin
  with live as (
    select x.id, x.bed_id, x.event_id, r.start_date d_from, r.end_date d_to from booking.event_extra_beds x
      join booking.beds b on b.id = x.bed_id and b.deleted_at is null
      join booking.events e on e.id = x.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
     where x.deleted_at is null)
  select x.id, y.id into v_id, v_other from live x join live y on x.bed_id = y.bed_id and x.id < y.id and x.d_from < y.d_to and y.d_from < x.d_to limit 1;
  if v_id is not null then perform core.fail('EXTRA_BED_TAKEN', 409, jsonb_build_object('id', v_id, 'conflictsWith', v_other)); end if;

  with live as (
    select x.id, x.bed_id, x.event_id, r.start_date d_from, r.end_date d_to from booking.event_extra_beds x
      join booking.beds b on b.id = x.bed_id and b.deleted_at is null
      join booking.events e on e.id = x.event_id and e.deleted_at is null
      join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
     where x.deleted_at is null)
  select x.id, a.id into v_id, v_other from live x
    join booking.room_assignments a on a.bed_id = x.bed_id and a.deleted_at is null and a.event_id <> x.event_id
    join booking.events e on e.id = a.event_id and e.deleted_at is null
    join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.archived_at is null and r.status not in ('cancelada','perdida')
   where coalesce(a.from_date, r.start_date) < x.d_to and x.d_from < coalesce(a.to_date, r.end_date) limit 1;
  if v_id is not null then perform core.fail('EXTRA_BED_TAKEN', 409, jsonb_build_object('id', v_id, 'conflictsWith', v_other)); end if;
end $$;
select core.add_validate_hook('booking', 'booking.check_extra_beds');

-- ---------------------------------------------------------------------------
-- Habitación para los portales: las camas fijas como hoy y, detrás, las supletorias usables del evento (BG13). Al
-- organizador, además, el contador de supletorias de la habitación.
-- ---------------------------------------------------------------------------
-- Contador de supletorias de una habitación del retiro, para el «− / +» del organizador y la ficha del personal.
-- `possible`: las que se pueden activar (vivas, activas y libres de otros eventos, o ya del evento) · `activated`: las que
-- se cobran · `wanted`: las pedidas (activadas sin retirada pedida + pendientes) · `occupied`: con alguien asignado.
create or replace function booking.portal_extra_counts(p_event uuid, p_space uuid)
returns jsonb language sql stable as $$
  with beds as (select b.id from booking.beds b where b.space_id = p_space and b.deleted_at is null and b.active and b.kind = 'supletoria'),
  xs as (select x.bed_id, x.status from booking.event_extra_beds x where x.event_id = p_event and x.deleted_at is null and x.bed_id in (select id from beds)),
  occupied as (select distinct a.bed_id from booking.room_assignments a where a.event_id = p_event and a.deleted_at is null and a.bed_id in (select id from beds))
  select jsonb_build_object(
    'possible', (select count(*) from beds b where b.id in (select bed_id from xs) or b.id in (select bed_id from occupied) or not booking.extra_bed_used_elsewhere(b.id, p_event)),
    'activated', (select count(*) from booking.event_extra_bed_ids(p_event, p_space)),
    'wanted', (select count(*) from (select bed_id from xs where status in ('active','requested') union select bed_id from occupied) w),
    'requested', (select count(*) from xs where status = 'requested'),
    'release_requested', (select count(*) from xs where status = 'release_requested'),
    'occupied', (select count(*) from occupied));
$$;

create or replace function booking.portal_room_json(p_space uuid, p_event uuid, p_guest uuid, p_org boolean)
returns jsonb language sql stable as $$
  with extras as (select id from booking.event_extra_bed_ids(p_event, p_space) id),
  shown as (
    select b.* from booking.beds b where b.space_id = p_space and b.deleted_at is null and b.active and (b.kind <> 'supletoria' or b.id in (select id from extras)))
  select jsonb_build_object('space_id', s.id, 'name', booking.space_public_name(s), 'zone', s.zone, 'kind', s.kind, 'capacity', s.capacity,
    'en_suite', s.en_suite, 'small_en_suite', s.en_suite and coalesce(s.capacity, 0) between 2 and 4,
    'option_key', o.option_key, 'open', o.id is not null, 'supplement', coalesce(o.supplement, false),
    'beds_total', (select count(*) from shown b where b.kind <> 'supletoria'),
    'beds_free', (select count(*) from shown b where b.kind <> 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'extra_total', (select count(*) from shown b where b.kind = 'supletoria'),
    'extra_free', (select count(*) from shown b where b.kind = 'supletoria' and booking.bed_free(b.id, p_event, p_guest)),
    'beds', coalesce((select jsonb_agg(jsonb_build_object('bed_id', b.id, 'label', b.label, 'kind', b.kind, 'free', booking.bed_free(b.id, p_event, p_guest),
        'mine', exists (select 1 from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.guest_id = p_guest and a.deleted_at is null))
        || case when p_org then coalesce((select jsonb_build_object('assignment_id', a.id, 'guest_id', a.guest_id, 'group_label', a.group_label, 'status', a.status, 'source', a.source)
              from booking.room_assignments a where a.bed_id = b.id and a.event_id = p_event and a.deleted_at is null limit 1), '{}'::jsonb) else '{}'::jsonb end
        order by b.kind = 'supletoria', b.position, b.label)
      from shown b), '[]'::jsonb))
    || case when p_org then jsonb_build_object('extra', booking.portal_extra_counts(p_event, p_space)) else '{}'::jsonb end
  from booking.spaces s left join booking.open_rooms o on o.space_id = s.id and o.event_id = p_event and o.deleted_at is null
  where s.id = p_space;
$$;

-- ---------------------------------------------------------------------------
-- Organizers · inventario del retiro con el contador y el precio de la supletoria (si su tarifa es visible en el portal)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_rooms(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_e booking.events := booking.portal_program_event(p); v_s booking.lodging_settings := booking.lodging_settings_of(v_e.id); v_r booking.reservations;
begin
  select * into v_r from booking.reservations where id = v_e.reservation_id;
  return jsonb_build_object(
    'settings', jsonb_build_object('revision', v_s.revision, 'choice', coalesce(v_s.choice, 'off'), 'choose_until', v_s.choose_until,
      'preferences', coalesce(v_s.preferences, false), 'open', booking.lodging_choice_open(v_s)),
    'rooms', coalesce((select jsonb_agg(booking.portal_room_json(x.id, v_e.id, null, true) order by s.zone nulls last, s.position)
      from (select booking.event_rooms(v_e.id) id) x join booking.spaces s on s.id = x.id), '[]'::jsonb),
    'pending', coalesce((select jsonb_agg(jsonb_build_object('assignment_id', a.id, 'revision', a.revision, 'guest_id', a.guest_id, 'space_id', a.space_id, 'bed_id', a.bed_id) order by a.created_at)
      from booking.room_assignments a where a.event_id = v_e.id and a.deleted_at is null and a.status = 'requested'), '[]'::jsonb),
    'preferences', coalesce((select jsonb_agg(jsonb_build_object('guest_id', g.id, 'text', g.room_preference, 'ground_floor', g.needs_ground_floor) order by g.created_at)
      from booking.guests g where g.event_id = v_e.id and g.deleted_at is null and not g.preview and (g.room_preference is not null or g.needs_ground_floor)), '[]'::jsonb),
    -- con la propuesta aceptada, activar o retirar queda pendiente de Ikisai
    'extra_pending_mode', booking.reservation_accepted(v_r.id),
    'extra_rate', (select jsonb_build_object('name', coalesce(t.public_name, t.name), 'unit', t.unit, 'amount', t.amount)
      from booking.rates t where t.deleted_at is null and t.active and t.portal_visible and t.service = 'cama_supletoria'
        and (t.valid_from is null or t.valid_from <= v_r.start_date) and (t.valid_to is null or v_r.start_date <= t.valid_to)
      order by t.position limit 1));
end $$;

-- ---------------------------------------------------------------------------
-- Organizers · cuántas supletorias quiere en una habitación del retiro. Booking elige cuáles: primero las ocupadas, después
-- las ya activadas o pedidas y luego por orden. No más de las posibles (`EXTRA_BEDS_LIMIT`) ni menos de las ocupadas
-- (`EXTRA_BED_IN_USE`). Con la propuesta aceptada, lo nuevo queda `requested`, lo retirado `release_requested`, y se avisa
-- al comercial.
-- ---------------------------------------------------------------------------
create or replace function booking.portal_extra_beds(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_space uuid; v_count integer; v_accepted boolean; v_counts jsonb;
  v_target uuid[]; v_ops jsonb := '[]'::jsonb; v_pending boolean := false; x record; v_out jsonb;
begin
  begin v_space := (p->'args'->>'space_id')::uuid; exception when others then v_space := null; end;
  if v_space is null or v_space not in (select booking.event_rooms(v_e.id)) then
    perform core.fail('NOT_OFFERED', 422, jsonb_build_object('space_id', p->'args'->>'space_id'));
  end if;
  begin v_count := (p->'args'->>'count')::integer; exception when others then v_count := null; end;
  if v_count is null or v_count < 0 or v_count > 100 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'count')); end if;
  -- la cama se bloquea para que dos activaciones a la vez no se pisen
  perform 1 from booking.beds where space_id = v_space and deleted_at is null and kind = 'supletoria' for update;
  v_counts := booking.portal_extra_counts(v_e.id, v_space);
  if v_count > (v_counts->>'possible')::integer then
    perform core.fail('EXTRA_BEDS_LIMIT', 422, jsonb_build_object('space_id', v_space, 'possible', (v_counts->>'possible')::integer));
  end if;
  if v_count < (v_counts->>'occupied')::integer then
    perform core.fail('EXTRA_BED_IN_USE', 409, jsonb_build_object('space_id', v_space, 'occupied', (v_counts->>'occupied')::integer));
  end if;
  v_accepted := booking.reservation_accepted(v_e.reservation_id);

  select coalesce(array_agg(id order by rank, position, label), '{}') into v_target from (
    select b.id, b.position, b.label,
           case when exists (select 1 from booking.room_assignments a where a.event_id = v_e.id and a.bed_id = b.id and a.deleted_at is null) then 0
                when eb.status = 'active' then 1 when eb.status = 'requested' then 2 when eb.status = 'release_requested' then 3 else 4 end rank
      from booking.beds b left join booking.event_extra_beds eb on eb.bed_id = b.id and eb.event_id = v_e.id and eb.deleted_at is null
     where b.space_id = v_space and b.deleted_at is null and b.active and b.kind = 'supletoria'
       and (eb.id is not null or exists (select 1 from booking.room_assignments a where a.event_id = v_e.id and a.bed_id = b.id and a.deleted_at is null)
            or not booking.extra_bed_used_elsewhere(b.id, v_e.id))
     order by rank, b.position, b.label limit v_count) t;

  -- las que se quedan
  for x in select b.id bed_id, e.id, e.revision, e.status from unnest(v_target) b(id)
             left join booking.event_extra_beds e on e.bed_id = b.id and e.event_id = v_e.id and e.deleted_at is null loop
    if x.id is null then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.event_extra_beds', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('event_id', v_e.id, 'bed_id', x.bed_id, 'status', case when v_accepted then 'requested' else 'active' end));
      v_pending := v_pending or v_accepted;
    elsif x.status = 'release_requested' or (x.status = 'requested' and not v_accepted) then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.event_extra_beds', 'id', x.id, 'expectedRevision', x.revision, 'fields', jsonb_build_object('status', 'active'));
    end if;
  end loop;
  -- las que sobran
  for x in select e.id, e.revision, e.status from booking.event_extra_beds e join booking.beds b on b.id = e.bed_id and b.space_id = v_space
            where e.event_id = v_e.id and e.deleted_at is null and not (e.bed_id = any(v_target)) loop
    if v_accepted and x.status = 'active' then
      v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.event_extra_beds', 'id', x.id, 'expectedRevision', x.revision, 'fields', jsonb_build_object('status', 'release_requested'));
      v_pending := true;
    elsif not (v_accepted and x.status = 'release_requested') then
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.event_extra_beds', 'id', x.id, 'expectedRevision', x.revision);
    end if;
  end loop;

  if v_ops <> '[]'::jsonb then v_out := booking.portal_apply('organizer', v_ops); end if;
  if v_pending then insert into booking.portal_notices (reservation_id, kind, actor) values (v_e.reservation_id, 'supletorias', (p->>'actor')::uuid); end if;
  return booking.portal_extra_counts(v_e.id, v_space) || jsonb_build_object('space_id', v_space, 'pending', v_pending, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Elegir o repartir cama: también las supletorias activadas del retiro (no las pendientes)
-- ---------------------------------------------------------------------------
create or replace function booking.extra_bed_usable(p_bed booking.beds, p_event uuid)
returns boolean language sql stable as $$
  select p_bed.kind <> 'supletoria' or exists (select 1 from booking.event_extra_beds x where x.event_id = p_event and x.bed_id = p_bed.id and x.deleted_at is null and x.status = 'active');
$$;

create or replace function booking.portal_choose_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_g booking.guests; v_s booking.lodging_settings; v_b booking.beds; v_ops jsonb := '[]'::jsonb; a booking.room_assignments;
  v_id uuid := gen_random_uuid(); v_status text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  v_s := booking.lodging_settings_of(v_g.event_id);
  if v_s.id is null or v_s.choice = 'off' then perform core.fail('NOT_OFFERED', 422, jsonb_build_object('guest_id', v_g.id)); end if;
  if not booking.lodging_choice_open(v_s) then perform core.fail('CHOICE_CLOSED', 422, jsonb_build_object('choose_until', v_s.choose_until)); end if;
  begin
    select * into v_b from booking.beds where id = (p->'args'->>'bed_id')::uuid and deleted_at is null and active for update;
  exception when invalid_text_representation then v_b := null; end;
  if v_b.id is null or not booking.extra_bed_usable(v_b, v_g.event_id)
     or not exists (select 1 from booking.open_rooms o where o.event_id = v_g.event_id and o.space_id = v_b.space_id and o.deleted_at is null)
     or v_b.space_id not in (select booking.event_rooms(v_g.event_id)) then
    perform core.fail('NOT_OFFERED', 422, jsonb_build_object('bed_id', p->'args'->>'bed_id'));
  end if;
  if not booking.bed_free(v_b.id, v_g.event_id, v_g.id) then perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_id', v_b.id)); end if;
  select * into a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and bed_id = v_b.id and deleted_at is null;
  if a.id is not null then return jsonb_build_object('assignment_id', a.id, 'revision', a.revision, 'status', a.status, 'cursor', null); end if;
  for a in select * from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  v_status := case when v_s.choice = 'request' then 'requested' else 'confirmed' end;
  v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_id,
    'fields', jsonb_build_object('event_id', v_g.event_id, 'space_id', v_b.space_id, 'bed_id', v_b.id, 'guest_id', v_g.id, 'persons', 1, 'status', v_status));
  v_out := booking.portal_apply('guest', v_ops);
  return jsonb_build_object('assignment_id', v_id, 'revision', (select revision from booking.room_assignments where id = v_id), 'status', v_status, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_assign_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_e booking.events := booking.portal_program_event(p); v_g booking.guests; v_b booking.beds; v_ops jsonb := '[]'::jsonb;
  a booking.room_assignments; v_id uuid; v_out jsonb;
begin
  select * into v_g from booking.guests where id = (p->'args'->>'guest_id')::uuid and event_id = v_e.id and deleted_at is null;
  if v_g.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p->'args'->>'guest_id')); end if;
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  if nullif(p->'args'->>'bed_id', '') is not null then
    select * into v_b from booking.beds where id = (p->'args'->>'bed_id')::uuid and deleted_at is null and active for update;
    if v_b.id is null or not booking.extra_bed_usable(v_b, v_e.id) or v_b.space_id not in (select booking.event_rooms(v_e.id)) then
      perform core.fail('NOT_OFFERED', 422, jsonb_build_object('bed_id', p->'args'->>'bed_id'));
    end if;
    if not booking.bed_free(v_b.id, v_e.id, v_g.id) then perform core.fail('BED_TAKEN', 409, jsonb_build_object('bed_id', v_b.id)); end if;
  end if;
  for a in select * from booking.room_assignments where event_id = v_e.id and guest_id = v_g.id and deleted_at is null loop
    if v_b.id is not null and a.bed_id = v_b.id and a.status = 'confirmed' then return jsonb_build_object('assignment_id', a.id, 'cursor', null); end if;
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', a.id, 'expectedRevision', a.revision);
  end loop;
  if v_b.id is not null then
    v_id := gen_random_uuid();
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.room_assignments', 'id', v_id,
      'fields', jsonb_build_object('event_id', v_e.id, 'space_id', v_b.space_id, 'bed_id', v_b.id, 'guest_id', v_g.id, 'persons', 1, 'status', 'confirmed'));
  end if;
  if v_ops = '[]'::jsonb then return jsonb_build_object('assignment_id', null, 'cursor', null); end if;
  v_out := booking.portal_apply('organizer', v_ops);
  return jsonb_build_object('assignment_id', v_id, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Aviso al comercial cuando el cambio queda pendiente (propuesta aceptada)
-- ---------------------------------------------------------------------------
alter table booking.portal_notices drop constraint portal_notices_kind_check;
alter table booking.portal_notices add constraint portal_notices_kind_check check (kind in ('fechas','quiere_confirmar','comentario','supletorias'));

select core.allow_read('organizers', 'booking.portal_extra_beds', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
