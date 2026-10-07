-- Ikisai Food · indicadores para el panel de Dirección de Central (docs/central/API.md §7.2; claves y fórmulas en
-- docs/food/API.md §7.4). Toca solo el schema food. Solo agregados: ningún título, nombre ni importe.
-- `period = 'actual'`: la foto de hoy (hora de Madrid). Los eventos se leen de `booking.food_event_projection`, la misma
-- proyección que usa la app, con la misma regla de «pide menú» que `needsMenu` (apps/food/src/app/events.ts).
create view food.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
events as (
  select e.event_id, e.start_date, e.end_date,
         coalesce(e.reservation_status, '') not in ('cancelada', 'perdida')
           and e.requires_meals is distinct from false
           and e.meal_plan is distinct from 'no_aplica' as needs_menu
    from booking.food_event_projection e),
live_menus as (select m.id, m.event_id, m.status from food.menus m where m.deleted_at is null)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, k.period_end,
       k.direction, k.link, now() as computed_at
  from (values
    -- Eventos que empiezan en los próximos 30 días (hoy incluido), piden menú y aún no lo tienen.
    ('food.events_without_menu_30d', 'Eventos sin menú en los próximos 30 días',
      (select count(*) from events e, today
        where e.needs_menu and e.start_date between today.d and today.d + 30
          and not exists (select 1 from live_menus m where m.event_id = e.event_id))::numeric,
      'count', (select d + 30 from today), 'down', 'https://food.ikisai.com/#/eventos'),
    -- Listas de la compra sin cerrar de eventos que no han terminado, con su menú vivo y sin cerrar.
    ('food.shopping_lists_open', 'Listas de la compra abiertas',
      (select count(*) from food.shopping_lists l
         join live_menus m on m.id = l.menu_id and m.status <> 'cerrado'
         join events e on e.event_id = m.event_id, today
        where l.deleted_at is null and l.status <> 'cerrada' and e.end_date >= today.d)::numeric,
      'count', (select d from today), 'down', 'https://food.ikisai.com/#/menus')
  ) as k(kpi, label, value, unit, period_end, direction, link);

revoke all on food.central_kpi_projection from public, anon, authenticated;
grant select on food.central_kpi_projection to service_role;
select core.allow_read('central', 'food.central_kpi_projection', 'view');
