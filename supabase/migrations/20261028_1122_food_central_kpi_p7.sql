-- Ikisai Food · P7 de Central (encargo de Core del 27-10-2026): tres claves más en `food.central_kpi_projection`
-- (docs/central/API.md §7.2; docs/food/API.md §7.4): ventas de la carta de ayer, platos sin alérgenos revisados en los
-- próximos 30 días (en lugar de «ingredientes sin precio», que necesitaría leer Invoices) y avisos de equipos abiertos.
-- Rehace la vista con las mismas columnas; las claves de antes no cambian.
create or replace view food.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
menus as (
  select m.id, m.event_id, m.status,
         nullif(m.source_event_snapshot ->> 'start_date', '')::date as start_date,
         nullif(m.source_event_snapshot ->> 'end_date', '')::date as end_date
    from food.menus m
   where m.deleted_at is null),
events as (
  select e.event_id, e.start_date
    from booking.food_event_projection e
   where coalesce(e.reservation_status, '') not in ('cancelada', 'perdida')
     and e.requires_meals is distinct from false
     and e.meal_plan is distinct from 'no_aplica')
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period,
       case when k.kpi = 'food.carta_sales_yesterday' then (select d - 1 from today) else (select d from today) end as period_start, k.period_end,
       k.direction, k.link, now() as computed_at
  from (values
    -- Menús sin validar (borrador o por revisar) de eventos que empiezan en los próximos 30 días (hoy incluido).
    ('food.menus_unvalidated_30d', 'Menús sin validar en los próximos 30 días',
      (select count(*) from menus m, today
        where m.status in ('borrador', 'revisar') and m.start_date between today.d and today.d + 30)::numeric,
      'count', (select d + 30 from today), 'down', 'https://food.ikisai.com/#/menus'),
    -- Listas de la compra sin cerrar de menús vivos y no cerrados cuyo evento no ha terminado.
    ('food.shopping_lists_open', 'Listas de la compra abiertas',
      (select count(*) from food.shopping_lists l
         join menus m on m.id = l.menu_id and m.status <> 'cerrado', today
        where l.deleted_at is null and l.status <> 'cerrada' and m.end_date >= today.d)::numeric,
      'count', (select d from today), 'down', 'https://food.ikisai.com/#/menus'),
    -- Eventos que piden menú, empiezan en los próximos 30 días (hoy incluido) y aún no tienen menú vivo.
    ('food.events_without_menu_30d', 'Eventos sin menú en los próximos 30 días',
      (select count(*) from events e, today
        where e.start_date between today.d and today.d + 30
          and not exists (select 1 from menus m where m.event_id = e.event_id))::numeric,
      'count', (select d + 30 from today), 'down', 'https://food.ikisai.com/#/eventos'),
    -- P7 · Lo vendido ayer en las cartas: unidades por el precio de venta actual de cada línea (las ventas no guardan el
    -- precio del día; si cambió, cuenta el de ahora). Periodo `actual`, con inicio y fin en ayer. Solo owner y editor de
    -- Central ven los importes (§7.2).
    ('food.carta_sales_yesterday', 'Ventas de la carta de ayer',
      (select coalesce(sum(s.quantity * l.sale_price_cents), 0) / 100.0 from food.carta_sales s
         join food.carta_lines l on l.id = s.line_id, today
        where s.deleted_at is null and s.day = today.d - 1)::numeric,
      'eur', (select d - 1 from today), 'up', 'https://food.ikisai.com/#/menus'),
    -- P7 · Platos de los menús de retiro de los próximos 30 días (hoy incluido; como todos los indicadores, sin casa) cuya receta no tiene los alérgenos
    -- revisados. Sustituye a «Ingredientes sin precio»: el precio sale de las compras de Invoices, que Food no lee en SQL.
    ('food.recipes_allergens_unchecked_30d', 'Platos sin alérgenos revisados (próximos 30 días)',
      (select count(distinct r.id) from food.menu_items i
         join food.menu_services s on s.id = i.service_id and s.deleted_at is null
         join food.menus m on m.id = s.menu_id and m.deleted_at is null and m.status <> 'cerrado' and coalesce(m.kind, 'retiro') = 'retiro'
         join food.recipes r on r.id = i.recipe_id and r.deleted_at is null, today
        where i.deleted_at is null and not r.allergens_checked and s.service_date between today.d and today.d + 30)::numeric,
      'count', (select d + 30 from today), 'down', 'https://food.ikisai.com/#/recetario'),
    -- P7 · Avisos de averías enviados a Tasks que siguen abiertos (la petición no está hecha, descartada ni borrada).
    ('food.equipment_notices_open', 'Avisos de equipos abiertos',
      (select count(*) from food.equipment_notices n
         join food.equipment e on e.id = n.equipment_id and e.deleted_at is null
        where n.deleted_at is null and (n.request_status is null or n.request_status in ('pending', 'open')))::numeric,
      'count', (select d from today), 'down', 'https://food.ikisai.com/#/maquinaria')
  ) as k(kpi, label, value, unit, period_end, direction, link);

revoke all on food.central_kpi_projection from public, anon, authenticated;
grant select on food.central_kpi_projection to service_role;
