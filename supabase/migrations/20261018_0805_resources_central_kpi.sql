-- Ikisai Recursos · indicadores para el panel de Dirección de Central (R7; tabla aprobada por el usuario el 18-10-2026,
-- coordinacion/central/SALIDA.md; contrato en docs/central/API.md §7.2). Toca solo el schema resources. Solo agregados.
-- `period = 'actual'`: la foto de hoy (hora de Madrid). Sin enlace hasta que haya pantalla de inventario.
create view resources.central_kpi_projection as
with today as (select (now() at time zone 'Europe/Madrid')::date as d),
live_spaces as (
  -- Espacios activos que no cuelgan de nada archivado ni borrado.
  with recursive t as (
    select s.id, s.kind, s.attributes, s.code from resources.spaces s where s.parent_id is null and s.deleted_at is null and s.active
    union all
    select s.id, s.kind, s.attributes, s.code from resources.spaces s join t on s.parent_id = t.id where s.deleted_at is null and s.active)
  select * from t),
stock as (select item_id, sum(quantity) as qty from resources.stock_levels group by item_id),
items as (select i.*, coalesce(s.qty, 0) as qty from resources.items i left join stock s on s.item_id = i.id where i.deleted_at is null and i.active),
lot_stock as (select lot_id, sum(quantity) as qty from resources.stock_levels where lot_id is not null group by lot_id)
select k.kpi, k.label, k.value, k.unit, 'actual'::text as period, (select d from today) as period_start, (select d from today) as period_end,
       k.direction, null::text as link, now() as computed_at
  from (values
    ('resources.spaces_active', 'Espacios activos',
      (select count(*) from live_spaces where kind not in ('altura', 'cama', 'ubicacion'))::numeric, 'count', 'up'),
    ('resources.bed_places', 'Plazas fijas en camas',
      (select coalesce(sum(case when (attributes ? 'capacity') then (attributes->>'capacity')::numeric else 1 end), 0) from live_spaces where kind = 'cama'), 'count', 'up'),
    ('resources.bed_extra_places', 'Plazas supletorias',
      (select coalesce(sum((attributes->>'extra_capacity')::numeric), 0) from live_spaces where kind = 'cama'), 'count', 'up'),
    ('resources.bookable_rooms_without_beds', 'Habitaciones reservables sin camas',
      (select count(*) from live_spaces r where r.kind = 'habitacion' and (r.attributes->>'bookable') = 'true'
         and not exists (select 1 from resources.spaces b where b.parent_id = r.id and b.kind = 'cama' and b.deleted_at is null and b.active))::numeric, 'count', 'down'),
    ('resources.spaces_without_code', 'Espacios sin código',
      (select count(*) from live_spaces where kind not in ('altura', 'cama', 'ubicacion') and code is null)::numeric, 'count', 'down'),
    ('resources.stock_value', 'Valor del inventario (coste medio)',
      (select coalesce(round(sum(i.qty * c.average_cost), 2), 0) from items i join resources.item_costs c on c.item_id = i.id where i.qty > 0), 'eur', 'up'),
    ('resources.items_below_min', 'Artículos bajo mínimo',
      (select count(*) from items where min_quantity is not null and qty < min_quantity)::numeric, 'count', 'down'),
    ('resources.lots_expiring_30d', 'Lotes que caducan en 30 días',
      (select count(*) from resources.lots l join lot_stock s on s.lot_id = l.id, today
        where l.deleted_at is null and s.qty > 0 and l.expires_on between today.d and today.d + 30)::numeric, 'count', 'down'),
    ('resources.lots_expired', 'Lotes caducados con existencias',
      (select count(*) from resources.lots l join lot_stock s on s.lot_id = l.id, today
        where l.deleted_at is null and s.qty > 0 and l.expires_on < today.d)::numeric, 'count', 'down'),
    ('resources.items_stock_without_cost', 'Artículos con existencias y sin coste',
      (select count(*) from items i where i.qty > 0 and not exists (select 1 from resources.item_costs c where c.item_id = i.id))::numeric, 'count', 'down'),
    ('resources.items_negative_stock', 'Artículos con existencias negativas',
      (select count(*) from items where qty < 0)::numeric, 'count', 'down'),
    ('resources.machines_down', 'Máquinas y herramientas averiadas o fuera de servicio',
      (select count(*) from items where kind in ('maquina', 'herramienta') and attributes->>'status' in ('averiado', 'fuera_de_servicio'))::numeric, 'count', 'down')
  ) as k(kpi, label, value, unit, direction);

revoke all on resources.central_kpi_projection from public, anon, authenticated;
grant select on resources.central_kpi_projection to service_role;
select core.allow_read('central', 'resources.central_kpi_projection', 'view');
