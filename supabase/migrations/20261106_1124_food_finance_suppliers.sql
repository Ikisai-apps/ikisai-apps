-- Food · proveedor de Finance en el ingrediente y en la línea de la compra (C2, FB_2026_086; decisión de VG Q3 d, 06-11).
-- Toca solo el schema food.
--
-- El proveedor habitual del ingrediente se elige de los proveedores de Finance (`invoices.suppliers`). La compra lo propone
-- en cada línea, y en una línea se puede cambiar por otro de la misma lista. Los ids son referencias lógicas, sin clave
-- ajena entre schemas. El nombre se sigue copiando en `preferred_supplier` y `supplier`, que agrupan la compra y hacen de
-- respaldo sin red o sin acceso a Finance; la generación de la lista no cambia (copia el nombre, como hasta ahora).
alter table food.ingredients add column preferred_supplier_id uuid;
alter table food.shopping_list_items add column supplier_id uuid;

select core.register_table('food', 'food', 'ingredients', array['name','preferred_unit','preferred_supplier','active','item_id','purchase_unit','prep_unit','yield',
  'preferred_supplier_id']);
select core.register_table('food', 'food', 'shopping_list_items', array[
  'shopping_list_id','ingredient_id','required_quantity','unit','stock_quantity','purchase_quantity','supplier','status','manual_override','manual','notes',
  'min_quantity','restock','purchase_ref','purchase_project_id','purchase_requested',
  'supplier_id']);
