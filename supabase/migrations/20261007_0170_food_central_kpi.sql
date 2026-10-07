-- Ikisai Food · indicadores para el panel de Dirección de Central (docs/central/API.md §7.2; claves y fórmulas en
-- docs/food/API.md §7.4). Toca solo el schema food. Solo agregados: ningún título, nombre ni importe.
-- `period = 'actual'`: la foto de hoy (hora de Madrid). Las fechas del evento son las de `source_event_snapshot`, lo que
-- la cocina tenía delante al crear, revisar o validar el menú (una migración de Food no lee los schemas de otras apps).
create view food.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
menus as (
  select m.id, m.status,
         nullif(m.source_event_snapshot ->> 'start_date', '')::date as start_date,
         nullif(m.source_event_snapshot ->> 'end_date', '')::date as end_date
    from food.menus m
   where m.deleted_at is null)
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
      'count', (select d from today), 'down', 'https://food.ikisai.com/#/menus')
  ) as k(kpi, label, value, unit, period_end, direction, link);

revoke all on food.central_kpi_projection from public, anon, authenticated;
grant select on food.central_kpi_projection to service_role;
select core.allow_read('central', 'food.central_kpi_projection', 'view');
