-- Ikisai Booking · llegada y salida de huéspedes desde Flow (VG 27-10-2026, acordado con Flow): Llegada → Cama → Firma
-- → Salida en el móvil de recepción.
-- - `booking.flow_guests_of({event_id})` (Flow: reader, editor, owner y outsider; decisión de Core): los huéspedes de UN
--   evento, y solo si ese evento está en el ámbito de la persona en Flow (`core.reader_in_scope`, 0098). Usa la vista
--   `booking.flow_guests_projection`, que no se abre a Flow: una fila por huésped vivo de un evento vivo, sin el de
--   muestra ni los anonimizados. Lleva nombre corto, `portal_role`, su cama asignada, sus noches (las de la asignación o
--   las de la reserva), `arrived_at`, `left_at` y si firmó. Sin documento, contacto ni datos de SES.
-- - `booking.guest_arrive` y `booking.guest_leave` ({guest_id, undo?}), procedimientos de Booking: Flow los llama por
--   booking-api con el token de la persona (editor en Booking). Son idempotentes: repetir no cambia nada y devuelve el
--   estado; `undo: true` deshace el último toque. No se deshace la llegada de quien ya está comunicado a SES
--   (`SES_ALREADY_REGISTERED`), ni se marca la de una ficha de equipo, que no va a SES (`TEAM_GUEST`).
-- Toca solo el schema booking.

alter table booking.guests add column left_at timestamptz;
alter table booking.guests add constraint guests_left_after_arrival check (left_at is null or arrived_at is null or left_at >= arrived_at);
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview',
  'room_preference','needs_ground_floor','person_key','portal_role','meal_group','left_at'],
  '{editor,owner}', '{editor,owner}');

create or replace view booking.flow_guests_projection as
select
  g.event_id,
  g.id as guest_id,
  g.revision as guest_revision,
  btrim(g.first_name || coalesce(' ' || upper(left(nullif(btrim(g.last_name_1), ''), 1)) || '.', '')) as display_name,
  g.portal_role,
  s.name as space_name,
  b.label as bed_label,
  coalesce(a.from_date, r.start_date) as from_date,
  coalesce(a.to_date, r.end_date) as to_date,
  g.arrived_at,
  g.left_at,
  g.signed_at is not null as signed
from booking.guests g
join booking.events e on e.id = g.event_id and e.deleted_at is null
join booking.reservations r on r.id = e.reservation_id and r.deleted_at is null and r.status not in ('cancelada', 'perdida')
left join lateral (
  select ra.* from booking.room_assignments ra where ra.guest_id = g.id and ra.event_id = g.event_id and ra.deleted_at is null
   order by ra.bed_id is null, ra.created_at desc limit 1) a on true
left join booking.spaces s on s.id = a.space_id
left join booking.beds b on b.id = a.bed_id
where g.deleted_at is null and not g.preview and g.anonymized_at is null;

revoke all on booking.flow_guests_projection from public, anon, authenticated;
grant select on booking.flow_guests_projection to service_role;
select core.allow_read('booking', 'booking.flow_guests_projection', 'view');

-- Flow lee los huéspedes de un evento concreto de su ámbito, nunca todos.
create or replace function booking.flow_guests_of(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid;
begin
  begin v_event := (p->'args'->>'event_id')::uuid; exception when others then v_event := null; end;
  if v_event is null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'event_id')); end if;
  if not core.reader_in_scope(p->>'app', (p->>'actor')::uuid, 'booking_event', v_event::text) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'event not in scope', 'event_id', v_event));
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(to_jsonb(f) order by f.display_name, f.guest_id) from booking.flow_guests_projection f where f.event_id = v_event), '[]'::jsonb));
end $$;
select core.allow_read('flow', 'booking.flow_guests_of', 'function', '{reader,editor,owner,outsider}');

-- Estado que devuelven los dos procedimientos.
create or replace function booking.guest_presence(p_guest uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('guest_id', g.id, 'arrived_at', g.arrived_at, 'left_at', g.left_at, 'revision', g.revision)
    from booking.guests g where g.id = p_guest;
$$;

create or replace function booking.guest_for_presence(p jsonb)
returns booking.guests language plpgsql stable as $$
declare v_g booking.guests; v_id uuid;
begin
  begin v_id := (p->'args'->>'guest_id')::uuid; exception when others then v_id := null; end;
  select * into v_g from booking.guests where id = v_id and deleted_at is null;
  if v_g.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.guests', 'id', p->'args'->>'guest_id')); end if;
  if v_g.preview then perform core.fail('PREVIEW_READ_ONLY', 403, jsonb_build_object('guest_id', v_g.id)); end if;
  return v_g;
end $$;

create or replace function booking.guest_arrive(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests := booking.guest_for_presence(p); v_undo boolean := coalesce((p->'args'->>'undo')::boolean, false); v_fields jsonb;
begin
  if not v_undo then
    if v_g.arrived_at is not null then return booking.guest_presence(v_g.id); end if;
    if v_g.portal_role is not null then perform core.fail('TEAM_GUEST', 422, jsonb_build_object('guest_id', v_g.id, 'reason', 'las fichas de equipo no marcan llegada (no van a SES)')); end if;
    v_fields := jsonb_build_object('arrived_at', now());
  else
    if v_g.arrived_at is null then return booking.guest_presence(v_g.id); end if;
    if v_g.ses_status = 'enviado_SES' then perform core.fail('SES_ALREADY_REGISTERED', 409, jsonb_build_object('guest_id', v_g.id)); end if;
    if v_g.left_at is not null then perform core.fail('GUEST_ALREADY_LEFT', 409, jsonb_build_object('guest_id', v_g.id)); end if;
    v_fields := jsonb_build_object('arrived_at', null);
  end if;
  perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id, 'expectedRevision', v_g.revision, 'fields', v_fields));
  return booking.guest_presence(v_g.id);
end $$;

create or replace function booking.guest_leave(p jsonb)
returns jsonb language plpgsql as $$
declare v_g booking.guests := booking.guest_for_presence(p); v_undo boolean := coalesce((p->'args'->>'undo')::boolean, false); v_fields jsonb;
begin
  if not v_undo then
    if v_g.left_at is not null then return booking.guest_presence(v_g.id); end if;
    v_fields := jsonb_build_object('left_at', now());
  else
    if v_g.left_at is null then return booking.guest_presence(v_g.id); end if;
    v_fields := jsonb_build_object('left_at', null);
  end if;
  perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', v_g.id, 'expectedRevision', v_g.revision, 'fields', v_fields));
  return booking.guest_presence(v_g.id);
end $$;

select core.allow_procedure('booking', 'booking.guest_arrive');
select core.allow_procedure('booking', 'booking.guest_leave');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
