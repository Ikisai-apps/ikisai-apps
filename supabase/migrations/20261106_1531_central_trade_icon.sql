-- Ikisai Central · icono de cada oficio (VG, 06-11; createTradePicker del kit, propuesta de UI-kit): `central.trades.icon`, una
-- clave del juego del kit (`TRADE_ICONS`: fontaneria, electricidad, pintura…). Solo hace falta en los oficios de arriba; las
-- especialidades heredan el de su madre. Si falta, el kit lo deduce del nombre; una clave que el kit no conozca sale sin icono, así
-- que aquí solo se exige la forma de clave. Se publica en `central.trade_options` (al final). Toca solo central.

alter table central.trades add column if not exists icon text check (icon is null or icon ~ '^[a-z][a-z0-9_]{1,30}$');
select core.register_table('central', 'central', 'trades', array['parent_id','name','position','active','notes','source_label_id','icon']);

create or replace view central.trade_options as
select t.id as trade_id, t.parent_id, t.name, central.trade_path(t.id) as path, t.position, t.source_label_id, t.icon
  from central.trades t
 where t.deleted_at is null and t.active;

revoke all on central.trade_options from public, anon, authenticated;
grant select on central.trade_options to service_role;
