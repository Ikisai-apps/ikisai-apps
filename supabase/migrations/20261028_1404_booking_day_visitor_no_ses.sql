-- Ikisai Booking · Alojamiento libre, tarjeta 6 (VG 27-10-2026; aceptación H del traspaso): a quien solo viene a la
-- jornada y no duerme no se le pide el DNI.
-- - Al aceptar a un visitante del QR que pidió apuntarse (`kind = 'join'`, sin noches) en unas jornadas abiertas, su ficha
--   nace sin SES: `ses_status = 'no_aplica'` y `data_status = 'no_aplica'`. La ficha lo enseña como «Sin pernocta».
-- - Si después se le da cama (una asignación con él), vuelve a necesitar SES: `pendiente_envio` y `pendiente_datos`.
-- - El parte de viajeros (`ses_guest_report_source_base`, de 0446 y 0494) deja fuera a quien está en `no_aplica`.
-- Los cambios van por `core.apply_row_op` desde el lote en curso (`booking.batch_setting`, 0499): quedan en core.changes.
-- Toca solo el schema booking.

create or replace function booking.visitor_day_only()
returns trigger language plpgsql as $$
declare g booking.guests;
begin
  if new.kind = 'join' and new.status = 'aceptada' and old.status = 'pendiente' and new.guest_id is not null
     and exists (select 1 from booking.events e join booking.reservations r on r.id = e.reservation_id
                  where e.id = new.event_id and r.event_type = 'jornadas_abiertas') then
    select * into g from booking.guests where id = new.guest_id;
    if g.id is not null and g.ses_status = 'pendiente_envio' then
      perform core.apply_row_op(booking.batch_setting('app'), nullif(booking.batch_setting('actor'), '')::uuid, 'editor',
        booking.batch_setting('request_id'), booking.batch_setting('cursor')::bigint,
        jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', g.id, 'expectedRevision', g.revision,
          'fields', jsonb_build_object('ses_status', 'no_aplica', 'data_status', 'no_aplica')));
    end if;
  end if;
  return null;
end $$;
create trigger visitor_requests_day_only after update on booking.visitor_requests
  for each row execute function booking.visitor_day_only();

-- Con cama, vuelve a necesitar SES.
create or replace function booking.assignment_needs_ses()
returns trigger language plpgsql as $$
declare g booking.guests;
begin
  if new.guest_id is null or new.deleted_at is not null then return null; end if;
  select * into g from booking.guests where id = new.guest_id;
  if g.id is not null and g.ses_status = 'no_aplica' and g.data_status = 'no_aplica' then
    perform core.apply_row_op(booking.batch_setting('app'), nullif(booking.batch_setting('actor'), '')::uuid, 'editor',
      booking.batch_setting('request_id'), booking.batch_setting('cursor')::bigint,
      jsonb_build_object('op', 'update', 'table', 'booking.guests', 'id', g.id, 'expectedRevision', g.revision,
        'fields', jsonb_build_object('ses_status', 'pendiente_envio', 'data_status', 'pendiente_datos')));
  end if;
  return null;
end $$;
create trigger room_assignments_needs_ses after insert on booking.room_assignments
  for each row execute function booking.assignment_needs_ses();

-- El parte de viajeros sin quien no duerme (la de 0446, que 0494 dejó como _base, con `no_aplica` fuera).
create or replace function booking.ses_guest_report_source_base(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_id uuid; v_r booking.reservations; v_f booking.reservation_finance; v_e booking.events; v_s booking.ses_settings;
  v_only uuid[]; v_items jsonb := '[]'::jsonb; g booking.guests; v_missing text[];
  -- el tick reconstruye un parte ya preparado: sus propios huéspedes no cuentan como «ya en otro parte»
  v_except uuid := nullif(p->'args'->>'communication_id', '')::uuid;
begin
  begin v_id := (p->'args'->>'reservation_id')::uuid; exception when others then v_id := null; end;
  select * into v_r from booking.reservations where id = v_id and deleted_at is null;
  if v_r.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', p->'args'->>'reservation_id')); end if;
  if not v_r.ses_enabled then perform core.fail('SES_DISABLED', 422, jsonb_build_object('reservation_id', v_id)); end if;
  select * into v_e from booking.events where reservation_id = v_id and deleted_at is null;
  if v_e.id is null then perform core.fail('SES_NOT_CONFIRMED', 422, jsonb_build_object('reservation_id', v_id)); end if;
  select * into v_f from booking.reservation_finance where id = v_id and deleted_at is null;
  select * into v_s from booking.ses_settings where deleted_at is null limit 1;
  if jsonb_typeof(p->'args'->'guest_ids') = 'array' then
    select array_agg(x::uuid) into v_only from jsonb_array_elements_text(p->'args'->'guest_ids') x;
  end if;

  -- quien ya consta como enviado a SES (también a mano, con «Registrar envío») no se vuelve a ofrecer
  for g in select gg.* from booking.guests gg where gg.event_id = v_e.id and gg.deleted_at is null and gg.arrived_at is not null
            and gg.ses_status not in ('enviado_SES', 'no_aplica')
            and (v_only is null or gg.id = any(v_only))
            and not exists (select 1 from booking.ses_communications c where c.reservation_id = v_id and c.kind = 'PV'
                             and c.status in ('preparada','enviando','en_proceso','aceptada','error') and gg.id = any(c.guest_ids)
                             and c.id is distinct from v_except)
            order by gg.arrived_at, gg.created_at loop
    v_missing := booking.guest_missing(g, 'ses');
    if not g.is_minor and g.document_checked_at is null then v_missing := array_append(v_missing, 'document_checked'); end if;
    if booking.signs_own_entry(g, v_r.start_date) and g.signed_at is null then v_missing := array_append(v_missing, 'signature'); end if;
    v_items := v_items || jsonb_build_object('id', g.id, 'ready', cardinality(v_missing) = 0, 'missing', to_jsonb(v_missing),
      'first_name', g.first_name, 'last_name_1', g.last_name_1, 'last_name_2', g.last_name_2, 'document_type', g.document_type,
      'document_number', g.document_number, 'document_support_number', g.document_support_number, 'birth_date', g.birth_date,
      'nationality', g.nationality, 'sex', g.sex, 'residence_address', g.residence_address, 'residence_postal_code', g.residence_postal_code,
      'residence_city', g.residence_city, 'residence_country', g.residence_country, 'phone', g.phone, 'email', g.email,
      'is_minor', g.is_minor, 'kinship', g.kinship, 'arrived_at', g.arrived_at);
  end loop;

  return jsonb_build_object(
    'reservation', jsonb_build_object('id', v_r.id, 'code', v_r.code, 'start_date', v_r.start_date, 'end_date', v_r.end_date,
      'persons', coalesce(v_e.final_guests, v_r.expected_guests), 'arrival_time', v_e.arrival_time, 'departure_time', v_e.departure_time, 'rooms', v_e.rooms_count),
    'payment', jsonb_build_object('type', coalesce(v_f.payment_type, 'otro'), 'date', v_f.payment_date, 'holder', v_f.payment_holder,
      'contract_date', (coalesce(v_f.payment_registered_at, v_e.created_at) at time zone 'Europe/Madrid')::date),
    'settings', jsonb_build_object('environment', coalesce(v_s.environment, 'pre'), 'paused', coalesce(v_s.paused, false)),
    'guests', v_items);
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
