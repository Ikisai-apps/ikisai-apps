-- Ikisai Booking · B5 de Organizers (27-10-2026): en la ficha que ve el organizador, `is_minor` no distinguía «nadie lo
-- ha contestado» (el false por defecto) de «vale false», y el false por defecto contaba como rellenado.
-- - `portal_organizer_guest`: `is_minor` sale null si nadie lo contestó (sin entrada en `field_sources`), como un campo vacío.
-- - Para que contestar «no» cuente: `portal_apply` dice qué campos de la ficha trae el lote (`booking.answered`) y
--   `guest_track_sources` apunta `is_minor` como contestado por el organizador o el huésped aunque valga false o no cambie.
-- Toca solo el schema booking.

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

  -- B5 de Organizers: un booleano de la ficha (is_minor) que el portal contesta queda como contestado aunque valga false
  -- o no cambie (la vuelta de arriba solo apunta los cambios y no un false al crear).
  if 'is_minor' = any(string_to_array(coalesce(current_setting('booking.answered', true), ''), ','))
     and v_writer in ('organizer', 'guest') and not (coalesce(new.field_sources, '{}'::jsonb) ? 'is_minor') then
    new.field_sources := jsonb_set(coalesce(new.field_sources, '{}'::jsonb), array['is_minor'], jsonb_build_object('by', v_writer, 'at', now()));
  end if;

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

create or replace function booking.portal_apply(p_writer text, p_ops jsonb)
returns jsonb language plpgsql as $$
declare v_out jsonb;
begin
  perform set_config('booking.writer', p_writer, true);
  -- B5: qué campos de la ficha contesta este lote (para los booleanos, aunque no cambien)
  perform set_config('booking.answered', coalesce((select string_agg(distinct k, ',') from jsonb_array_elements(p_ops) o, jsonb_object_keys(coalesce(o->'fields', '{}'::jsonb)) k
    where o->>'table' = 'booking.guests'), ''), true);
  v_out := core.apply_portal_operations('booking', p_ops);
  perform set_config('booking.answered', '', true);
  perform set_config('booking.writer', '', true);
  return v_out;
end $$;

create or replace function booking.portal_organizer_guest(g booking.guests)
returns jsonb language plpgsql stable as $$
declare v_row jsonb := to_jsonb(g); v_fields jsonb := '{}'::jsonb; v_field text; v_mode text := booking.guest_mode(booking.portal_reservation_of(g));
begin
  foreach v_field in array booking.portal_guest_fields() loop
    v_fields := v_fields || jsonb_build_object(v_field,
      case when coalesce(v_row -> v_field, 'null'::jsonb) = 'null'::jsonb then 'null'::jsonb
           -- B5: un booleano que nadie contestó (el false por defecto) no cuenta como rellenado
           when v_field = 'is_minor' and not (coalesce(g.field_sources, '{}'::jsonb) ? 'is_minor') then 'null'::jsonb
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

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
