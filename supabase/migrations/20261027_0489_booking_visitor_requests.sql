-- Ikisai Booking · un visitante se apunta desde el QR (BG18 de Guests; contrato C11 de Core, 27-10-2026). Quien llega
-- por el QR no tiene cuenta ni ficha: lleva un token de visitante aparte (cabecera X-Visitor) que la Edge resuelve a su
-- `visitor_id`. Su petición es una fila de `booking.visitor_requests` escrita en un lote público
-- (`core.apply_public_operations`); el personal la acepta o la descarta con `booking.join_from_visitor`, y al aceptarla se
-- crea su ficha de huésped, ligada a la petición (el vínculo consentido), nunca por el nombre.
-- - En un lote público solo se puede CREAR una petición pendiente, con `visitor_id`, para un retiro vivo y visible para
--   huéspedes, y una por visitante y evento mientras esté pendiente. Nada más (ni cambiar ni decidir).
-- - Fuera de un lote público nadie crea peticiones: las decide el procedimiento.
-- - `booking.visitor_requests_of({visitor_id, event_code?})`: lo que ve el visitante de lo suyo (estado, sin datos ajenos);
--   lectura pública que solo llama la Edge con el `visitor_id` ya resuelto del token.
-- Toca solo el schema booking.

create table booking.visitor_requests (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid not null references booking.events(id),
  -- el código público del QR por el que llegó (de él sale el evento en un lote público)
  via_code text check (via_code is null or char_length(via_code) <= 20),
  visitor_id uuid not null,
  -- 'join': quiere apuntarse; 'contact': solo deja un dato («Déjanos un dato»), sin apuntarse
  kind text not null default 'join' check (kind in ('join', 'contact')),
  name text check (name is null or char_length(name) between 1 and 120),
  -- correo o teléfono, opcional, solo para avisarle de esta petición (dato personal: no va con la nota)
  contact text check (contact is null or char_length(contact) <= 200),
  note text check (note is null or char_length(note) <= 500),
  status text not null default 'pendiente' check (status in ('pendiente', 'aceptada', 'descartada', 'atendida')),
  guest_id uuid references booking.guests(id),
  decided_at timestamptz,
  constraint visitor_requests_accepted_guest check ((status = 'aceptada') = (guest_id is not null)),
  constraint visitor_requests_contact_kind check (kind = 'join' or status in ('pendiente', 'atendida', 'descartada')),
  constraint visitor_requests_join_kind check (kind = 'contact' or status <> 'atendida')
);
create index visitor_requests_event_idx on booking.visitor_requests (event_id, created_at) where deleted_at is null;
create unique index visitor_requests_one_pending on booking.visitor_requests (event_id, visitor_id, kind) where status = 'pendiente' and deleted_at is null;
select core.register_table('booking', 'booking', 'visitor_requests', array['event_id','via_code','visitor_id','kind','name','contact','note','status','guest_id','decided_at'],
  '{editor,owner}', '{editor,owner}');
select core.allow_public_write('booking', 'booking.visitor_requests');

create or replace function booking.visitor_request_guard()
returns trigger language plpgsql as $$
declare r booking.reservations;
begin
  if core.is_public_batch() then
    if tg_op <> 'INSERT' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a visitor only creates its request')); end if;
    if new.visitor_id is null or new.status <> 'pendiente' or new.guest_id is not null or new.decided_at is not null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'pending request with visitor_id only'));
    end if;
    -- el evento sale siempre del código del QR (lo que mande el cliente como event_id no cuenta)
    new.via_code := upper(btrim(coalesce(new.via_code, '')));
    new.event_id := (select e.id from booking.events e where e.public_code = new.via_code and e.deleted_at is null);
    select rr.* into r from booking.events e join booking.reservations rr on rr.id = e.reservation_id
     where e.id = new.event_id and e.deleted_at is null and rr.deleted_at is null;
    -- dejar un dato vale en cualquier evento vivo; apuntarse, solo si es visible para huéspedes
    if r.id is null or r.archived_at is not null or r.status not in ('pre_reservada', 'confirmada', 'en_ejecucion') or (new.kind = 'join' and not r.guests_visible) then
      perform core.fail('RESERVATION_NOT_OPEN', 422, jsonb_build_object('event_id', new.event_id));
    end if;
    new.name := nullif(btrim(new.name), '');
    new.note := nullif(btrim(new.note), '');
    new.contact := nullif(btrim(new.contact), '');
    -- un dato sin dato no sirve (al crearlo; la conservación lo borra después)
    if new.kind = 'contact' and new.contact is null then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'field', 'contact'));
    end if;
    return new;
  end if;
  if tg_op = 'INSERT' and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'only visitors create requests'));
  end if;
  if tg_op = 'UPDATE' and (new.visitor_id is distinct from old.visitor_id or new.event_id is distinct from old.event_id) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.visitor_requests', 'reason', 'visitor and event do not change'));
  end if;
  if tg_op = 'UPDATE' and (new.status is distinct from old.status or new.guest_id is distinct from old.guest_id)
     and coalesce(current_setting('booking.visitor_procedure', true), '') <> 'on' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decide with booking.join_from_visitor'));
  end if;
  return new;
end $$;
create trigger visitor_requests_guard before insert or update on booking.visitor_requests
  for each row execute function booking.visitor_request_guard();

-- El personal decide: {request_id, decision: 'accept' | 'reject', name?}. Al aceptar, ficha de huésped en el evento.
create or replace function booking.join_from_visitor(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb); v_req booking.visitor_requests; v_guest uuid; v_name text; v_id uuid;
begin
  begin v_id := (v_args->>'request_id')::uuid; exception when others then v_id := null; end;
  select * into v_req from booking.visitor_requests where id = v_id and deleted_at is null;
  if v_req.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.visitor_requests', 'id', v_args->>'request_id')); end if;
  if v_req.status <> 'pendiente' then return jsonb_build_object('request_id', v_req.id, 'status', v_req.status, 'guest_id', v_req.guest_id); end if;
  perform set_config('booking.visitor_procedure', 'on', true);
  if v_req.kind = 'contact' and v_args->>'decision' in ('done', 'reject') then
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'decided_at', now())));
    perform set_config('booking.visitor_procedure', '', true);
    return jsonb_build_object('request_id', v_req.id, 'status', case when v_args->>'decision' = 'done' then 'atendida' else 'descartada' end, 'guest_id', null);
  end if;
  if v_req.kind = 'contact' then
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision', 'reason', 'un dato se atiende o se descarta'));
  end if;
  if v_args->>'decision' = 'accept' then
    v_name := left(coalesce(nullif(btrim(v_args->>'name'), ''), v_req.name, 'Visitante'), 120);
    v_guest := gen_random_uuid();
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_guest, 'fields', jsonb_build_object('event_id', v_req.event_id, 'first_name', v_name)));
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'aceptada', 'guest_id', v_guest, 'decided_at', now())));
  elsif v_args->>'decision' = 'reject' then
    perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v_req.id, 'expectedRevision', v_req.revision,
        'fields', jsonb_build_object('status', 'descartada', 'decided_at', now())));
  else
    perform set_config('booking.visitor_procedure', '', true);
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'decision'));
  end if;
  perform set_config('booking.visitor_procedure', '', true);
  return jsonb_build_object('request_id', v_req.id, 'status', case when v_guest is null then 'descartada' else 'aceptada' end, 'guest_id', v_guest);
end $$;
select core.allow_procedure('booking', 'booking.join_from_visitor');

-- Lo del visitante (la Edge pasa su visitor_id ya resuelto): sus peticiones, con el evento por su código público.
create or replace function booking.visitor_requests_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('event_code', e.public_code, 'kind', q.kind, 'name', q.name, 'status', q.status,
             'created_at', q.created_at, 'decided_at', q.decided_at) order by q.created_at desc), '[]'::jsonb))
    from booking.visitor_requests q join booking.events e on e.id = q.event_id
   where q.deleted_at is null and q.visitor_id = nullif(p->>'visitor_id', '')::uuid
     and (nullif(p->>'event_code', '') is null or e.public_code = upper(btrim(p->>'event_code')))
$$;
select core.allow_public_read('booking_visitor_requests', 'booking.visitor_requests_of');

-- Conservación (acordada con Core): el nombre, el contacto y la nota de un visitante se borran a los 6 meses del fin del
-- evento, en la misma vuelta de la conservación (§20). Es la de 0481 con esa parte.
create or replace function booking.retention_run(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_ops jsonb := '[]'::jsonb; g booking.guests; r record; v record; v_files uuid[] := '{}'; v_count int := 0; v_visitors int := 0; v_out jsonb;
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
  -- 0489: el nombre, el contacto y la nota de los visitantes, a los 6 meses del fin del evento (como lo demás sin SES)
  for v in select q.id, q.revision from booking.visitor_requests q
             join booking.events e on e.id = q.event_id join booking.reservations rr on rr.id = e.reservation_id
            where q.deleted_at is null and (q.name is not null or q.contact is not null or q.note is not null)
              and rr.end_date is not null and rr.end_date + interval '6 months' <= (now() at time zone 'Europe/Madrid')::date
            limit 200 loop
    v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.visitor_requests', 'id', v.id, 'expectedRevision', v.revision,
      'fields', jsonb_build_object('name', null, 'contact', null, 'note', null));
    v_visitors := v_visitors + 1;
    exit when jsonb_array_length(v_ops) > 480;
  end loop;
  if v_count = 0 and v_visitors = 0 then return jsonb_build_object('anonymized', 0, 'visitors', 0); end if;

  update core.files set retention_class = 'temporary' where id = any(v_files);
  v_out := core.apply_system_operations('booking', v_ops);
  -- Regla 1 de VG (26-10-2026): el permiso en Guests se conserva; la ficha ya no tiene datos personales.
  return jsonb_build_object('anonymized', v_count, 'visitors', v_visitors, 'files', cardinality(v_files), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.retention_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from booking.retention_candidates(1))
      or exists (select 1 from booking.visitor_requests q join booking.events e on e.id = q.event_id join booking.reservations rr on rr.id = e.reservation_id
                  where q.deleted_at is null and (q.name is not null or q.contact is not null or q.note is not null)
                    and rr.end_date is not null and rr.end_date + interval '6 months' <= (now() at time zone 'Europe/Madrid')::date)
$$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
