-- Ikisai Booking · reglas de acceso a los portales (encargo de VG del 26-10-2026; plan aprobado por Core y respuestas de VG
-- del mismo día).
-- 1. El acceso a Guests y Organizers no caduca: el enlace vale mientras la reserva exista (también terminada, cancelada o
--    perdida; B19 de Organizers). La conservación anonimiza lo que obliga la ley, pero ya no quita el permiso.
-- 2. Quien tiene acceso a Organizers para una reserva es también huésped de ella (`portal_role = 'organizer'`), con su
--    entrada en Guests (B21). 3. El personal (no outsider) con cuenta y un turno no cancelado, igual (`staff`). Un outsider
--    con turno viene a trabajar y no es huésped; si viene como huésped, es una ficha normal.
--    Las fichas con `portal_role` no cuentan como comensales (fuera de `food_event_projection` y de los recuentos), no van
--    a SES aunque duerman (`ses_status = 'no_aplica'` y sin llegada) y solo eligen entre camas de equipo (pendiente: hasta
--    que exista ese dato, no eligen; la cama la asigna el personal).
--    Lo hace una conciliación idempotente (`booking.portal_access_run`): un tick con sonda y la app de Booking tras emitir
--    un enlace. Solo crea fichas en retiros vivos y no terminados. Si desaparece el origen, la ficha y el acceso se quedan.
-- 4. Dirección: `{"all": true}` en los grants de Guests y Organizers (lo concede el núcleo por el nivel de casa, 0095).
--    En Organizers, coorganizador de todas (`as = 'coorganizer'`). En Guests ve todos los retiros, pasados y futuros
--    (`joinable` en los vivos), los recorre (`portal_scope_reservation`) y se apunta a los vivos sin `guests_visible` ni
--    aprobación (`booking.portal_join_direction`, `portal_role = 'direccion'`). En Guests, «todos» nunca vale por un
--    huésped concreto: solo el par reserva + huésped.
-- Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- 1. Enlaces sin caducidad y conservación que no revoca
-- ---------------------------------------------------------------------------
create or replace function booking.portal_link_valid_until(p_scope jsonb)
returns timestamptz language plpgsql stable as $$
declare v_id uuid;
begin
  begin v_id := (p_scope->>'reservation_id')::uuid; exception when others then return null; end;
  if v_id is null or not exists (select 1 from booking.reservations where id = v_id and deleted_at is null) then return null; end if;
  return 'infinity'::timestamptz;
end $$;

create or replace function booking.retention_run(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_ops jsonb := '[]'::jsonb; g booking.guests; r record; v_files uuid[] := '{}'; v_count int := 0; v_out jsonb;
begin
  for g in select * from booking.retention_candidates(coalesce((p->'args'->>'limit')::int, 100)) loop
    if g.signature_file_id is not null then v_files := v_files || g.signature_file_id; end if;
    if g.ses_receipt_file_id is not null then v_files := v_files || g.ses_receipt_file_id; end if;
    for r in select id, revision from booking.dietary_restrictions where guest_id = g.id and deleted_at is null loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.dietary_restrictions', 'id', r.id, 'expectedRevision', r.revision);
    end loop;
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', g.id, 'expectedRevision', g.revision, 'fields', jsonb_build_object(
      'first_name', 'Huésped anonimizado', 'last_name_1', null, 'last_name_2', null, 'sex', null, 'document_type', null, 'document_number', null,
      'document_support_number', null, 'nationality', null, 'birth_date', null, 'residence_address', null, 'residence_postal_code', null,
      'residence_city', null, 'residence_country', null, 'phone', null, 'email', null, 'guardian_name', null, 'kinship', null, 'notes', null,
      'signed_by_name', null, 'signature_file_id', null, 'ses_receipt_file_id', null, 'ses_receipt_ref', null, 'ses_sent_by', null,
      'document_checked_by', null, 'anonymized_at', now()));
    v_count := v_count + 1;
    exit when jsonb_array_length(v_ops) > 450;
  end loop;
  if v_count = 0 then return jsonb_build_object('anonymized', 0); end if;

  update core.files set retention_class = 'temporary' where id = any(v_files);
  v_out := core.apply_system_operations('booking', v_ops);
  -- Regla 1 de VG (26-10-2026): el permiso en Guests se conserva; la ficha ya no tiene datos personales.
  return jsonb_build_object('anonymized', v_count, 'files', cardinality(v_files), 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- 2 y 3. Ficha de huésped del organizador y del personal
-- ---------------------------------------------------------------------------
alter table booking.guests add column portal_role text
  check (portal_role is null or portal_role in ('organizer','staff','direccion'));
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview',
  'room_preference','needs_ground_floor','person_key','portal_role'],
  '{editor,owner}', '{editor,owner}');

-- ¿Tiene la cuenta «todos» (`{"all": true}`) en ese portal?
create or replace function booking.portal_all(p_app text, p_actor uuid)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
                  where m.app = p_app and m.user_id = p_actor and gr -> 'all' = 'true'::jsonb);
$$;

-- ¿Tiene la cuenta acceso a Organizers para esa reserva por su propia entrada (no por «todos»)?
create or replace function booking.organizer_grant(p_actor uuid, p_reservation uuid)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
                  where m.app = 'organizers' and m.user_id = p_actor and gr ->> 'reservation_id' = p_reservation::text);
$$;

-- Cuentas con entrada en Guests para una ficha.
create or replace function booking.guest_accounts(p_guest uuid)
returns setof uuid language sql stable as $$
  select m.user_id from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
   where m.app = 'guests' and gr ->> 'guest_id' = p_guest::text;
$$;

-- Lo que falta para que se cumplan las reglas 2 y 3: `[{action: 'create', role, account, reservation_id, event_id, name}]`.
-- Vacío si ya se cumplen.
create or replace function booking.portal_access_plan()
returns jsonb language plpgsql stable as $$
declare v_out jsonb := '[]'::jsonb; s record;
begin
  for s in
    select distinct on (src.account, e.id) src.account, src.role, r.id reservation_id, e.id event_id, src.name
      from (
        select m.user_id account, 'organizer'::text role, (gr ->> 'reservation_id')::uuid reservation_id,
               coalesce(nullif(btrim(pr.display_name), ''), 'Organizador') name, 1 prio
          from core.memberships m cross join jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
          left join core.profiles pr on pr.user_id = m.user_id
         where m.app = 'organizers' and gr ? 'reservation_id'
        union all
        select st.member_user_id, 'staff', ev.reservation_id, st.person_name, 2
          from booking.staff_assignments st
          join booking.events ev on ev.id = st.event_id and ev.deleted_at is null
          left join core.house_levels hl on hl.user_id = st.member_user_id
         where st.deleted_at is null and st.status <> 'cancelada' and st.member_user_id is not null
           and coalesce(hl.level, '') <> 'outsider'
      ) src
      join booking.reservations r on r.id = src.reservation_id and r.deleted_at is null and r.archived_at is null
       and r.status in ('pre_reservada','confirmada','en_ejecucion') and (r.end_date is null or r.end_date >= current_date)
      join booking.events e on e.reservation_id = r.id and e.deleted_at is null
     order by src.account, e.id, src.prio
  loop
    -- ya es huésped de ese evento (con cualquier ficha suya): nada que hacer
    continue when exists (select 1 from booking.account_guests(s.account) ag where ag.event_id = s.event_id);
    v_out := v_out || jsonb_build_object('action', 'create', 'role', s.role, 'account', s.account, 'reservation_id', s.reservation_id,
      'event_id', s.event_id, 'name', left(btrim(s.name), 120));
  end loop;

  -- Si desaparece el origen, la ficha y el acceso se quedan (propuesta de Core, pendiente de VG): no hay bajas.
  return v_out;
end $$;

create or replace function booking.portal_access_has_work()
returns boolean language sql stable as $$ select jsonb_array_length(booking.portal_access_plan()) > 0 $$;

-- Aplica el plan en un lote del sistema y pone o quita las entradas de Guests.
create or replace function booking.portal_access_run(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_plan jsonb := booking.portal_access_plan(); v_item jsonb; v_ops jsonb := '[]'::jsonb; v_id uuid; v_key uuid;
  v_grants jsonb := '[]'::jsonb; v_removed uuid[] := '{}'; v_out jsonb; r record;
begin
  if jsonb_array_length(v_plan) = 0 then return jsonb_build_object('created', 0, 'removed', 0); end if;
  for v_item in select * from jsonb_array_elements(v_plan) loop
    if v_item->>'action' = 'create' then
      v_id := gen_random_uuid();
      -- la misma persona en varios retiros: su clave, si ya tiene una
      v_key := coalesce((select ag.person_key from booking.account_guests((v_item->>'account')::uuid) ag
                          where ag.person_key is not null order by ag.created_at limit 1), gen_random_uuid());
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', jsonb_build_object(
        'event_id', v_item->>'event_id', 'first_name', v_item->>'name', 'person_key', v_key, 'portal_role', v_item->>'role'));
      v_grants := v_grants || jsonb_build_object('account', v_item->>'account', 'reservation_id', v_item->>'reservation_id', 'guest_id', v_id, 'name', v_item->>'name');
    else
      v_id := (v_item->>'guest_id')::uuid;
      for r in select id, revision from booking.dietary_restrictions where guest_id = v_id and deleted_at is null loop
        v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.dietary_restrictions', 'id', r.id, 'expectedRevision', r.revision);
      end loop;
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.guests', 'id', v_id, 'expectedRevision', (v_item->>'revision')::bigint);
      v_removed := v_removed || v_id;
    end if;
    exit when jsonb_array_length(v_ops) > 450;
  end loop;
  v_out := core.apply_system_operations('booking', v_ops);
  for v_item in select * from jsonb_array_elements(v_grants) loop
    perform core.portal_grant('guests', (v_item->>'account')::uuid,
      jsonb_build_object('reservation_id', v_item->>'reservation_id', 'guest_id', v_item->>'guest_id'), v_item->>'name');
  end loop;
  foreach v_id in array v_removed loop perform core.portal_revoke_scope('guests', 'guest_id', v_id::text); end loop;
  return jsonb_build_object('created', jsonb_array_length(v_grants), 'removed', cardinality(v_removed), 'cursor', v_out->'cursor');
end $$;

-- La app de Booking la lanza tras emitir un enlace o tocar el personal (no espera al tick).
select core.allow_read('booking', 'booking.portal_access_run', 'action', '{editor,owner}');
select core.schedule_tick('booking', 'portal-access/tick', '*/5 * * * *', 'booking.portal_access_has_work');

-- Fichas de equipo (con `portal_role`): ni SES ni llegada (como el huésped de muestra), y fuera de cocina y recuentos.
alter table booking.guests add constraint guests_team_not_arrived check (portal_role is null or arrived_at is null);

create or replace function booking.guest_team_ses()
returns trigger language plpgsql as $$
begin
  if new.portal_role is not null then new.ses_status := 'no_aplica'; end if;
  return new;
end $$;
create trigger guests_team_ses before insert or update on booking.guests
  for each row execute function booking.guest_team_ses();

-- La de 0459, sin las restricciones de las fichas de equipo.
create or replace view booking.food_event_projection as
select
  e.id as event_id,
  e.code as event_code,
  r.code as reservation_code,
  r.title,
  r.event_type,
  r.start_date,
  r.end_date,
  e.arrival_time,
  e.departure_time,
  coalesce(e.final_guests, r.expected_guests) as guest_count,
  r.minors_count,
  coalesce(e.meal_plan_confirmed, r.meal_plan_requested) as meal_plan,
  coalesce(e.menu_style_confirmed, r.menu_style_requested) as menu_style,
  coalesce((
    select jsonb_agg(jsonb_build_object('type', x.restriction_type, 'subject', x.subject, 'severity', x.severity, 'servings', x.servings, 'kitchen_notes', x.kitchen_notes)
                     order by x.restriction_type, x.subject nulls first, x.severity nulls first, x.kitchen_notes nulls first)
    from (
      select d.restriction_type, nullif(lower(btrim(d.subject)), '') as subject, d.severity,
             nullif(btrim(d.kitchen_notes), '') as kitchen_notes, sum(coalesce(d.servings, 1))::int as servings
      from booking.dietary_restrictions d
      where d.event_id = e.id and d.active and d.deleted_at is null
        and not exists (select 1 from booking.guests pg where pg.id = d.guest_id and (pg.preview or pg.portal_role is not null))
      group by 1, 2, 3, 4) x), '[]'::jsonb) as dietary_restrictions,
  s.revision as event_revision,
  r.status as reservation_status,
  (e.final_guests is not null) as guest_count_is_final,
  r.requires_meals,
  r.meal_notes,
  r.id as reservation_id
from booking.events e
join booking.reservations r on r.id = e.reservation_id
join booking.event_food_state s on s.id = e.id
where e.deleted_at is null and r.deleted_at is null;

revoke all on booking.food_event_projection from public, anon, authenticated;
grant select on booking.food_event_projection to service_role;

-- La de 0459, sin las fichas de equipo.
create or replace function booking.guest_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid; v_out jsonb;
begin
  begin v_event := (p->'args'->>'event_id')::uuid; exception when others then v_event := null; end;
  if v_event is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'event_id must be a uuid')); end if;
  if not exists (select 1 from booking.events where id = v_event and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.events', 'id', v_event));
  end if;
  select jsonb_build_object(
      'eventId', v_event,
      'total', count(*),
      'bySex', jsonb_build_object('H', count(*) filter (where g.sex = 'H'), 'M', count(*) filter (where g.sex = 'M'),
                                  'X', count(*) filter (where g.sex = 'X'), 'sinDato', count(*) filter (where g.sex is null)),
      'minors', count(*) filter (where g.is_minor),
      'signed', count(*) filter (where g.signed_at is not null),
      'dataStatus', coalesce((select jsonb_object_agg(a.data_status, a.n) from (
          select data_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null and not preview and portal_role is null group by 1) a), '{}'::jsonb),
      'sesStatus', coalesce((select jsonb_object_agg(b.ses_status, b.n) from (
          select ses_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null and not preview and portal_role is null group by 1) b), '{}'::jsonb))
    into v_out
    from booking.guests g where g.event_id = v_event and g.deleted_at is null and not g.preview and g.portal_role is null;
  return v_out;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Dirección
-- ---------------------------------------------------------------------------
-- Guests · retiros abiertos. Dirección ve todos, pasados y futuros (también archivados o cerrados); `joinable` dice si se
-- puede apuntar (los vivos).
create or replace function booking.portal_open_retreats(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid; v_range record; v_all boolean := booking.portal_all('guests', (p->>'actor')::uuid);
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('direction', v_all, 'items', coalesce((
    select jsonb_agg(jsonb_build_object('reservation_id', r.id, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
             'summary', r.public_summary, 'status', r.status,
             'joinable', r.archived_at is null and r.status in ('pre_reservada','confirmada','en_ejecucion') and (r.guests_visible or v_all),
             'joined', exists (select 1 from booking.account_guests(v_actor) g join booking.events e on e.id = g.event_id where e.reservation_id = r.id),
             'request', (select jsonb_build_object('status', case j.status when 'pendiente' then 'con_el_organizador' else j.status end, 'comment', j.comment)
                           from booking.join_requests j where j.reservation_id = r.id and j.account_id = v_actor and j.deleted_at is null
                          order by j.created_at desc limit 1))
             order by r.start_date, r.title)
      from booking.reservations r
     where r.deleted_at is null
       and (v_all or (r.archived_at is null and r.guests_visible and r.status in ('pre_reservada','confirmada','en_ejecucion')))
       and r.start_date is not null and r.end_date is not null
       and r.start_date < v_range.d_to and v_range.d_from <= r.end_date), '[]'::jsonb));
end $$;

-- Guests · dirección se apunta directamente: `{reservation_id, persons?: [{person_key?, name}]}` (sin `persons`, ella
-- misma). Ficha con `portal_role = 'direccion'` y entrada del par en Guests.
create or replace function booking.portal_join_direction(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_actor uuid := (p->>'actor')::uuid; v_res uuid; r booking.reservations; v_event uuid; v_persons jsonb; v_item jsonb;
  v_id uuid; v_ops jsonb := '[]'::jsonb; v_ids uuid[] := '{}'; v_out jsonb;
begin
  if not booking.portal_all('guests', v_actor) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reason', 'direction only')); end if;
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  select * into r from booking.reservations where id = v_res and deleted_at is null and archived_at is null and status in ('pre_reservada','confirmada','en_ejecucion');
  if r.id is null then perform core.fail('RESERVATION_NOT_OPEN', 422, jsonb_build_object('reservation_id', p->'args'->>'reservation_id')); end if;
  select e.id into v_event from booking.events e where e.reservation_id = r.id and e.deleted_at is null;
  if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', r.id)); end if;
  v_persons := coalesce(booking.portal_persons(v_actor, p->'args'->'persons'), jsonb_build_array(jsonb_build_object(
    'person_key', coalesce((select ag.person_key from booking.account_guests(v_actor) ag where ag.person_key is not null order by ag.created_at limit 1), gen_random_uuid()),
    'name', coalesce(nullif(btrim((select display_name from core.profiles where user_id = v_actor)), ''), 'Dirección'))));
  for v_item in select * from jsonb_array_elements(v_persons) loop
    continue when exists (select 1 from booking.guests g where g.event_id = v_event and g.person_key = (v_item->>'person_key')::uuid and g.deleted_at is null);
    v_id := gen_random_uuid();
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', jsonb_build_object(
      'event_id', v_event, 'first_name', v_item->>'name', 'person_key', v_item->>'person_key', 'portal_role', 'direccion'));
    v_ids := v_ids || v_id;
  end loop;
  if cardinality(v_ids) = 0 then return jsonb_build_object('guest_ids', '[]'::jsonb, 'cursor', null); end if;
  v_out := booking.portal_apply('guest', v_ops);
  foreach v_id in array v_ids loop
    perform core.portal_grant('guests', v_actor, jsonb_build_object('reservation_id', r.id, 'guest_id', v_id), '');
  end loop;
  return jsonb_build_object('guest_ids', to_jsonb(v_ids), 'cursor', v_out->'cursor');
end $$;
select core.allow_read('guests', 'booking.portal_join_direction', 'action', '{editor,owner}');

-- Guests · alojamiento. Las fichas de equipo (con `portal_role`) solo eligen entre camas de equipo; hasta que exista ese
-- dato no eligen (choice 'off' y sin habitaciones; la cama la asigna el personal). Es la de 0478 con esa rama.
create or replace function booking.portal_lodging(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_s booking.lodging_settings; v_a booking.room_assignments; v_team boolean;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_team := v_g.portal_role is not null;
  v_s := booking.lodging_settings_of(v_g.event_id);
  select * into v_a from booking.room_assignments where event_id = v_g.event_id and guest_id = v_g.id and deleted_at is null order by created_at desc limit 1;
  return jsonb_build_object(
    'choice', case when v_team then 'off' else coalesce(v_s.choice, 'off') end, 'choose_until', v_s.choose_until,
    'open', not v_team and booking.lodging_choice_open(v_s), 'preferences', coalesce(v_s.preferences, false), 'team', v_team,
    'mine', case when v_a.id is null then null else (select jsonb_build_object('space_name', booking.space_public_name(s), 'zone', s.zone,
        'resource_space_id', coalesce(v_a.resource_space_id, booking.resource_twin('booking.space', s.id)),
        'resource_bed_id', coalesce(v_a.resource_bed_id, booking.resource_twin('booking.bed', v_a.bed_id)),
        'bed_label', (select b.label from booking.beds b where b.id = v_a.bed_id), 'status', v_a.status, 'source', v_a.source)
      from booking.spaces s where s.id = v_a.space_id) end,
    'preference', case when v_g.room_preference is null and not v_g.needs_ground_floor then null
      else jsonb_build_object('text', v_g.room_preference, 'ground_floor', v_g.needs_ground_floor) end,
    'rooms', case when v_team or coalesce(v_s.choice, 'off') = 'off' then '[]'::jsonb else coalesce((
      select jsonb_agg(booking.portal_room_json(o.space_id, v_g.event_id, v_g.id, false) order by s.zone nulls last, s.position)
        from booking.open_rooms o join booking.spaces s on s.id = o.space_id and s.deleted_at is null and s.active
       where o.event_id = v_g.event_id and o.deleted_at is null and o.space_id in (select booking.event_rooms(v_g.event_id))), '[]'::jsonb) end);
end $$;

-- Guests · elegir cama: las fichas de equipo, no (todavía no hay camas de equipo). Es la de 0466 con esa comprobación.
create or replace function booking.portal_choose_bed(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_g booking.guests; v_s booking.lodging_settings; v_b booking.beds; v_ops jsonb := '[]'::jsonb; a booking.room_assignments;
  v_id uuid := gen_random_uuid(); v_status text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  if v_g.portal_role is not null then perform core.fail('NOT_OFFERED', 422, jsonb_build_object('guest_id', v_g.id, 'reason', 'team')); end if;
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

-- Lecturas comunes de los portales (programa, detalle del retiro): en Guests, también dirección («todos») sin ficha
-- propia, para recorrer cualquier retiro. Es la de 0459 con esa condición.
create or replace function booking.portal_scope_reservation(p jsonb)
returns booking.reservations language plpgsql stable as $$
declare v_res uuid; v_r booking.reservations; v_actor uuid := (p->>'actor')::uuid; v_ok boolean;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if p->>'app' = 'guests' then
    v_ok := v_res is not null and (booking.portal_all('guests', v_actor) or exists (select 1 from booking.guests g join booking.events e on e.id = g.event_id
      where e.reservation_id = v_res and g.deleted_at is null and booking.portal_in_scope('guests', v_actor, v_res, g.id)));
  else
    v_ok := v_res is not null and booking.portal_in_scope(p->>'app', v_actor, v_res, null);
  end if;
  if not coalesce(v_ok, false) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id')); end if;
  select * into v_r from booking.reservations where id = v_res and deleted_at is null;
  if v_r.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  return v_r;
end $$;

-- Organizers · sus reservas, con `as` ('organizer' por su entrada; 'coorganizer' por «todos») y `as_guest_id` (su
-- ficha de huésped en esa reserva, o null). Es la de 0459 con esos campos.
create or replace function booking.portal_reservations(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid;
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
      'expected_guests', r.expected_guests, 'status', r.status, 'confirmed', e.id is not null, 'mode', booking.guest_mode(r.id),
      'guests', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null and not g.preview and g.portal_role is null),
      'complete', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null and not g.preview and g.portal_role is null
                      and cardinality(booking.guest_missing(g, booking.guest_mode(r.id))) = 0),
      'as', case when booking.organizer_grant(v_actor, r.id) then 'organizer' else 'coorganizer' end,
      'as_guest_id', (select ag.id from booking.account_guests(v_actor) ag where e.id is not null and ag.event_id = e.id order by ag.created_at limit 1))
      order by r.start_date nulls last)
      from booking.reservations r
      left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
     where r.deleted_at is null and booking.portal_in_scope('organizers', v_actor, r.id, null)), '[]'::jsonb));
end $$;

-- Organizers · coorganizadores de una reserva: también dirección («todos»). Es la de 0451 con esa condición.
create or replace function booking.portal_organizers(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('display_name', coalesce(nullif(btrim(pr.display_name), ''), 'Organizador'), 'me', m.user_id = (p->>'actor')::uuid,
                     'as', case when booking.organizer_grant(m.user_id, v_res) then 'organizer' else 'coorganizer' end)
                     order by pr.display_name)
      from core.memberships m left join core.profiles pr on pr.user_id = m.user_id
     where m.app = 'organizers' and exists (select 1 from jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr
             where gr ->> 'reservation_id' = v_res::text or gr -> 'all' = 'true'::jsonb)), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
