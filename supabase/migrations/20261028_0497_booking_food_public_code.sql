-- Ikisai Booking · `public_code` en `booking.food_event_projection` (petición FO1 de Food, #853): el código público del
-- evento (el del QR de visitantes, 0488), para que Food busque las ofertas de visitante por ese código. Es el mismo que
-- ya va en el cartel y en el QR; no es un dato personal. La vista es la de la 0485 con una columna más al final.
-- Toca solo el schema booking.

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
           group by 1) x), '[]'::jsonb) as meal_groups,
  e.public_code
from booking.events e
join booking.reservations r on r.id = e.reservation_id
join booking.event_food_state s on s.id = e.id
where e.deleted_at is null and r.deleted_at is null;

revoke all on booking.food_event_projection from public, anon, authenticated;
grant select on booking.food_event_projection to service_role;
