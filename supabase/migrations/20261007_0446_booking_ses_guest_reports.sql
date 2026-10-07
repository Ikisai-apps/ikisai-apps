-- Ikisai Booking · SES.HOSPEDAJES, paso 3: llegada y parte de viajeros (PV) (docs/booking/API.md §17; diseño del usuario en
-- coordinacion/ampliacion/SES.md §3). El documento se comprueba a la vista y nunca se fotografía ni se guarda copia.
-- Toca solo el schema booking.

-- ---------------------------------------------------------------------------
-- Llegada y comprobación del documento (las escribe el personal)
-- ---------------------------------------------------------------------------
alter table booking.guests
  add column arrived_at timestamptz,
  add column document_checked_at timestamptz,
  add column document_checked_by uuid references auth.users(id);

select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by'],
  '{editor,owner}', '{editor,owner}');

-- ¿Firma el propio huésped? 14 años o más el día de entrada; sin fecha de nacimiento manda `is_minor` (igual que signsOwnEntry).
create or replace function booking.signs_own_entry(g booking.guests, p_on date)
returns boolean language sql immutable as $$
  select case when g.birth_date is null or p_on is null then not g.is_minor
              else extract(year from age(p_on, g.birth_date)) >= 14 end;
$$;

-- ---------------------------------------------------------------------------
-- Datos para el parte de viajeros: huéspedes que han llegado y aún no están en un parte en proceso o aceptado.
-- Cada uno sale como listo o con lo que le falta (datos de SES, documento comprobado, firma).
-- ---------------------------------------------------------------------------
create or replace function booking.ses_guest_report_source(p jsonb)
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

  for g in select gg.* from booking.guests gg where gg.event_id = v_e.id and gg.deleted_at is null and gg.arrived_at is not null
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

create or replace function booking.ses_guest_report_source_system(p jsonb)
returns jsonb language sql stable as $$ select booking.ses_guest_report_source(p) $$;

-- Preparar un parte: como ses_prepare, con los huéspedes incluidos y sin repetir a nadie que ya esté en otro parte vivo.
create or replace function booking.ses_prepare_guest_report(p jsonb)
returns jsonb language plpgsql as $$
declare v_a jsonb := p->'args'; v_id uuid; v_reservation uuid := (v_a->>'reservation_id')::uuid; v_guests uuid[];
begin
  select array_agg(x::uuid) into v_guests from jsonb_array_elements_text(v_a->'guest_ids') x;
  if v_guests is null or cardinality(v_guests) = 0 then perform core.fail('SES_NO_GUESTS', 422, jsonb_build_object('reservation_id', v_reservation)); end if;
  if exists (select 1 from booking.ses_communications c where c.reservation_id = v_reservation and c.kind = 'PV'
              and c.status in ('preparada','enviando','en_proceso','aceptada','error') and c.guest_ids && v_guests) then
    perform core.fail('SES_ALREADY_COMMUNICATED', 409, jsonb_build_object('reservation_id', v_reservation));
  end if;
  insert into booking.ses_communications (reservation_id, kind, guest_ids, environment, content_sha256, snapshot, legal_start_at, requested_by, next_attempt_at)
  values (v_reservation, 'PV', v_guests, v_a->>'environment', v_a->>'content_sha256', coalesce(v_a->'snapshot', '{}'::jsonb),
          nullif(v_a->>'legal_start_at', '')::timestamptz, nullif(v_a->>'requested_by', '')::uuid, now())
  returning id into v_id;
  return jsonb_build_object('id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- Con un parte aceptado de alguien alojado, la reserva ya no deja de comunicarse a SES: eso es registro legal.
-- ---------------------------------------------------------------------------
create or replace function booking.check_ses_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select r.id into v_id from booking.reservations r
   where not r.ses_enabled and exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.kind = 'PV' and c.status = 'aceptada')
   limit 1;
  if v_id is not null then perform core.fail('SES_ALREADY_REGISTERED', 422, jsonb_build_object('reservation_id', v_id)); end if;
end $$;
select core.add_validate_hook('booking', 'booking.check_ses_invariants');

select core.allow_read('booking', 'booking.ses_guest_report_source', 'function', '{editor,owner}');
select core.allow_read('booking', 'booking.ses_guest_report_source_system', 'action', '{}');
select core.allow_read('booking', 'booking.ses_prepare_guest_report', 'action', '{}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
