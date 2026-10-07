-- Ikisai Booking · datos de huéspedes para los portales Organizers y Guests (docs/booking/API.md §16; Core aprobó la
-- propuesta con respuestas). Booking es la dueña: los portales leen funciones filtradas por el ámbito de su enlace y
-- escriben con acciones estrechas que fijan la procedencia de cada campo. Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Procedencia, consentimiento y aviso legal
-- ---------------------------------------------------------------------------
alter table booking.guests
  add column field_sources jsonb not null default '{}'::jsonb,
  add column allergies_visible_to_organizer boolean not null default false,
  add column privacy_ack_at timestamptz,
  add column privacy_ack_version text check (privacy_ack_version is null or length(privacy_ack_version) between 1 and 40);

-- `field_sources` no es escribible: lo mantiene el trigger. El consentimiento y el acuse sí lo son para que la acción del
-- huésped pueda escribirlos con `core.apply_row_op`; el trigger rechaza que los cambie nadie más.
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version'],
  '{editor,owner}', '{editor,owner}');

alter table booking.dietary_restrictions
  add column source text not null default 'staff' check (source in ('guest','organizer','staff'));

-- Quién escribe en esta transacción: lo fijan las acciones de portal; sin marca, el personal (Booking y sus agentes).
create or replace function booking.writer()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('booking.writer', true), ''), 'staff');
$$;

-- Campos de datos del huésped que se rellenan desde los portales y cuya procedencia se anota.
create or replace function booking.portal_guest_fields()
returns text[] language sql immutable as $$
  select array['first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
    'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
    'is_minor','guardian_name','kinship'];
$$;

create or replace function booking.guest_track_sources()
returns trigger language plpgsql as $$
declare
  v_writer text := booking.writer();
  v_new jsonb := to_jsonb(new);
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  v_field text;
begin
  foreach v_field in array booking.portal_guest_fields() loop
    if coalesce(v_new -> v_field, 'null'::jsonb) is distinct from coalesce(v_old -> v_field, 'null'::jsonb)
       and not (tg_op = 'INSERT' and coalesce(v_new -> v_field, 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb)) then
      -- el organizador no pisa a ciegas lo que escribió el huésped (no ve el valor)
      if v_writer = 'organizer' and tg_op = 'UPDATE' and old.field_sources -> v_field ->> 'by' = 'guest' then
        perform core.fail('FIELD_OWNED_BY_GUEST', 422, jsonb_build_object('table', 'booking.guests', 'id', new.id, 'field', v_field));
      end if;
      if coalesce(v_new -> v_field, 'null'::jsonb) = 'null'::jsonb then
        new.field_sources := new.field_sources - v_field;
      else
        new.field_sources := jsonb_set(new.field_sources, array[v_field], jsonb_build_object('by', v_writer, 'at', now()));
      end if;
    end if;
  end loop;

  -- consentimiento y aviso legal: solo el propio huésped
  if v_writer <> 'guest' and (
       (tg_op = 'INSERT' and (new.allergies_visible_to_organizer or new.privacy_ack_at is not null or new.privacy_ack_version is not null))
    or (tg_op = 'UPDATE' and (new.allergies_visible_to_organizer is distinct from old.allergies_visible_to_organizer
         or new.privacy_ack_at is distinct from old.privacy_ack_at or new.privacy_ack_version is distinct from old.privacy_ack_version))) then
    perform core.fail('GUEST_ONLY', 422, jsonb_build_object('table', 'booking.guests', 'id', new.id, 'reason', 'consent'));
  end if;

  -- la firma del parte: nunca el organizador
  if v_writer = 'organizer' and (
       (tg_op = 'INSERT' and (new.signature_file_id is not null or new.signed_at is not null or new.signed_by_name is not null))
    or (tg_op = 'UPDATE' and (new.signature_file_id is distinct from old.signature_file_id or new.signed_at is distinct from old.signed_at
         or new.signed_by_name is distinct from old.signed_by_name))) then
    perform core.fail('GUEST_ONLY', 422, jsonb_build_object('table', 'booking.guests', 'id', new.id, 'reason', 'signature'));
  end if;
  return new;
end $$;
create trigger guests_track_sources before insert or update on booking.guests
  for each row execute function booking.guest_track_sources();

-- Restricciones: la fila es de quien la escribió por última vez; el organizador no toca las del huésped.
create or replace function booking.restriction_track_source()
returns trigger language plpgsql as $$
declare v_writer text := booking.writer();
begin
  -- (mandarla a la papelera sí puede, al dar de baja al huésped)
  if tg_op = 'UPDATE' and v_writer = 'organizer' and old.source = 'guest' and new.deleted_at is not distinct from old.deleted_at then
    perform core.fail('FIELD_OWNED_BY_GUEST', 422, jsonb_build_object('table', 'booking.dietary_restrictions', 'id', new.id));
  end if;
  if tg_op = 'INSERT' or row(new.restriction_type, new.subject, new.severity, new.servings, new.kitchen_notes, new.active)
       is distinct from row(old.restriction_type, old.subject, old.severity, old.servings, old.kitchen_notes, old.active) then
    new.source := v_writer;
  end if;
  return new;
end $$;
create trigger dietary_restrictions_track_source before insert or update on booking.dietary_restrictions
  for each row execute function booking.restriction_track_source();

-- ---------------------------------------------------------------------------
-- Declaración del organizador al rellenar datos de otros (misma conservación que los datos de huéspedes).
-- La escribe solo la acción de portal, en el mismo lote que el dato (la Edge rechaza escrituras de clientes); el personal
-- la ve sincronizada (editor y owner).
-- ---------------------------------------------------------------------------
create table booking.portal_declarations (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  reservation_id uuid not null references booking.reservations(id),
  user_id uuid not null references auth.users(id),
  text_version text not null check (length(text_version) between 1 and 40)
);
create unique index portal_declarations_once on booking.portal_declarations (reservation_id, user_id) where deleted_at is null;

select core.register_table('booking', 'booking', 'portal_declarations', array['reservation_id','user_id','text_version'], '{editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Qué se pide a cada huésped según el modo de la reserva. Espejo de `guestMissing` del dominio
-- (_domain/booking/portal.ts; la prueba compara los dos). Hoy todas las reservas van en modo `ses`; el modo
-- `operativo` (sin SES: solo contacto, alergias y dieta) llegará con la propuesta de SES.HOSPEDAJES.
-- ---------------------------------------------------------------------------
create or replace function booking.guest_mode(p_reservation uuid)
returns text language sql stable as $$ select 'ses'::text $$;

create or replace function booking.guest_missing(g booking.guests, p_mode text)
returns text[] language plpgsql immutable as $$
declare v text[] := '{}';
begin
  if coalesce(btrim(g.first_name), '') = '' then v := array_append(v, 'first_name'); end if;
  if p_mode = 'operativo' then
    if coalesce(btrim(g.phone), '') = '' and coalesce(btrim(g.email), '') = '' then v := array_append(v, 'contact'); end if;
    return v;
  end if;
  if coalesce(btrim(g.last_name_1), '') = '' then v := array_append(v, 'last_name_1'); end if;
  if g.birth_date is null then v := array_append(v, 'birth_date'); end if;
  if coalesce(btrim(g.residence_address), '') = '' then v := array_append(v, 'residence_address'); end if;
  if coalesce(btrim(g.residence_postal_code), '') = '' then v := array_append(v, 'residence_postal_code'); end if;
  if coalesce(btrim(g.residence_city), '') = '' then v := array_append(v, 'residence_city'); end if;
  if coalesce(btrim(g.residence_country), '') = '' then v := array_append(v, 'residence_country'); end if;
  if coalesce(btrim(g.phone), '') = '' and coalesce(btrim(g.email), '') = '' then v := array_append(v, 'contact'); end if;
  if g.is_minor then
    if coalesce(btrim(g.kinship), '') = '' then v := array_append(v, 'kinship'); end if;
  else
    if g.document_type is null then v := array_append(v, 'document_type'); end if;
    if coalesce(btrim(g.document_number), '') = '' then v := array_append(v, 'document_number'); end if;
  end if;
  if g.document_type = 'DNI' and coalesce(btrim(g.last_name_2), '') = '' then v := array_append(v, 'last_name_2'); end if;
  if g.document_type in ('DNI','NIE') and coalesce(btrim(g.document_support_number), '') = '' then v := array_append(v, 'document_support_number'); end if;
  return v;
end $$;

-- ---------------------------------------------------------------------------
-- Ámbito del enlace y lote propio de las acciones de portal
-- ---------------------------------------------------------------------------
create or replace function booking.portal_in_scope(p_app text, p_actor uuid, p_reservation uuid, p_guest uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from core.memberships m, jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) g
     where m.app = p_app and m.user_id = p_actor
       and g ->> 'reservation_id' = p_reservation::text
       and (p_app <> 'guests' or g ->> 'guest_id' = p_guest::text));
$$;

-- Huésped vivo con su reserva, comprobando el ámbito; si no, 403 OUT_OF_SCOPE.
create or replace function booking.portal_guest_row(p jsonb, p_guest uuid)
returns booking.guests language plpgsql as $$
declare v_g booking.guests; v_res uuid;
begin
  select g.* into v_g from booking.guests g where g.id = p_guest and g.deleted_at is null;
  -- inexistente y ajeno responden igual: un portal no averigua qué huéspedes existen
  if v_g.id is null then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p_guest)); end if;
  select e.reservation_id into v_res from booking.events e where e.id = v_g.event_id;
  if not booking.portal_in_scope(p->>'app', (p->>'actor')::uuid, v_res, v_g.id) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p_guest));
  end if;
  return v_g;
end $$;

create or replace function booking.portal_reservation_of(p_guest booking.guests)
returns uuid language sql stable as $$ select reservation_id from booking.events where id = p_guest.event_id $$;

-- Aplica operaciones en un lote de Booking con el usuario del portal como actor (rol `editor` explícito, Core ronda §16),
-- marcando quién escribe para la procedencia. Pasa por los hooks de validación como cualquier lote.
create or replace function booking.portal_apply(p_writer text, p_actor uuid, p_ops jsonb)
returns jsonb language plpgsql as $$
declare v_cursor bigint; v_next bigint; v_results jsonb;
begin
  select cursor into v_cursor from core.app_state where app = 'booking' for update;
  v_next := v_cursor + 1;
  perform set_config('booking.writer', p_writer, true);
  v_results := core.apply_operations('booking', p_actor, 'editor', 'portal-' || p_writer || '-' || gen_random_uuid(), v_next, p_ops);
  perform set_config('booking.writer', '', true);
  update core.app_state set cursor = v_next where app = 'booking';
  return jsonb_build_object('cursor', v_next, 'results', v_results);
end $$;

-- Solo los campos de datos que un portal puede escribir.
create or replace function booking.portal_clean_fields(p_fields jsonb)
returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(p_fields, '{}'::jsonb))
   where key = any(booking.portal_guest_fields());
$$;

-- Operaciones que registran la declaración si aún no consta (vacío si ya la hizo); falla si hace falta y no viene.
create or replace function booking.portal_declaration_ops(p jsonb, p_reservation uuid)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid; v_version text := left(coalesce(nullif(p->'args'->>'declaration_version', ''), 'v1'), 40);
begin
  if exists (select 1 from booking.portal_declarations where reservation_id = p_reservation and user_id = v_actor and deleted_at is null) then
    return '[]'::jsonb;
  end if;
  if coalesce((p->'args'->>'declaration')::boolean, false) is not true then
    perform core.fail('DECLARATION_REQUIRED', 422, jsonb_build_object('reservation_id', p_reservation));
  end if;
  return jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'booking.portal_declarations', 'id', gen_random_uuid(),
    'fields', jsonb_build_object('reservation_id', p_reservation, 'user_id', v_actor, 'text_version', v_version)));
end $$;

-- Vista de un huésped para el organizador: valor si lo escribió él; `true` si está rellenado por otro; `null` si vacío.
create or replace function booking.portal_organizer_guest(g booking.guests)
returns jsonb language plpgsql stable as $$
declare v_row jsonb := to_jsonb(g); v_fields jsonb := '{}'::jsonb; v_field text; v_mode text := booking.guest_mode(booking.portal_reservation_of(g));
begin
  foreach v_field in array booking.portal_guest_fields() loop
    v_fields := v_fields || jsonb_build_object(v_field,
      case when coalesce(v_row -> v_field, 'null'::jsonb) = 'null'::jsonb then 'null'::jsonb
           when g.field_sources -> v_field ->> 'by' = 'organizer' then v_row -> v_field
           else 'true'::jsonb end);
  end loop;
  return jsonb_build_object('id', g.id, 'revision', g.revision,
    'display_name', btrim(coalesce(g.first_name, '') || ' ' || coalesce(left(g.last_name_1, 1) || '.', '')),
    'fields', v_fields, 'missing', to_jsonb(booking.guest_missing(g, v_mode)), 'signed', g.signed_at is not null,
    'allergies_shared', g.allergies_visible_to_organizer,
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'restriction_type', d.restriction_type, 'subject', d.subject,
        'severity', d.severity, 'kitchen_notes', d.kitchen_notes, 'source', d.source) order by d.created_at)
      from booking.dietary_restrictions d
     where d.guest_id = g.id and d.deleted_at is null and (d.source = 'organizer' or g.allergies_visible_to_organizer)), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Lecturas para los portales (`{app, actor, role, args}`)
-- ---------------------------------------------------------------------------
create or replace function booking.portal_reservations(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_actor uuid := (p->>'actor')::uuid;
begin
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'start_date', r.start_date, 'end_date', r.end_date,
      'expected_guests', r.expected_guests, 'status', r.status, 'confirmed', e.id is not null, 'mode', booking.guest_mode(r.id),
      'guests', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null),
      'complete', (select count(*) from booking.guests g where g.event_id = e.id and g.deleted_at is null
                      and cardinality(booking.guest_missing(g, booking.guest_mode(r.id))) = 0)) order by r.start_date nulls last)
      from booking.reservations r
      left join booking.events e on e.reservation_id = r.id and e.deleted_at is null
     where r.deleted_at is null and booking.portal_in_scope('organizers', v_actor, r.id, null)), '[]'::jsonb));
end $$;

create or replace function booking.portal_guests(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_event uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select id into v_event from booking.events where reservation_id = v_res and deleted_at is null;
  if v_event is null then return jsonb_build_object('confirmed', false, 'items', '[]'::jsonb); end if;
  return jsonb_build_object('confirmed', true, 'mode', booking.guest_mode(v_res), 'items', coalesce((
    select jsonb_agg(booking.portal_organizer_guest(g) order by g.created_at)
      from booking.guests g where g.event_id = v_event and g.deleted_at is null), '[]'::jsonb));
end $$;

-- Cocina: agregado sin nombres de todo el grupo y, con nombre, solo lo que el organizador puede ver.
create or replace function booking.portal_kitchen_summary(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_event uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  select id into v_event from booking.events where reservation_id = v_res and deleted_at is null;
  return jsonb_build_object(
    'totals', coalesce((select jsonb_agg(jsonb_build_object('restriction_type', t.restriction_type, 'subject', t.subject, 'servings', t.n))
      from (select d.restriction_type, d.subject, sum(coalesce(d.servings, 1))::int n from booking.dietary_restrictions d
             where d.event_id = v_event and d.deleted_at is null and d.active group by 1, 2 order by 1, 2) t), '[]'::jsonb),
    'named', coalesce((select jsonb_agg(jsonb_build_object('guest', btrim(coalesce(g.first_name, '') || ' ' || coalesce(left(g.last_name_1, 1) || '.', '')),
        'restriction_type', d.restriction_type, 'subject', d.subject, 'severity', d.severity) order by g.first_name)
      from booking.dietary_restrictions d join booking.guests g on g.id = d.guest_id
     where d.event_id = v_event and d.deleted_at is null and g.deleted_at is null and (d.source = 'organizer' or g.allergies_visible_to_organizer)), '[]'::jsonb));
end $$;

create or replace function booking.portal_my_guest(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_r booking.reservations; v_field text; v_fields jsonb := '{}'::jsonb; v_row jsonb; v_res uuid;
begin
  begin v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid); exception when invalid_text_representation then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p->'args'->>'guest_id')); end;
  v_res := booking.portal_reservation_of(v_g);
  select * into v_r from booking.reservations where id = v_res;
  v_row := to_jsonb(v_g);
  foreach v_field in array booking.portal_guest_fields() loop v_fields := v_fields || jsonb_build_object(v_field, v_row -> v_field); end loop;
  return jsonb_build_object('id', v_g.id, 'revision', v_g.revision, 'fields', v_fields, 'mode', booking.guest_mode(v_res),
    'missing', to_jsonb(booking.guest_missing(v_g, booking.guest_mode(v_res))), 'signed', v_g.signed_at is not null,
    'allergies_visible_to_organizer', v_g.allergies_visible_to_organizer, 'privacy_ack_at', v_g.privacy_ack_at, 'privacy_ack_version', v_g.privacy_ack_version,
    'reservation', jsonb_build_object('title', v_r.title, 'start_date', v_r.start_date, 'end_date', v_r.end_date),
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'restriction_type', d.restriction_type, 'subject', d.subject,
        'severity', d.severity, 'kitchen_notes', d.kitchen_notes) order by d.created_at)
      from booking.dietary_restrictions d where d.guest_id = v_g.id and d.deleted_at is null), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------------
-- Acciones de los portales
-- ---------------------------------------------------------------------------
create or replace function booking.portal_add_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; v_event uuid; v_id uuid; v_fields jsonb := booking.portal_clean_fields(p->'args'->'fields'); v_out jsonb;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reservation_id and guest_id must be uuids')); end if;
  if not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res)); end if;
  select e.id into v_event from booking.events e join booking.reservations r on r.id = e.reservation_id
   where e.reservation_id = v_res and e.deleted_at is null and r.deleted_at is null and r.status not in ('cancelada','perdida');
  if v_event is null then perform core.fail('RESERVATION_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_res)); end if;
  if coalesce(btrim(v_fields->>'first_name'), '') = '' then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'first_name')); end if;
  v_out := booking.portal_apply('organizer', (p->>'actor')::uuid, booking.portal_declaration_ops(p, v_res) || jsonb_build_array(
    jsonb_build_object('op', 'insert', 'table', 'booking.guests', 'id', v_id, 'fields', v_fields || jsonb_build_object('event_id', v_event))));
  return jsonb_build_object('guest_id', v_id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_update_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb := booking.portal_clean_fields(p->'args'->'fields'); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no fields')); end if;
  v_out := booking.portal_apply('organizer', (p->>'actor')::uuid, booking.portal_declaration_ops(p, booking.portal_reservation_of(v_g)) || jsonb_build_array(
    jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
      'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

-- Baja en cualquier momento (decisión del usuario, 7-10-2026), aunque haya rellenado datos: va a la papelera de Booking con
-- quién y cuándo (`updated_by` = el organizador), con sus restricciones y asignaciones, y se revoca su enlace. Al vaciar la
-- papelera se borra de verdad. Excepción: si ya hizo la entrada (firmó el parte con el retiro empezado) o su parte ya se
-- comunicó a SES, lo corrige el personal (`GUEST_CHECKED_IN`).
create or replace function booking.portal_remove_guest(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_ops jsonb := '[]'::jsonb; r record; v_out jsonb; v_start date;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  select start_date into v_start from booking.reservations where id = booking.portal_reservation_of(v_g);
  if v_g.ses_status = 'enviado_SES' or (v_g.signed_at is not null and v_start is not null and v_start <= (now() at time zone 'Europe/Madrid')::date) then
    perform core.fail('GUEST_CHECKED_IN', 422, jsonb_build_object('guest_id', v_g.id));
  end if;
  for r in select id, revision from booking.dietary_restrictions where guest_id = v_g.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.dietary_restrictions', 'id', r.id, 'expectedRevision', r.revision);
  end loop;
  for r in select id, revision from booking.room_assignments where guest_id = v_g.id and deleted_at is null loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.room_assignments', 'id', r.id, 'expectedRevision', r.revision);
  end loop;
  v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision));
  v_out := booking.portal_apply('organizer', (p->>'actor')::uuid, v_ops);
  -- su enlace de Guests deja de valer en la misma acción (Core, ronda §16)
  update core.portal_links set revoked_at = now()
   where app = 'guests' and revoked_at is null and scope ->> 'guest_id' = v_g.id::text;
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

-- Restricciones de un huésped: sustituye las de quien escribe (el organizador, las suyas; el huésped, todas las de su ficha).
create or replace function booking.portal_set_restrictions(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_writer text := case when p->>'app' = 'guests' then 'guest' else 'organizer' end;
  v_g booking.guests; v_ops jsonb := '[]'::jsonb; r record; v_item jsonb; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if jsonb_typeof(p->'args'->'items') <> 'array' or jsonb_array_length(p->'args'->'items') > 30 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'items must be an array (max 30)'));
  end if;
  if v_writer = 'organizer' then v_ops := booking.portal_declaration_ops(p, booking.portal_reservation_of(v_g)); end if;
  for r in select id, revision from booking.dietary_restrictions
            where guest_id = v_g.id and deleted_at is null and (v_writer = 'guest' or source = 'organizer') loop
    v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'booking.dietary_restrictions', 'id', r.id, 'expectedRevision', r.revision);
  end loop;
  for v_item in select * from jsonb_array_elements(p->'args'->'items') loop
    v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'booking.dietary_restrictions', 'id', gen_random_uuid(),
      'fields', jsonb_strip_nulls(jsonb_build_object('event_id', v_g.event_id, 'guest_id', v_g.id, 'restriction_type', v_item->>'restriction_type',
        'subject', v_item->>'subject', 'severity', v_item->>'severity', 'kitchen_notes', v_item->>'kitchen_notes')));
  end loop;
  if v_ops = '[]'::jsonb then return jsonb_build_object('guest_id', v_g.id, 'cursor', null); end if;
  v_out := booking.portal_apply(v_writer, (p->>'actor')::uuid, v_ops);
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guest_update(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb := booking.portal_clean_fields(p->'args'->'fields'); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no fields')); end if;
  v_out := booking.portal_apply('guest', (p->>'actor')::uuid, jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guest_consent(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb := '{}'::jsonb; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  if p->'args' ? 'allergies_visible_to_organizer' then
    v_fields := v_fields || jsonb_build_object('allergies_visible_to_organizer', coalesce((p->'args'->>'allergies_visible_to_organizer')::boolean, false));
  end if;
  if coalesce(p->'args'->>'privacy_ack_version', '') <> '' then
    v_fields := v_fields || jsonb_build_object('privacy_ack_at', now(), 'privacy_ack_version', left(p->'args'->>'privacy_ack_version', 40));
  end if;
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'nothing to change')); end if;
  v_out := booking.portal_apply('guest', (p->>'actor')::uuid, jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

-- Firma del parte por el propio huésped: el archivo lo sube Guests (`guests-api`, bucket `guests-documents`) y debe ser suyo.
create or replace function booking.portal_guest_sign(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_file uuid; v_name text := btrim(coalesce(p->'args'->>'signed_by_name', '')); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  begin v_file := (p->'args'->>'file_id')::uuid; exception when others then v_file := null; end;
  if v_file is null or not exists (select 1 from core.files f where f.id = v_file and f.app = 'guests' and f.created_by = (p->>'actor')::uuid and f.status = 'verified') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'file must be a verified upload of this guest'));
  end if;
  if v_name = '' or length(v_name) > 200 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'signed_by_name')); end if;
  v_out := booking.portal_apply('guest', (p->>'actor')::uuid, jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision),
    'fields', jsonb_build_object('signature_file_id', v_file, 'signed_at', now(), 'signed_by_name', v_name))));
  return jsonb_build_object('guest_id', v_g.id, 'cursor', v_out->'cursor');
end $$;

-- Archivo de la firma de un huésped para que la Edge de Booking firme su URL (solo si quien pide puede ver huéspedes:
-- lo comprueba la Edge). Vale para firmas subidas desde Guests (bucket `guests-documents`) y desde Booking.
create or replace function booking.guest_signature_file(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_id uuid; v_out jsonb;
begin
  begin v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_id := null; end;
  select jsonb_build_object('bucket', f.bucket, 'path', f.path, 'mime', f.mime, 'filename', f.filename) into v_out
    from booking.guests g join core.files f on f.id = g.signature_file_id and f.status = 'verified' and f.app in ('booking','guests')
   where g.id = v_id and g.deleted_at is null;
  return coalesce(v_out, 'null'::jsonb);
end $$;
select core.allow_read('booking', 'booking.guest_signature_file', 'function', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Registro en los portales (los miembros de un portal son `editor`)
-- ---------------------------------------------------------------------------
select core.allow_read('organizers', 'booking.portal_reservations', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_guests', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_kitchen_summary', 'function', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_my_guest', 'function', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_add_guest', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_update_guest', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_remove_guest', 'action', '{editor,owner}');
select core.allow_read('organizers', 'booking.portal_set_restrictions', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_set_restrictions', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_guest_update', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_guest_consent', 'action', '{editor,owner}');
select core.allow_read('guests', 'booking.portal_guest_sign', 'action', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
