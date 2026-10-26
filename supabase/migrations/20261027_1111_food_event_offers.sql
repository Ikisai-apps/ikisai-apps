-- Food · ofertas de comida por evento (encargo de VG por Core, 27-10-2026; modelo aprobado por Core; docs/food/API.md
-- §2.12). Toca solo el schema food; lee booking.food_event_projection y resources, y registra lecturas para Booking,
-- Guests y Organizers.
--
-- Un evento tiene N ofertas. Cada una es un menú cerrado o una carta, con:
-- - cuándo: `days` (fechas) × `services` (tipos de servicio); null = todos los días del evento o todos los servicios;
-- - quién: `meal_groups`, etiquetas de grupo de comensales (`booking.guests.meal_group`); vacío = todo su público. Food
--   nunca guarda personas (decisión de Core);
-- - dónde: `place` (texto) y, si se quiere, `space_id` (espacio de Recursos);
-- - quién paga: 'organizador' o 'huesped' (excluyentes) y, si paga el huésped, cuándo se cobra: 'barra' o 'cuenta';
-- - para quién: 'huespedes' o 'interna' (equipo, outsiders, familia). Las internas no las ven ni el organizador ni los
--   huéspedes: no salen por ningún portal ni en la lectura de Booking.
-- El menú de casa es la oferta interna global (sin evento). Lo de hoy se convierte: cada menú de retiro con su evento es
-- una oferta de huéspedes pagada por el organizador; cada carta con evento, de huéspedes pagada en barra.
-- La compra sigue siendo una lista por menú o carta; `food.event_needs` suma por ingrediente todas las ofertas de un
-- evento (decisión de Core).

-- ---------------------------------------------------------------------------
-- 1. Tabla
-- ---------------------------------------------------------------------------
create table food.event_offers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  event_id uuid references booking.events(id) on delete restrict,
  menu_id uuid not null references food.menus(id) on delete restrict,
  name text not null check (length(btrim(name)) between 1 and 120),
  audience text not null default 'huespedes' check (audience in ('huespedes', 'interna')),
  meal_groups text[] not null default '{}' check (cardinality(meal_groups) <= 30),
  days date[] check (days is null or cardinality(days) between 1 and 62),
  services text[] check (services is null or (cardinality(services) between 1 and 6
    and services <@ array['desayuno','comida','cena','picnic','merienda','otro']::text[])),
  place text check (place is null or length(place) <= 200),
  space_id uuid,
  payer text check (payer is null or payer in ('organizador', 'huesped')),
  charge_when text check (charge_when is null or charge_when in ('barra', 'cuenta')),
  position numeric not null default 0,
  notes text check (notes is null or length(notes) <= 1000),
  -- Las de huéspedes llevan quién paga; las internas no. Si paga el huésped, cuándo se cobra; si no, nada.
  constraint event_offers_payer check (
    (audience = 'interna' and payer is null and charge_when is null)
    or (audience = 'huespedes' and payer is not null and ((payer = 'huesped') = (charge_when is not null)))),
  -- Sin evento, solo una interna (el menú de casa).
  constraint event_offers_event check (event_id is not null or audience = 'interna')
);
create index event_offers_event_idx on food.event_offers (event_id, position) where deleted_at is null;
create index event_offers_menu_idx on food.event_offers (menu_id) where deleted_at is null;

-- Oferta: el menú existe y está vivo; si el menú es de un evento, la oferta es de ese evento; el evento no cambia;
-- cada etiqueta de grupo, de 1 a 40 caracteres.
create or replace function food.guard_event_offer()
returns trigger language plpgsql as $$
declare v_menu food.menus;
begin
  if tg_op = 'UPDATE' and new.event_id is distinct from old.event_id then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'event_id'));
  end if;
  if exists (select 1 from unnest(new.meal_groups) g where g is null or length(btrim(g)) not between 1 and 40) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'meal_groups'));
  end if;
  if new.deleted_at is null then
    select * into v_menu from food.menus where id = new.menu_id;
    if v_menu.id is null or v_menu.deleted_at is not null then
      perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'menus', 'id', new.menu_id));
    end if;
    if v_menu.event_id is not null and new.event_id is distinct from v_menu.event_id then
      perform core.fail('OFFER_EVENT_MISMATCH', 422, jsonb_build_object('menu_id', v_menu.id, 'menu_event_id', v_menu.event_id, 'event_id', new.event_id));
    end if;
    if new.space_id is not null and (tg_op = 'INSERT' or new.space_id is distinct from old.space_id)
       and not exists (select 1 from resources.spaces s where s.id = new.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', new.space_id));
    end if;
  end if;
  return new;
end $$;
create trigger food_guard_event_offer before insert or update on food.event_offers
  for each row execute function food.guard_event_offer();

select core.register_table('food', 'food', 'event_offers', array[
  'event_id','menu_id','name','audience','meal_groups','days','services','place','space_id','payer','charge_when','position','notes']);

-- ---------------------------------------------------------------------------
-- 2. Lo de hoy, como ofertas (una sola vez)
-- ---------------------------------------------------------------------------
create or replace function food.backfill_event_offers()
returns int language plpgsql as $$
declare v_ops jsonb;
begin
  select coalesce(jsonb_agg(op order by ord), '[]'::jsonb) into v_ops from (
    select 1 as ord, jsonb_build_object('op', 'insert', 'table', 'food.event_offers', 'id', food.stable_uuid('food-offer:' || m.id),
             'fields', jsonb_strip_nulls(jsonb_build_object('event_id', m.event_id, 'menu_id', m.id,
               'name', case m.kind when 'casa' then 'Menú de casa' when 'carta' then coalesce(m.name, 'Carta') else 'Menú' end,
               'audience', case when m.kind = 'casa' then 'interna' else 'huespedes' end,
               'payer', case m.kind when 'retiro' then 'organizador' when 'carta' then 'huesped' end,
               'charge_when', case when m.kind = 'carta' then 'barra' end,
               'position', case m.kind when 'casa' then 0 when 'retiro' then 1 else 2 end))) as op
      from food.menus m
     where m.deleted_at is null and (m.kind = 'casa' or m.event_id is not null)
       and not exists (select 1 from food.event_offers o where o.menu_id = m.id and o.deleted_at is null)) x;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('food', 'migration:food-1111-offers', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;
revoke all on function food.backfill_event_offers() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from core.memberships where app = 'food') then perform food.backfill_event_offers(); end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Lectura para Booking: las ofertas de huéspedes (nunca las internas), sin personas
-- ---------------------------------------------------------------------------
create or replace view food.event_offers_projection as
select o.id as offer_id, o.event_id, o.name, o.meal_groups, o.days, o.services, o.place, o.payer, o.charge_when,
       case when m.kind = 'carta' then 'carta' else 'cerrado' end as menu_kind, o.menu_id,
       null::integer as price_cents,
       case when m.kind = 'carta' then exists (select 1 from food.carta_lines l where l.menu_id = m.id and l.deleted_at is null and l.active) else true end as active,
       o.position, o.revision as offer_revision
  from food.event_offers o join food.menus m on m.id = o.menu_id and m.deleted_at is null
 where o.deleted_at is null and o.audience = 'huespedes' and o.event_id is not null;
select core.allow_read('booking', 'food.event_offers_projection', 'view', '{reader,editor,owner}');
select core.allow_read('food', 'food.event_offers_projection', 'view', '{reader,editor,owner}');

-- ---------------------------------------------------------------------------
-- 4. Lectura de portal (Organizers y Guests): las ofertas de la reserva, por oferta y por día y servicio
-- ---------------------------------------------------------------------------
-- Solo lo público: nombre, cuándo, para qué grupos, dónde, quién paga; de una carta, sus líneas disponibles con precio y
-- alérgenos declarados; de un menú cerrado, sus platos por día y servicio (si cocina lo ha compartido; en Guests, solo
-- validado o cerrado, como `food.portal_menu`). Nunca costes, cantidades, stock o ventas.
-- Internas (matiz de VG del 27-10): llegan a Guests con `audience = 'interna'`, porque el equipo y los outsiders usan Ven;
-- Guests las filtra por portal_role y grupo y nunca las enseña a huéspedes ni al organizador. A Organizers, nunca.
-- Las ofertas de una reserva que ve un portal, con lo que hace falta para pintarlas por día y servicio.
create or replace function food.portal_offer_rows(p_reservation uuid, p_guests boolean)
returns table (offer_id uuid, event_id uuid, menu_id uuid, kind text, days date[], services text[], start_date date, end_date date,
               visible_dishes boolean, audience text)
language plpgsql stable as $$
begin
  return query
  select o.id, o.event_id, o.menu_id, case when m.kind = 'carta' then 'carta' else 'cerrado' end, o.days, o.services, e.start_date, e.end_date,
         m.kind = 'carta' or (m.organizer_shared and (not p_guests or m.status in ('validado', 'cerrado'))) or o.audience = 'interna',
         o.audience
    from food.event_offers o
    join food.menus m on m.id = o.menu_id and m.deleted_at is null
    join booking.food_event_projection e on e.event_id = o.event_id
   where o.deleted_at is null and e.reservation_id = p_reservation
     and (o.audience = 'huespedes' or (p_guests and o.audience = 'interna'))
     -- En Guests, un menú cerrado de huéspedes solo cuando cocina lo ha validado; la carta, siempre.
     and (m.kind = 'carta' or not p_guests or o.audience = 'interna' or m.status in ('validado', 'cerrado'));
end $$;

create or replace function food.portal_offers(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_res uuid := food.portal_reservation(p); v_guests boolean := p->>'app' = 'guests';
  v_from date; v_to date; v_offers jsonb; v_days jsonb;
begin
  begin
    v_from := nullif(p->'args'->>'from', '')::date;
    v_to := nullif(p->'args'->>'to', '')::date;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'from/to')); end;

  select coalesce(jsonb_agg(jsonb_build_object(
      'offer_id', o.id, 'event_id', o.event_id, 'name', o.name, 'kind', t.kind, 'audience', o.audience, 'meal_groups', to_jsonb(o.meal_groups),
      'days', to_jsonb(o.days), 'services', to_jsonb(o.services), 'place', o.place, 'payer', o.payer, 'charge_when', o.charge_when,
      'provisional', t.kind = 'cerrado' and m.status in ('borrador', 'revisar'),
      'lines', case when t.kind = 'carta' then coalesce((select jsonb_agg(jsonb_build_object(
          'line_id', l.id, 'code', l.code, 'scope', l.scope,
          'name', coalesce(l.name, nullif(btrim(r.public_name), ''), r.name, it.name), 'description', coalesce(l.description, r.public_description),
          'price_cents', l.sale_price_cents, 'allergens', to_jsonb(coalesce(r.allergens, '{}'::text[])),
          'allergens_checked', coalesce(r.allergens_checked, false), 'diet_tags', to_jsonb(coalesce(r.diet_tags, '{}'::text[])))
          order by array_position(array['clasico','gourmet','barra'], l.scope), l.position, l.code)
        from food.carta_lines l left join food.recipes r on r.id = l.recipe_id left join resources.items it on it.id = l.item_id
       where l.menu_id = o.menu_id and l.deleted_at is null and l.active), '[]'::jsonb) end)
    order by o.position, o.created_at), '[]'::jsonb)
    into v_offers
    from food.portal_offer_rows(v_res, v_guests) t join food.event_offers o on o.id = t.offer_id join food.menus m on m.id = t.menu_id;

  -- Por día y servicio: lo incluido de los menús cerrados (sus platos de ese día y servicio) y las cartas de ese día.
  with days as (
    select distinct d::date as date from food.portal_offer_rows(v_res, v_guests) t, generate_series(t.start_date, t.end_date, interval '1 day') d
     where (v_from is null or d::date >= v_from) and (v_to is null or d::date <= v_to)),
  slots as (
    select s.service_date as date, s.service_type as type, min(s.service_time) as time
      from food.portal_offer_rows(v_res, v_guests) t join food.menu_services s on s.menu_id = t.menu_id and s.deleted_at is null
     where t.kind = 'cerrado' and (t.days is null or s.service_date = any(t.days)) and (t.services is null or s.service_type = any(t.services))
       and s.service_date in (select date from days)
     group by 1, 2)
  select coalesce(jsonb_agg(jsonb_build_object('date', d.date,
      'services', coalesce((select jsonb_agg(jsonb_build_object('type', sl.type, 'time', sl.time,
          'included', coalesce((select jsonb_agg(jsonb_build_object('offer_id', t.offer_id,
              'options', case when not t.visible_dishes then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object(
                  'name', coalesce(nullif(btrim(r.public_name), ''), r.name), 'description', r.public_description,
                  'diet_tags', to_jsonb(r.diet_tags), 'allergens', to_jsonb(r.allergens), 'allergens_checked', r.allergens_checked)
                  order by s.position, i.position, i.created_at)
                from food.menu_services s join food.menu_items i on i.service_id = s.id and i.deleted_at is null join food.recipes r on r.id = i.recipe_id
               where s.menu_id = t.menu_id and s.deleted_at is null and s.service_date = sl.date and s.service_type = sl.type), '[]'::jsonb) end))
            from food.portal_offer_rows(v_res, v_guests) t
           where t.kind = 'cerrado' and (t.days is null or sl.date = any(t.days)) and (t.services is null or sl.type = any(t.services))
             and exists (select 1 from food.menu_services s where s.menu_id = t.menu_id and s.deleted_at is null and s.service_date = sl.date and s.service_type = sl.type)), '[]'::jsonb))
          order by sl.time nulls last, array_position(array['desayuno','comida','merienda','picnic','cena','otro'], sl.type))
        from slots sl where sl.date = d.date), '[]'::jsonb),
      'cartas', coalesce((select jsonb_agg(t.offer_id) from food.portal_offer_rows(v_res, v_guests) t
         where t.kind = 'carta' and d.date between t.start_date and t.end_date and (t.days is null or d.date = any(t.days))), '[]'::jsonb))
    order by d.date), '[]'::jsonb)
    into v_days
    from days d
   where exists (select 1 from slots sl where sl.date = d.date)
      or exists (select 1 from food.portal_offer_rows(v_res, v_guests) t where t.kind = 'carta' and d.date between t.start_date and t.end_date and (t.days is null or d.date = any(t.days)));

  return jsonb_build_object('reservation_id', v_res, 'offers', v_offers, 'days', v_days);
end $$;
select core.allow_read('organizers', 'food.portal_offers', 'function', '{editor,owner}');
select core.allow_read('guests', 'food.portal_offers', 'function', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- 5. Lo que pide un evento: la suma por ingrediente de todas sus ofertas (decisión de Core: las listas siguen por menú)
-- ---------------------------------------------------------------------------
-- Menús cerrados: raciones × cantidad ÷ raciones base (como la lista de la compra). Cartas: unidades a cubrir × lo que
-- gasta cada una (como su lista). En la base de cada familia y con la unidad de salida del ingrediente.
create or replace function food.event_needs(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_event uuid; v_out jsonb;
begin
  begin v_event := (p->'args'->>'event_id')::uuid; exception when others then v_event := null; end;
  if v_event is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('argument', 'event_id')); end if;
  with offers as (
    select distinct o.menu_id, m.kind from food.event_offers o join food.menus m on m.id = o.menu_id and m.deleted_at is null
     where o.event_id = v_event and o.deleted_at is null),
  lines as (
    select ri.ingredient_id, food.unit_family(ri.unit) as family, ri.quantity * food.unit_factor(ri.unit) * mi.servings / rc.base_servings as base_total, o.menu_id
      from offers o
      join food.menu_services s on s.menu_id = o.menu_id and s.deleted_at is null
      join food.menu_items mi on mi.service_id = s.id and mi.deleted_at is null
      join food.recipes rc on rc.id = mi.recipe_id
      join food.recipe_ingredients ri on ri.recipe_id = rc.id and ri.deleted_at is null
     where o.kind <> 'carta'
    union all
    select c.ingredient_id, c.family, c.base_total, o.menu_id
      from offers o cross join lateral food.carta_shopping_lines(o.menu_id) c
     where o.kind = 'carta'),
  sums as (
    select l.ingredient_id, l.family, sum(l.base_total) as base_total, count(distinct l.menu_id) as menus
      from lines l group by 1, 2)
  select coalesce(jsonb_agg(jsonb_build_object(
      'ingredient_id', s.ingredient_id, 'name', g.name, 'item_id', g.item_id,
      'quantity', round(s.base_total / food.unit_factor(food.output_unit(s.family, s.base_total, g.preferred_unit)), 3),
      'unit', food.output_unit(s.family, s.base_total, g.preferred_unit), 'menus', s.menus)
      order by g.name), '[]'::jsonb)
    into v_out
    from sums s join food.ingredients g on g.id = s.ingredient_id;
  return jsonb_build_object('event_id', v_event,
    'offers', (select count(*) from food.event_offers o where o.event_id = v_event and o.deleted_at is null), 'items', v_out);
end $$;
select core.allow_read('food', 'food.event_needs', 'function', '{reader,editor,owner}');
