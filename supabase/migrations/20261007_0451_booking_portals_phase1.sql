-- Ikisai Booking · peticiones de fase 1 de los portales (Guests BG1–BG6, Organizers B11 y núcleo C6; Core, 7-10-2026).
-- Toca solo el schema booking.

-- BG3 y BG5: alimentación revisada (solo la marcan las acciones de portal) y versión del texto firmado.
alter table booking.guests
  add column diet_reviewed_at timestamptz,
  add column signature_text_version text check (signature_text_version is null or length(signature_text_version) between 1 and 40);

select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version'],
  '{editor,owner}', '{editor,owner}');

create or replace function booking.guest_track_sources()
returns trigger language plpgsql as $$
declare
  v_writer text := booking.writer();
  v_registry_changed boolean := false;
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
      v_registry_changed := true;
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
  -- BG5: tras cambiar un dato del registro, la firma ya no corresponde a lo firmado (salvo que se firme en el mismo cambio
  -- o que sea la anonimización de la conservación)
  if tg_op = 'UPDATE' and v_registry_changed and old.signed_at is not null and new.anonymized_at is null
     and new.signed_at is not distinct from old.signed_at and new.signature_file_id is not distinct from old.signature_file_id then
    new.signed_at := null; new.signature_file_id := null; new.signed_by_name := null; new.signature_text_version := null;
  end if;
  return new;
end $$;

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
    'allergies_shared', g.allergies_visible_to_organizer, 'diet_reviewed', g.diet_reviewed_at is not null,
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'restriction_type', d.restriction_type, 'subject', d.subject,
        'severity', d.severity, 'kitchen_notes', d.kitchen_notes, 'source', d.source) order by d.created_at)
      from booking.dietary_restrictions d
     where d.guest_id = g.id and d.deleted_at is null and (d.source = 'organizer' or g.allergies_visible_to_organizer)), '[]'::jsonb));
end $$;

create or replace function booking.portal_my_guest(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_g booking.guests; v_r booking.reservations; v_e booking.events; v_field text; v_fields jsonb := '{}'::jsonb; v_row jsonb; v_res uuid;
begin
  begin v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid); exception when invalid_text_representation then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('guest_id', p->'args'->>'guest_id')); end;
  v_res := booking.portal_reservation_of(v_g);
  select * into v_r from booking.reservations where id = v_res;
  select * into v_e from booking.events where id = v_g.event_id;
  v_row := to_jsonb(v_g);
  foreach v_field in array booking.portal_guest_fields() loop v_fields := v_fields || jsonb_build_object(v_field, v_row -> v_field); end loop;
  return jsonb_build_object('id', v_g.id, 'revision', v_g.revision, 'fields', v_fields, 'mode', booking.guest_mode(v_res),
    'missing', to_jsonb(booking.guest_missing(v_g, booking.guest_mode(v_res))), 'signed', v_g.signed_at is not null,
    'allergies_visible_to_organizer', v_g.allergies_visible_to_organizer, 'privacy_ack_at', v_g.privacy_ack_at, 'privacy_ack_version', v_g.privacy_ack_version,
    'reservation', jsonb_build_object('title', v_r.title, 'start_date', v_r.start_date, 'end_date', v_r.end_date, 'status', v_r.status,
      'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time),
    'sources', coalesce((select jsonb_object_agg(key, value->>'by') from jsonb_each(v_g.field_sources)), '{}'::jsonb),
    'diet_reviewed_at', v_g.diet_reviewed_at, 'signature_text_version', v_g.signature_text_version,
    'restrictions', coalesce((select jsonb_agg(jsonb_build_object('id', d.id, 'restriction_type', d.restriction_type, 'subject', d.subject,
        'severity', d.severity, 'kitchen_notes', d.kitchen_notes, 'source', d.source) order by d.created_at)
      from booking.dietary_restrictions d where d.guest_id = v_g.id and d.deleted_at is null), '[]'::jsonb));
end $$;

create or replace function booking.portal_guest_update(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_fields jsonb; v_mode text; v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  v_mode := booking.guest_mode(booking.portal_reservation_of(v_g));
  if v_mode = 'ninguno' then perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('guest_id', v_g.id)); end if;
  v_fields := booking.portal_clean_fields(p->'args'->'fields', v_mode);
  if v_fields = '{}'::jsonb then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'no fields')); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'revision', (select revision from booking.guests where id = v_g.id), 'cursor', v_out->'cursor',
    'signature_reset', v_g.signed_at is not null and (select signed_at from booking.guests where id = v_g.id) is null);
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
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision), 'fields', v_fields)));
  return jsonb_build_object('guest_id', v_g.id, 'revision', (select revision from booking.guests where id = v_g.id), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.portal_guest_sign(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests; v_file uuid; v_name text := btrim(coalesce(p->'args'->>'signed_by_name', '')); v_out jsonb;
begin
  v_g := booking.portal_guest_row(p, (p->'args'->>'guest_id')::uuid);
  -- sin comunicación a SES no hay parte que firmar (minimización)
  if booking.guest_mode(booking.portal_reservation_of(v_g)) <> 'ses' then
    perform core.fail('GUEST_DATA_OFF', 422, jsonb_build_object('guest_id', v_g.id, 'reason', 'signature'));
  end if;
  begin v_file := (p->'args'->>'file_id')::uuid; exception when others then v_file := null; end;
  if v_file is null or not exists (select 1 from core.files f where f.id = v_file and f.app = 'guests' and f.created_by = (p->>'actor')::uuid and f.status = 'verified') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'file must be a verified upload of this guest'));
  end if;
  if v_name = '' or length(v_name) > 200 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'booking.guests', 'field', 'signed_by_name')); end if;
  v_out := booking.portal_apply('guest', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id,
    'expectedRevision', coalesce((p->'args'->>'expectedRevision')::bigint, v_g.revision),
    'fields', jsonb_build_object('signature_file_id', v_file, 'signed_at', now(), 'signed_by_name', v_name,
      'signature_text_version', nullif(left(p->'args'->>'text_version', 40), '')))));
  return jsonb_build_object('guest_id', v_g.id, 'revision', (select revision from booking.guests where id = v_g.id), 'cursor', v_out->'cursor');
end $$;

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
  -- «No tengo alergias ni dieta especial» (lista vacía) también cuenta como revisado
  v_ops := v_ops || jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id, 'expectedRevision', v_g.revision,
    'fields', jsonb_build_object('diet_reviewed_at', now()));
  v_out := booking.portal_apply(v_writer, v_ops);
  return jsonb_build_object('guest_id', v_g.id, 'revision', (select revision from booking.guests where id = v_g.id), 'cursor', v_out->'cursor');
end $$;

create or replace function booking.retention_run(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_ops jsonb := '[]'::jsonb; g booking.guests; r record; v_files uuid[] := '{}'; v_count int := 0; v_out jsonb; v_ids uuid[] := '{}'; v_id uuid;
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
    v_ids := v_ids || g.id;
    exit when jsonb_array_length(v_ops) > 450;
  end loop;
  if v_count = 0 then return jsonb_build_object('anonymized', 0); end if;

  -- los archivos ya no tienen retención que los proteja: la recogida de huérfanos los borra sin esperar
  update core.files set retention_class = 'temporary' where id = any(v_files);
  v_out := core.apply_system_operations('booking', v_ops);
  -- C6: el enlace y el permiso del huésped en Guests dejan de valer (el núcleo borra las cuentas internas sin entradas)
  foreach v_id in array v_ids loop perform core.portal_revoke_scope('guests', 'guest_id', v_id::text); end loop;
  return jsonb_build_object('anonymized', v_count, 'files', cardinality(v_files), 'cursor', v_out->'cursor');
end $$;

-- B11 · coorganizadores de una reserva: solo los nombres para mostrar de quienes tienen acceso a ella en Organizers.
create or replace function booking.portal_organizers(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not booking.portal_in_scope('organizers', (p->>'actor')::uuid, v_res, null) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('display_name', coalesce(nullif(btrim(pr.display_name), ''), 'Organizador'), 'me', m.user_id = (p->>'actor')::uuid)
                     order by pr.display_name)
      from core.memberships m left join core.profiles pr on pr.user_id = m.user_id
     where m.app = 'organizers' and exists (select 1 from jsonb_array_elements(coalesce(m.scopes -> 'grants', '[]'::jsonb)) gr where gr ->> 'reservation_id' = v_res::text)), '[]'::jsonb));
end $$;
select core.allow_read('organizers', 'booking.portal_organizers', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
