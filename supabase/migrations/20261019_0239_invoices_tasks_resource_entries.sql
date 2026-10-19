-- Invoices · R4: el cuadre lo pide también Tasks al recibir (orden inverso; RESPUESTAS de Core del 19-10-2026).
-- Toca solo el schema invoices; de resources solo lee.
--
-- Si una factura se valida antes de que Tasks reciba la compra, Finance no se entera de la recepción. Tasks, tras marcar
-- «Recibida» una solicitud, lee `invoices.tasks_resource_entries` y manda el resultado en un lote de Recursos a
-- `resources.reconcile_entries` (como hace la Edge de Finance, 0235), más los `movement_costs` de `costs`.
--
-- args: {request_ids: [uuid de tasks.purchase_requests, hasta 100]}. Devuelve lo mismo que `invoices.resource_entries`
-- (0238), pero solo de las líneas asignadas (`allocations`, `tasks/purchase_request`) a esas solicitudes: Tasks no ve
-- ni cuadra las demás líneas de esas facturas. Con el interruptor apagado, vacío.

create or replace function invoices.tasks_resource_entries(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_requests text[];
  v_lines text[];
  v_invoices jsonb;
  v_all jsonb;
begin
  select coalesce(array_agg(distinct x), '{}') into v_requests
    from (select x from jsonb_array_elements_text(coalesce(p->'args'->'request_ids', '[]'::jsonb)) x
           where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' limit 100) r;
  select coalesce(array_agg(distinct 'invoice_line:' || a.invoice_line_id), '{}'), coalesce(jsonb_agg(distinct a.invoice_id), '[]'::jsonb)
    into v_lines, v_invoices
    from invoices.allocations a
   where a.deleted_at is null and a.target_app = 'tasks' and a.target_kind = 'purchase_request' and a.target_id = any(v_requests);
  v_all := invoices.resource_entries(jsonb_build_object('app', 'invoices', 'args', jsonb_build_object('invoice_ids', v_invoices)));
  return jsonb_build_object(
    'source_app', 'invoices',
    'entries', coalesce((select jsonb_agg(e) from jsonb_array_elements(v_all->'entries') e where e->>'source_ref' = any(v_lines)), '[]'::jsonb),
    'refs', coalesce((select jsonb_agg(r) from jsonb_array_elements_text(v_all->'refs') r where r = any(v_lines)), '[]'::jsonb),
    'skipped', coalesce((select jsonb_agg(s) from jsonb_array_elements(v_all->'skipped') s where 'invoice_line:' || (s->>'line_id') = any(v_lines)), '[]'::jsonb),
    'costs', coalesce((select jsonb_agg(c) from jsonb_array_elements(v_all->'costs') c where c->>'source_ref' = any(v_lines)), '[]'::jsonb));
end $$;

select core.allow_read('tasks', 'invoices.tasks_resource_entries', 'function', '{editor,owner}', false);
revoke all on function invoices.tasks_resource_entries(jsonb) from public, anon, authenticated;
