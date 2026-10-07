-- Ikisai Booking · SES-4: conservación del registro de viajeros (docs/booking/API.md §20; RD 933/2021 art. 5.3).
-- 3 años desde el fin de la estancia con SES; 6 meses sin SES. Anonimiza en un lote del sistema (core.apply_system_operations)
-- para que los dispositivos reciban el cambio por core.changes y borren su copia local. Toca solo el schema booking.

alter table booking.guests add column anonymized_at timestamptz;

select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at'],
  '{editor,owner}', '{editor,owner}');

-- Fecha a partir de la cual los huéspedes de una reserva deben anonimizarse. Con SES (o con algún parte aceptado), 3 años desde
-- el fin de la estancia; sin SES, 6 meses. Sin fecha de salida, nunca.
create or replace function booking.retention_due_on(p_reservation uuid)
returns date language sql stable as $$
  select case
           when r.end_date is null then null
           when r.ses_enabled or exists (select 1 from booking.ses_communications c where c.reservation_id = r.id and c.kind = 'PV' and c.status = 'aceptada')
             then (r.end_date + interval '3 years')::date
           else (r.end_date + interval '6 months')::date
         end
    from booking.reservations r where r.id = p_reservation;
$$;

-- Huéspedes vencidos y aún sin anonimizar (vivos; los de la papelera se borran al vaciarla).
create or replace function booking.retention_candidates(p_limit int)
returns setof booking.guests language sql stable as $$
  select g.* from booking.guests g
    join booking.events e on e.id = g.event_id
   where g.deleted_at is null and g.anonymized_at is null
     and booking.retention_due_on(e.reservation_id) <= (now() at time zone 'Europe/Madrid')::date
   order by g.created_at
   limit greatest(1, least(coalesce(p_limit, 100), 200));
$$;

create or replace function booking.retention_has_work()
returns boolean language sql stable as $$ select exists (select 1 from booking.retention_candidates(1)) $$;

-- Una vuelta: anonimiza como mucho `limit` huéspedes (y manda sus restricciones a la papelera) en un lote del sistema.
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

  -- los archivos ya no tienen retención que los proteja: la recogida de huérfanos los borra sin esperar
  update core.files set retention_class = 'temporary' where id = any(v_files);
  v_out := core.apply_system_operations('booking', v_ops);
  return jsonb_build_object('anonymized', v_count, 'files', cardinality(v_files), 'cursor', v_out->'cursor');
end $$;

select core.allow_read('booking', 'booking.retention_run', 'action', '{}');
select core.schedule_tick('booking', 'retention/tick', '30 3 * * *', 'booking.retention_has_work');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
