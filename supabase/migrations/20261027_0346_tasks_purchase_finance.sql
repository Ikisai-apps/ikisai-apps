-- Ikisai Tasks · la compra recibida se registra en Finance (encargo de Core del 27-10-2026, hueco de la cadena de compra de
-- la barra; contrato de Finance en docs/invoices/API.md §18; docs/tasks/API.md §44). Toca solo el schema tasks y, del
-- núcleo, solo usa register_table, register_file_field, allow_read y las tablas que una app puede leer.
-- - En la solicitud: lo que se pagó (`paid_total`, con IVA), si el justificante es ticket o factura (`receipt_kind`,
--   invoice | ticket, como Finance), su número (`invoice_number`) y su foto o PDF (`receipt_file_id`, archivo de Tasks).
-- - El resultado del registro en Finance, que escribe `POST purchases/:id/finance` (tasks-api) con el token de la persona:
--   `finance_status` (pending | registered | needs_access | failed), `finance_invoice_id`, `finance_code`, `finance_error`.
-- - tasks.purchase_finance({id}): la solicitud visible con lo que hace falta para registrarla (lectura de la Edge).
-- - El resultado (`finance_*`) solo lo escribe el servidor, con tasks.purchase_finance_set (que llama la Edge tras invocar la
--   capacidad); la app no puede fijarlo. Y el justificante (`receipt_file_id`) tiene que ser un archivo de Tasks, verificado
--   y subido por quien lo pone: así nadie manda a Finance un archivo ajeno (hook tasks.validate_purchase_finance).

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

-- El resultado del registro, desde la Edge (POST purchases/:id/finance) con la persona: solo `finance_*` de una solicitud que ve.
create or replace function tasks.purchase_finance_set(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  rq tasks.purchase_requests;
  v_id uuid;
  v_fields jsonb;
begin
  -- Solo desde la Edge: los `call` que llegan por `commands` los rechaza su beforeCommit (allowCalls); y solo editor u owner.
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin v_id := (v_args->>'id')::uuid; exception when others then v_id := null; end;
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  select * into rq from tasks.purchase_requests r where r.id = v_id and r.deleted_at is null;
  if rq.id is null or not (case when rq.project_id is null then tasks.scope_full(v_scopes, rq.tab_id) else tasks.scope_project(v_scopes, rq.tab_id, rq.project_id) end) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'purchase_request', 'id', v_id));
  end if;
  if coalesce(v_args->>'status', '') not in ('pending', 'registered', 'needs_access', 'failed') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'status: pending, registered, needs_access or failed'));
  end if;
  v_fields := jsonb_build_object('finance_status', v_args->>'status', 'finance_invoice_id', nullif(v_args->>'invoiceId', ''),
    'finance_code', left(nullif(v_args->>'code', ''), 40), 'finance_error', left(nullif(v_args->>'error', ''), 300));
  perform set_config('tasks.finance_write', rq.id::text, true);
  perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'update', 'table', 'tasks.purchase_requests', 'id', rq.id, 'expectedRevision', rq.revision, 'fields', v_fields));
  return jsonb_build_object('id', rq.id, 'status', v_args->>'status');
end $$;
select core.allow_procedure('tasks', 'tasks.purchase_finance_set');

-- Hook: `finance_*` solo por tasks.purchase_finance_set; `receipt_file_id`, un archivo de Tasks verificado de quien lo pone.
create or replace function tasks.validate_purchase_finance(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_actor uuid := (p->>'actor')::uuid;
  v_write text := coalesce(current_setting('tasks.finance_write', true), '');
  c record;
  v_file uuid;
begin
  for c in select ch.row_id, ch.before, ch.after from core.changes ch
            where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op in ('insert', 'update', 'restore') loop
    if ((c.after->>'finance_status') is distinct from (c.before->>'finance_status') or (c.after->>'finance_invoice_id') is distinct from (c.before->>'finance_invoice_id')
        or (c.after->>'finance_code') is distinct from (c.before->>'finance_code') or (c.after->>'finance_error') is distinct from (c.before->>'finance_error'))
       and v_write <> c.row_id::text then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.purchase_requests', 'id', c.row_id, 'field', 'finance_status', 'reason', 'set only by purchases/:id/finance'));
    end if;
    if (c.after->>'receipt_file_id') is not null and (c.after->>'receipt_file_id') is distinct from (c.before->>'receipt_file_id') then
      begin v_file := (c.after->>'receipt_file_id')::uuid; exception when others then v_file := null; end;
      if not exists (select 1 from core.files f where f.id = v_file and f.app = 'tasks' and f.status = 'verified' and f.created_by = v_actor
                       and f.mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')) then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.purchase_requests', 'id', c.row_id, 'field', 'receipt_file_id', 'reason', 'a verified PDF or image you uploaded'));
      end if;
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_purchase_finance');

revoke all on function tasks.purchase_finance(jsonb) from public, anon, authenticated;
grant execute on function tasks.purchase_finance(jsonb) to service_role;
revoke all on function tasks.purchase_finance_set(jsonb) from public, anon, authenticated;
grant execute on function tasks.purchase_finance_set(jsonb) to service_role;
revoke all on function tasks.validate_purchase_finance(jsonb) from public, anon, authenticated;
grant execute on function tasks.validate_purchase_finance(jsonb) to service_role;
