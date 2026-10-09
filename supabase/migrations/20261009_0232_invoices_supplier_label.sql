-- Invoices · «Mi nombre» del proveedor (9-10-2026, petición del usuario). Toca solo el schema invoices.
--
-- Muchos proveedores facturan con una razón social rara y distinta de la marca por la que se les conoce. `label` es el
-- nombre propio del usuario (hasta 120 caracteres): la app lo enseña donde lo haya. La razón social (`name`) no cambia y
-- es la que va a la gestoría (CSV y manifest) y la que se usa para emparejar.
alter table invoices.suppliers add column label text check (label is null or length(btrim(label)) between 1 and 120);

select core.register_table('invoices', 'invoices', 'suppliers', array['name','tax_id','default_category','default_is_investment','aliases','slug','notes','label']);
