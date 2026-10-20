-- Ikisai Recursos · el envase habitual y su precio (MUELA-093, Food Compra; MUELA-094, Tasks Compras R6).
-- - `usual`: el envase que se propone al comprar, con varios. Uno como mucho por artículo, entre los vivos. Al guardar uno
--   nuevo como habitual (decisión de VG: el último guardado lo es), el cliente quita la marca del anterior en el mismo
--   commit; el hook lo comprueba al final del commit, así el orden de las operaciones no importa.
-- - `price`: lo que cuesta ese envase (euros, con IVA, como el coste del menú). Lo llenan la hoja del envase o Invoices al
--   asignar una línea de factura a ese envase. Sin precio, las apps usan el coste medio del artículo.
-- Toca solo el schema resources.

alter table resources.item_units add column usual boolean not null default false;
alter table resources.item_units add column price numeric check (price is null or (price >= 0 and price <= 1000000));
select core.register_table('resources', 'resources', 'item_units', array['item_id', 'unit', 'factor', 'supplier_id', 'usual', 'price']);

create or replace function resources.check_item_units(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_item uuid;
begin
  for v_item in
    select distinct (coalesce(c.after, c.before)->>'item_id')::uuid from core.changes c
     where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'item_units' loop
    if (select count(*) from resources.item_units u where u.item_id = v_item and u.usual and u.deleted_at is null) > 1 then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'resources.item_units', 'field', 'usual',
        'item_id', v_item, 'reason', 'one usual format per item'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_item_units');

revoke all on function resources.check_item_units(jsonb) from public, anon, authenticated;
grant execute on function resources.check_item_units(jsonb) to service_role;
