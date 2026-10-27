-- Ikisai Tasks · procedencia de las compras pedidas desde otra app («Compras del evento», encargo de VG por Core; API.md §39.5).
-- Toca solo el schema tasks.
-- - tasks.purchase_requests: `source_app` (la app que pidió, p. ej. `flow`), `source_ref` (su referencia, la unidad de Flow) y
--   `source_url` (el enlace de vuelta, https en ikisai.com). Las rellena `requests/purchase`; van juntas (app y referencia),
--   son inmutables (`tasks.guard_immutable`) y la pareja es única entre las vivas.
-- - Sin cambios en tasks.validate_batch: las columnas son de procedencia, no de reglas.

alter table tasks.purchase_requests
  add column source_app text check (source_app is null or source_app ~ '^[a-z][a-z0-9_-]{1,30}$'),
  add column source_ref text check (source_ref is null or (length(btrim(source_ref)) between 1 and 150)),
  add column source_url text check (source_url is null or (length(source_url) <= 500 and source_url ~ '^https://([a-z0-9-]+\.)*ikisai\.com(/|$)')),
  add constraint purchase_requests_source_pair check ((source_app is null) = (source_ref is null) and (source_url is null or source_app is not null));

create unique index purchase_requests_source_idx on tasks.purchase_requests (source_app, source_ref)
  where deleted_at is null and source_app is not null;

-- El área, como hasta ahora, y además la procedencia: no cambian después del alta.
drop trigger tasks_guard_immutable on tasks.purchase_requests;
create trigger tasks_guard_immutable before update on tasks.purchase_requests
  for each row execute function tasks.guard_immutable('tab_id', 'source_app', 'source_ref', 'source_url');

select core.register_table('tasks', 'tasks', 'purchase_requests', array['tab_id','project_id','task_id','item_id','plan_stop_id','title','note','quantity','unit','need_quantity','estimated_amount','priority','status','needs_invoice','repeat_days','due','supplier_id','supplier_name','position','source_app','source_ref','source_url']);
