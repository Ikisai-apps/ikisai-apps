-- Ikisai Recursos · las camas, sin forma en el plano (camas con un solo modelo: VG por Core y Central, 27-10-2026; la
-- asigna Core a Guests, paso 4). La posición de cada cama vive solo en Booking (`spaces.layout` y `beds.cell`,
-- `booking.bed_layout_projection`, #1017), y su forma en el dibujo se deriva de la de su habitación (`bedShape` del kit).
-- Guests, Central y Booking ya la pintan así, así que en Recursos se anula:
-- - las camas (`kind = 'cama'`) pierden `plan_id` y `plan_shape`. La cama sigue existiendo, con su habitación (`parent_id`),
--   su tipo (`attributes.bed_kind`) y su pareja de Booking (`source_refs`);
-- - colocar una cama en el plano, al crearla o después, se rechaza (`INVALID_FIELDS`, `reason: 'beds are placed in Booking'`).
-- La limpieza va con core.apply_migration_operations (lote propio con cursor y core.changes), así que llega a los
-- dispositivos; las camas ya borradas se limpian sin lote. Toca solo el schema resources.

do $$
declare v_ops jsonb; v_n integer := 0;
begin
  loop
    select coalesce(jsonb_agg(jsonb_build_object('op', 'update', 'table', 'resources.spaces', 'id', s.id, 'expectedRevision', s.revision,
             'fields', jsonb_build_object('plan_id', null, 'plan_shape', null))), '[]'::jsonb)
      into v_ops
      from (select id, revision from resources.spaces
             where kind = 'cama' and deleted_at is null and (plan_id is not null or plan_shape is not null) order by id limit 500) s;
    exit when jsonb_array_length(v_ops) = 0;
    v_n := v_n + 1;
    perform core.apply_migration_operations('resources', 'migration:resources-0818-beds-' || v_n, v_ops);
  end loop;
end $$;
update resources.spaces set plan_id = null, plan_shape = null
 where kind = 'cama' and deleted_at is not null and (plan_id is not null or plan_shape is not null);

create or replace function resources.check_bed_shapes(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
begin
  if exists (select 1 from core.changes c
              where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'spaces'
                and c.op in ('insert', 'update') and c.after->>'kind' = 'cama'
                and (c.after->>'plan_id' is not null or coalesce(c.after->'plan_shape', 'null'::jsonb) <> 'null'::jsonb)) then
    perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.spaces', 'field', 'plan_shape', 'reason', 'beds are placed in Booking'));
  end if;
end $$;
select core.add_validate_hook('resources', 'resources.check_bed_shapes');

revoke all on function resources.check_bed_shapes(jsonb) from public, anon, authenticated;
grant execute on function resources.check_bed_shapes(jsonb) to service_role;
