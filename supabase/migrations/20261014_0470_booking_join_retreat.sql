-- Ikisai Booking · O2, «Apuntarme» a un retiro abierto (aprobado por el usuario el 14-10-2026; respuestas de Core del 14-10:
-- sugerencias del núcleo, contrato §3.10, y P23/P24 en 0094). Un huésped de Guests sugiere `booking.join_from_suggestion`
-- con las personas que se apuntan (todas por defecto). El personal decide desde la cola de sugerencias:
--   · Aceptar (lote tal cual): se crean las fichas en el evento, con su `person_key`, y la cuenta autora las ve en Guests.
--   · Pasar al organizador (lote corregido con `args.mode = 'organizer'`): queda una solicitud que el organizador acepta o
--     descarta desde su portal.
--   · Descartar: `reject` de la sugerencia, con comentario.
-- La cuenta autora sale de `core.suggestion_author()` (nunca de `args`). Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Solicitudes pasadas al organizador
-- ---------------------------------------------------------------------------
create table booking.join_requests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  -- quien pidió apuntarse (la cuenta autora de la sugerencia)
  account_id uuid not null references auth.users(id),
  -- `[{person_key, name}]`, ya validadas para esa cuenta
  persons jsonb not null check (jsonb_typeof(persons) = 'array' and jsonb_array_length(persons) between 1 and 12),
  message text check (message is null or length(message) <= 1000),
  status text not null default 'pendiente' check (status in ('pendiente','aceptada','descartada')),
  comment text check (comment is null or length(comment) <= 1000),
  suggestion_id uuid
);
create index join_requests_reservation_idx on booking.join_requests (reservation_id, status) where deleted_at is null;
create trigger join_requests_forbid_reparent before update on booking.join_requests
  for each row execute function booking.forbid_reparent('reservation_id');
-- El personal las ve. Las crea el procedimiento y las decide el organizador con su acción; la Edge rechaza que un cliente
-- las escriba (como `portal_declarations`).
select core.register_table('booking', 'booking', 'join_requests', array['reservation_id','account_id','persons','message','status','comment','suggestion_id']);

-- ---------------------------------------------------------------------------
-- Ayudas
-- ---------------------------------------------------------------------------
-- Retiro abierto en el que alguien se puede apuntar (si no, `RESERVATION_NOT_OPEN`).
create or replace function booking.open_reservation(p_reservation uuid)
returns booking.reservations language plpgsql stable as $$
declare r booking.reservations;
begin
  select * into r from booking.reservations where id = p_reservation;
  if r.id is null or r.deleted_at is not null or r.archived_at is not null or not r.guests_visible
     or r.status not in ('pre_reservada','confirmada','en_ejecucion') then
    perform core.fail('RESERVATION_NOT_OPEN', 422, jsonb_build_object('reservation_id', p_reservation));
  end if;
  return r;
end $$;

-- Fichas nuevas para las personas en el evento del retiro y entrada de Guests para la cuenta. Las escribe como el propio
-- huésped (los datos los dio él: el organizador no los pisa a ciegas). Devuelve los ids.
create or replace function booking.join_create_guests(p_app text, p_actor uuid, p_role text, p_request text, p_cursor bigint,
  p_reservation uuid, p_account uuid, p_persons jsonb)
returns uuid[] language plpgsql as $$
declare v_event uuid; v_item jsonb; v_id uuid; v_ids uuid[] := '{}';
begin
  select e.id into v_event from booking.events e where e.reservation_id = p_reservation and e.deleted_at is null;
  if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', p_reservation)); end if;
  for v_item in select * from jsonb_array_elements(p_persons) loop
    -- la misma persona no se apunta dos veces al mismo retiro
    if exists (select 1 from booking.guests g where g.event_id = v_event and g.person_key = (v_item->>'person_key')::uuid and g.deleted_at is null) then continue; end if;
    v_id := gen_random_uuid();
    perform set_config('booking.writer', 'guest', true);
    perform core.apply_row_op(p_app, p_actor, p_role, p_request, p_cursor, jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id,
      'fields', jsonb_build_object('event_id', v_event, 'first_name', v_item->>'name', 'person_key', v_item->>'person_key')));
    perform set_config('booking.writer', '', true);
    perform core.portal_grant('guests', p_account, jsonb_build_object('reservation_id', p_reservation, 'guest_id', v_id), '');
    v_ids := v_ids || v_id;
  end loop;
  return v_ids;
end $$;

-- ---------------------------------------------------------------------------
-- Procedimiento del lote de la sugerencia (se ejecuta al aprobar, como el personal que aprueba)
-- args: { reservation_id, persons: [{person_key?, name}], message?, mode?: 'organizer' }
-- ---------------------------------------------------------------------------
create or replace function booking.join_from_suggestion(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb); v_author uuid := core.suggestion_author(); v_res uuid; r booking.reservations;
  v_persons jsonb; v_ids uuid[]; v_id uuid;
begin
  if v_author is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'only when approving a suggestion')); end if;
  begin v_res := (v_args->>'reservation_id')::uuid; exception when others then v_res := null; end;
  r := booking.open_reservation(v_res);
  v_persons := booking.portal_persons(v_author, v_args->'persons');
  if v_persons is null or jsonb_array_length(v_persons) = 0 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'persons')); end if;

  if v_args->>'mode' = 'organizer' then
    v_id := gen_random_uuid();
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint, jsonb_build_object('op', 'insert', 'table', 'booking.join_requests', 'id', v_id,
      'fields', jsonb_strip_nulls(jsonb_build_object('reservation_id', r.id, 'account_id', v_author, 'persons', v_persons,
        'message', left(nullif(btrim(coalesce(v_args->>'message', '')), ''), 1000), 'suggestion_id', core.suggestion_id()))));
    return jsonb_build_object('mode', 'organizer', 'join_request_id', v_id);
  end if;

  v_ids := booking.join_create_guests(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint, r.id, v_author, v_persons);
  return jsonb_build_object('mode', 'staff', 'guest_ids', to_jsonb(v_ids));
end $$;

select core.allow_procedure('booking', 'booking.join_from_suggestion');
-- Quién sugiere: los huéspedes de Guests (editor allí); quien decide, el personal de Booking.
select core.register_suggestion_kind('booking', 'apuntarme', 'Apuntarme a un retiro',
  p_procedures => array['booking.join_from_suggestion'], p_submit_roles => '{}', p_submit_from => '{"guests": ["editor"]}');

-- ---------------------------------------------------------------------------
-- Organizers · las solicitudes que le pasa Ikisai
-- ---------------------------------------------------------------------------
create or replace function booking.portal_join_requests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', j.id, 'revision', j.revision, 'persons', (select jsonb_agg(x->'name') from jsonb_array_elements(j.persons) x),
             'message', j.message, 'status', j.status, 'comment', j.comment, 'created_at', j.created_at) order by j.created_at)
      from booking.join_requests j where j.reservation_id = v_res and j.deleted_at is null), '[]'::jsonb));
end $$;

-- `{reservation_id, id, decision: 'aceptar' | 'descartar', comment?}`. Aceptar crea las fichas en el retiro (hace falta que
-- esté confirmado) y da la entrada de Guests a la cuenta, en un solo lote.
create or replace function booking.portal_join_request_decide(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; j booking.join_requests; v_decision text := p->'args'->>'decision'; v_comment text := left(nullif(btrim(coalesce(p->'args'->>'comment', '')), ''), 1000);
  v_event uuid; v_ops jsonb := '[]'::jsonb; v_item jsonb; v_id uuid; v_new jsonb := '[]'::jsonb; v_out jsonb; g jsonb;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  begin select * into j from booking.join_requests where id = (p->'args'->>'id')::uuid and reservation_id = v_res and deleted_at is null for update;
  exception when others then j := null; end;
  if j.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('id', p->'args'->>'id')); end if;
  if j.status <> 'pendiente' then perform core.fail('JOIN_REQUEST_DECIDED', 409, jsonb_build_object('id', j.id, 'status', j.status)); end if;
  if v_decision is null or v_decision not in ('aceptar','descartar') then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision')); end if;

  if v_decision = 'aceptar' then
    perform booking.open_reservation(v_res);
    select e.id into v_event from booking.events e where e.reservation_id = v_res and e.deleted_at is null;
    if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_res)); end if;
    for v_item in select * from jsonb_array_elements(j.persons) loop
      if exists (select 1 from booking.guests x where x.event_id = v_event and x.person_key = (v_item->>'person_key')::uuid and x.deleted_at is null) then continue; end if;
      v_id := gen_random_uuid();
      v_new := v_new || to_jsonb(v_id);
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id,
        'fields', jsonb_build_object('event_id', v_event, 'first_name', v_item->>'name', 'person_key', v_item->>'person_key'));
    end loop;
  end if;
  v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.join_requests', 'id', j.id, 'expectedRevision', j.revision,
    'fields', jsonb_build_object('status', case when v_decision = 'aceptar' then 'aceptada' else 'descartada' end, 'comment', v_comment));
  -- (los datos de las fichas los dio el propio huésped)
  v_out := booking.portal_apply('guest', v_ops);
  for g in select * from jsonb_array_elements(v_new) loop
    perform core.portal_grant('guests', j.account_id, jsonb_build_object('reservation_id', v_res, 'guest_id', g #>> '{}'), '');
  end loop;
  return jsonb_build_object('id', j.id, 'status', case when v_decision = 'aceptar' then 'aceptada' else 'descartada' end, 'guest_ids', v_new, 'cursor', v_out->'cursor');
end $$;

-- ---------------------------------------------------------------------------
-- Guests · retiros abiertos: además, en qué quedó la solicitud pasada al organizador
-- ---------------------------------------------------------------------------
create or replace function booking.portal_open_retreats(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid; v_range record;
begin
  select * into v_range from booking.portal_range(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('reservation_id', r.id, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
             'summary', r.public_summary,
             'joined', exists (select 1 from booking.account_guests(v_actor) g join booking.events e on e.id = g.event_id where e.reservation_id = r.id),
             -- `con_el_organizador`, `aceptada` o `descartada`; lo pendiente con Ikisai es la propia sugerencia (scope mine)
             'request', (select jsonb_build_object('status', case j.status when 'pendiente' then 'con_el_organizador' else j.status end, 'comment', j.comment)
                           from booking.join_requests j where j.reservation_id = r.id and j.account_id = v_actor and j.deleted_at is null
                          order by j.created_at desc limit 1))
             order by r.start_date, r.title)
      from booking.reservations r
     where r.deleted_at is null and r.archived_at is null and r.guests_visible
       and r.status in ('pre_reservada','confirmada','en_ejecucion')
       and r.start_date is not null and r.end_date is not null
       and r.start_date < v_range.d_to and v_range.d_from <= r.end_date), '[]'::jsonb));
end $$;

select core.allow_read('organizers', 'booking.portal_join_requests', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_join_request_decide', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
