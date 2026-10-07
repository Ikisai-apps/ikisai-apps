-- Ikisai Food · indicador `food.events_without_menu_30d` para el panel de Dirección (docs/food/API.md §7.4; petición P14).
-- Rehace `food.central_kpi_projection` con las mismas columnas y una clave más. Lee los eventos de
-- `booking.food_event_projection` (excepción del lint acordada con Core) con la misma regla de «pide menú» que la app
-- (`needsMenu`): reserva no cancelada ni perdida, `requires_meals` distinto de false y régimen distinto de `no_aplica`.
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
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, k.period_end,
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
      'count', (select d + 30 from today), 'down', 'https://food.ikisai.com/#/eventos')
  ) as k(kpi, label, value, unit, period_end, direction, link);

revoke all on food.central_kpi_projection from public, anon, authenticated;
grant select on food.central_kpi_projection to service_role;
