-- Ikisai Tasks · la compra recibida se registra en Finance (encargo de Core del 27-10-2026, hueco de la cadena de compra de
-- la barra; contrato de Finance en docs/invoices/API.md §18; docs/tasks/API.md §44). Toca solo el schema tasks y, del
-- núcleo, solo usa register_table, register_file_field, allow_read y las tablas que una app puede leer.
-- - En la solicitud: lo que se pagó (`paid_total`, con IVA), si el justificante es ticket o factura (`receipt_kind`,
--   invoice | ticket, como Finance), su número (`invoice_number`) y su foto o PDF (`receipt_file_id`, archivo de Tasks).
-- - El resultado del registro en Finance, que escribe `POST purchases/:id/finance` (tasks-api) con el token de la persona:
--   `finance_status` (pending | registered | needs_access | failed), `finance_invoice_id`, `finance_code`, `finance_error`.
-- - tasks.purchase_finance({id}): la solicitud visible con lo que hace falta para registrarla (lectura de la Edge).

alter table tasks.purchase_requests
  add column if not exists paid_total numeric(12,2) check (paid_total is null or paid_total > 0),
  add column if not exists receipt_kind text check (receipt_kind is null or receipt_kind in ('invoice', 'ticket')),
  add column if not exists invoice_number text check (invoice_number is null or length(btrim(invoice_number)) between 1 and 64),
  add column if not exists receipt_file_id uuid,
  add column if not exists finance_status text check (finance_status is null or finance_status in ('pending', 'registered', 'needs_access', 'failed')),
  add column if not exists finance_invoice_id uuid,
  add column if not exists finance_code text check (finance_code is null or length(finance_code) <= 40),
  add column if not exists finance_error text check (finance_error is null or length(finance_error) <= 300);

select core.register_table('tasks', 'tasks', 'purchase_requests', array['tab_id','project_id','task_id','item_id','plan_stop_id','title','note','quantity','unit','need_quantity','estimated_amount','priority','status','needs_invoice','repeat_days','due','supplier_id','supplier_name','position','source_app','source_ref','source_url','paid_total','receipt_kind','invoice_number','receipt_file_id','finance_status','finance_invoice_id','finance_code','finance_error']);
select core.register_file_field('tasks', 'tasks', 'purchase_requests', 'receipt_file_id', 'operational');

create or replace function tasks.purchase_finance(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_scopes jsonb;
  v_id uuid;
  rq tasks.purchase_requests;
  v_project text;
begin
  begin v_id := (p->'args'->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id required')); end if;
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  select * into rq from tasks.purchase_requests r where r.id = v_id and r.deleted_at is null;
  if rq.id is null or not (case when rq.project_id is null then tasks.scope_full(v_scopes, rq.tab_id) else tasks.scope_project(v_scopes, rq.tab_id, rq.project_id) end) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'purchase_request', 'id', v_id));
  end if;
  select pr.title into v_project from tasks.projects pr where pr.id = rq.project_id;
  return jsonb_build_object('id', rq.id, 'revision', rq.revision, 'title', rq.title, 'status', rq.status, 'project', v_project,
    'supplierName', rq.supplier_name, 'receivedAt', rq.received_at, 'paidTotal', rq.paid_total, 'receiptKind', rq.receipt_kind,
    'invoiceNumber', rq.invoice_number, 'receiptFileId', rq.receipt_file_id, 'sourceApp', rq.source_app, 'sourceUrl', rq.source_url,
    'financeStatus', rq.finance_status, 'financeInvoiceId', rq.finance_invoice_id, 'financeCode', rq.finance_code);
end $$;
select core.allow_read('tasks', 'tasks.purchase_finance', 'function');

revoke all on function tasks.purchase_finance(jsonb) from public, anon, authenticated;
grant execute on function tasks.purchase_finance(jsonb) to service_role;
