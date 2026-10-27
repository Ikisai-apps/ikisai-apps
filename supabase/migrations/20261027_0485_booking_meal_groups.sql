-- Ikisai Booking · grupo de comensal (VG 27-10-2026, acordado con Food): una etiqueta libre en la ficha del huésped
-- («VIP», «Ponentes», «Niños», «Familia»…), para las ofertas de comida de Food (`food.event_offers_projection`, que cruza
-- sus `meal_groups` con esta etiqueta). Food recibe el recuento por grupo en `food_event_projection.meal_groups`
-- ([{group, guests}], sin nombres; sin las fichas de equipo ni el huésped de muestra; los que no tienen grupo están en
-- `guest_count`), y `guest_summary` también (`mealGroups`). Toca solo el schema booking.

alter table booking.guests add column meal_group text check (meal_group is null or char_length(meal_group) <= 40);
select core.register_table('booking', 'booking', 'guests', array[
  'event_id','first_name','last_name_1','last_name_2','sex','document_type','document_number','document_support_number',
  'nationality','birth_date','residence_address','residence_postal_code','residence_city','residence_country','phone','email',
  'is_minor','guardian_name','kinship','signed_at','signed_by_name','signature_file_id',
  'data_status','ses_status','ses_sent_at','ses_sent_by','ses_receipt_ref','ses_receipt_file_id','notes',
  'allergies_visible_to_organizer','privacy_ack_at','privacy_ack_version',
  'arrived_at','document_checked_at','document_checked_by','anonymized_at','diet_reviewed_at','signature_text_version','preview',
  'room_preference','needs_ground_floor','person_key','portal_role','meal_group'],
  '{editor,owner}', '{editor,owner}');

-- La de 0484 con `meal_groups` al final.
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
  r.id as reservation_id,
  coalesce(to_jsonb(r.food_carta_ids), '[]'::jsonb) as carta_ids,
  coalesce((
    select jsonb_agg(jsonb_build_object('group', x.grp, 'guests', x.n) order by x.grp)
    from (select btrim(g.meal_group) as grp, count(*)::int as n
            from booking.guests g
           where g.event_id = e.id and g.deleted_at is null and not g.preview and g.portal_role is null
             and nullif(btrim(g.meal_group), '') is not null
           group by 1) x), '[]'::jsonb) as meal_groups
from booking.events e
join booking.reservations r on r.id = e.reservation_id
join booking.event_food_state s on s.id = e.id
where e.deleted_at is null and r.deleted_at is null;

revoke all on booking.food_event_projection from public, anon, authenticated;
grant select on booking.food_event_projection to service_role;

-- La de 0481 con `mealGroups`.
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
      'mealGroups', coalesce((select jsonb_agg(jsonb_build_object('group', c.grp, 'guests', c.n) order by c.grp) from (
          select btrim(meal_group) grp, count(*)::int n from booking.guests where event_id = v_event and deleted_at is null and not preview and portal_role is null
             and nullif(btrim(meal_group), '') is not null group by 1) c), '[]'::jsonb),
      'sesStatus', coalesce((select jsonb_object_agg(b.ses_status, b.n) from (
          select ses_status, count(*) n from booking.guests where event_id = v_event and deleted_at is null and not preview and portal_role is null group by 1) b), '{}'::jsonb))
    into v_out
    from booking.guests g where g.event_id = v_event and g.deleted_at is null and not g.preview and g.portal_role is null;
  return v_out;
end $$;


-- BG16 de Guests («Tus ofertas de hoy»): el grupo de la ficha propia. Es la de 0483 con `meal_group`.
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
  return jsonb_build_object('id', v_g.id, 'revision', v_g.revision, 'portal_role', v_g.portal_role, 'meal_group', nullif(btrim(v_g.meal_group), ''), 'fields', v_fields, 'mode', booking.guest_mode(v_res),
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

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
