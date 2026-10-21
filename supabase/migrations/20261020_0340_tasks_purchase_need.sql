-- Ikisai Tasks · Compras R6 «Estantería» (MUELA-094, tanda 40; docs/tasks/API.md §18.10). Toca solo el schema tasks.
-- - tasks.purchase_requests gana `need_quantity`: lo que hacía falta, en la unidad base del artículo, aparte de lo que se
--   pide o se compra (`quantity` y `unit`). Al recibir entra el envase entero (lo calcula el dominio, `receiptPlan`) y lo
--   que sobra va al almacén; `need_quantity` solo dice cuánto hacía falta («hace falta 19 l · 1 l al almacén»).
-- tasks.validate_batch no cambia (la comprobación es la del campo).

alter table tasks.purchase_requests add column need_quantity numeric check (need_quantity is null or need_quantity >= 0);
select core.register_table('tasks', 'tasks', 'purchase_requests', array['tab_id','project_id','task_id','item_id','plan_stop_id','title','note','quantity','unit','need_quantity','estimated_amount','priority','status','needs_invoice','repeat_days','due','supplier_id','supplier_name','position']);
