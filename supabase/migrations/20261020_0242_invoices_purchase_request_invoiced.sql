-- Invoices · ¿la compra de Tasks ya tiene factura? (pedido de VG, 20-10-2026). Toca solo el schema invoices.
-- Comprobación para el hook de otra app, como `central.person_alive` (1508): solo lee y devuelve un booleano.
--   invoices.purchase_request_invoiced(id): hay una asignación viva `tasks` / `purchase_request` a ese id en una factura
--   no borrada ni anulada (también si aún no está validada).
-- Tasks la usa en su `validate_batch` para no dejar deshacer una compra que ya está ligada a una factura.
create or replace function invoices.purchase_request_invoiced(p_id text)
returns boolean language sql stable as $$
  select exists (
    select 1 from invoices.allocations a
      join invoices.invoices i on i.id = a.invoice_id
     where a.target_app = 'tasks' and a.target_kind = 'purchase_request' and a.target_id = p_id
       and a.deleted_at is null and i.deleted_at is null and i.status <> 'anulada')
$$;
