-- Ikisai Tasks · compras no alimentarias, lecturas (docs/tasks/API.md §18.5 y §18.6). Toca solo el schema tasks.
-- tasks.targets (copiada entera de 0301) admite kind = 'purchase_request': por id, y sin id en modo lista para el
-- buscador «Asignar a…» de Invoices. tasks.low_stock: suministros bajo mínimo (stock = suma de los movimientos vivos)
-- con su solicitud abierta, si la hay; la usan Inicio y los agentes.

create or replace function tasks.targets(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_kind text := v_args->>'kind';
  v_id uuid;
  v_tab uuid;
  v_archived boolean := coalesce((v_args->>'includeArchived')::boolean, false);
  v_deleted boolean := coalesce((v_args->>'includeDeleted')::boolean, false);
  v_out jsonb;
  v_limit int;
  v_q text;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;

  -- Solicitudes de compra como destino de Invoices (§18.6). Sin id, modo lista para su buscador «Asignar a…»: las
  -- visibles aprobadas, compradas o recibidas que esperan factura, las más recientes primero.
  if v_kind = 'purchase_request' and coalesce(v_args->>'id', '') = '' then
    if v_args->>'tabId' is not null then
      begin v_tab := (v_args->>'tabId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid tabId')); end;
    end if;
    v_limit := least(greatest(coalesce(nullif(v_args->>'limit', '')::int, 50), 1), 200);
    v_q := nullif(btrim(coalesce(v_args->>'q', '')), '');
    select coalesce(jsonb_agg(x.item order by x.updated_at desc), '[]'::jsonb) into v_out from (
      select rq.updated_at, jsonb_build_object('kind', 'purchase_request', 'id', rq.id, 'tabId', rq.tab_id, 'projectId', rq.project_id, 'taskId', rq.task_id,
               'title', rq.title, 'status', rq.status, 'quantity', rq.quantity, 'unit', rq.unit, 'estimatedAmount', rq.estimated_amount,
               'needsInvoice', rq.needs_invoice, 'supplierId', rq.supplier_id, 'supplierName', rq.supplier_name, 'revision', rq.revision, 'deleted', false) item
      from tasks.purchase_requests rq
      where rq.deleted_at is null and rq.needs_invoice and rq.status in ('approved', 'purchased', 'received')
        and (case when rq.project_id is null then tasks.scope_full(v_scopes, rq.tab_id) else tasks.scope_project(v_scopes, rq.tab_id, rq.project_id) end)
        and (v_tab is null or rq.tab_id = v_tab) and (v_q is null or rq.title ilike '%' || v_q || '%')
      order by rq.updated_at desc limit v_limit
    ) x;
    return jsonb_build_object('items', v_out);
  end if;

  if v_kind is not null then
    begin v_id := (v_args->>'id')::uuid; exception when others then v_id := null; end;
    if v_id is null or v_kind not in ('tab', 'project', 'task', 'purchase_request') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'kind and id required')); end if;
    if v_kind = 'tab' then
      select jsonb_build_object('kind', 'tab', 'id', t.id, 'tabId', t.id, 'projectId', null, 'title', t.name, 'revision', t.revision, 'deleted', t.deleted_at is not null, 'archived', false)
        into v_out from tasks.tabs t where t.id = v_id and tasks.scope_some(v_scopes, t.id);
    elsif v_kind = 'project' then
      select jsonb_build_object('kind', 'project', 'id', pr.id, 'tabId', pr.tab_id, 'projectId', pr.id, 'title', pr.title, 'revision', pr.revision, 'deleted', pr.deleted_at is not null, 'archived', pr.status = 'archived')
        into v_out from tasks.projects pr where pr.id = v_id and tasks.scope_project(v_scopes, pr.tab_id, pr.id);
    elsif v_kind = 'purchase_request' then
      select jsonb_build_object('kind', 'purchase_request', 'id', rq.id, 'tabId', rq.tab_id, 'projectId', rq.project_id, 'taskId', rq.task_id,
               'title', rq.title, 'status', rq.status, 'quantity', rq.quantity, 'unit', rq.unit, 'estimatedAmount', rq.estimated_amount,
               'needsInvoice', rq.needs_invoice, 'supplierId', rq.supplier_id, 'supplierName', rq.supplier_name,
               'revision', rq.revision, 'deleted', rq.deleted_at is not null, 'archived', false)
        into v_out from tasks.purchase_requests rq
        where rq.id = v_id and (case when rq.project_id is null then tasks.scope_full(v_scopes, rq.tab_id) else tasks.scope_project(v_scopes, rq.tab_id, rq.project_id) end);
    else
      select jsonb_build_object('kind', 'task', 'id', t.id, 'tabId', t.tab_id, 'projectId', t.project_id, 'title', t.title, 'revision', t.revision, 'deleted', t.deleted_at is not null, 'archived', pr.status = 'archived', 'done', tasks.task_done(t.id))
        into v_out from tasks.tasks t join tasks.projects pr on pr.id = t.project_id where t.id = v_id and tasks.scope_project(v_scopes, t.tab_id, t.project_id);
    end if;
    if v_out is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', v_kind, 'id', v_id)); end if;
    return v_out;
  end if;

  if v_args->>'tabId' is not null then
    begin v_tab := (v_args->>'tabId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid tabId')); end;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'id', t.id, 'name', t.name, 'color', t.color, 'revision', t.revision, 'deleted', t.deleted_at is not null,
      'projects', (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', pr.id, 'title', pr.title, 'status', pr.status, 'system', pr.system, 'color', pr.color, 'revision', pr.revision, 'deleted', pr.deleted_at is not null,
            'tasks', (
              select coalesce(jsonb_agg(jsonb_build_object(
                  'id', k.id, 'parentId', k.parent_id, 'title', k.title, 'done', tasks.task_done(k.id), 'revision', k.revision, 'deleted', k.deleted_at is not null
                ) order by k.position, k.id), '[]'::jsonb)
              from tasks.tasks k where k.project_id = pr.id and (v_deleted or k.deleted_at is null))
          ) order by pr.position, pr.id), '[]'::jsonb)
        from tasks.projects pr
        where pr.tab_id = t.id and tasks.scope_project(v_scopes, pr.tab_id, pr.id)
          and (v_deleted or pr.deleted_at is null) and (v_archived or pr.status <> 'archived'))
    ) order by t.position, t.id), '[]'::jsonb)
    into v_out
    from tasks.tabs t
    where tasks.scope_some(v_scopes, t.id) and (v_tab is null or t.id = v_tab) and (v_deleted or t.deleted_at is null);
  return jsonb_build_object('tabs', v_out);
end $$;

create or replace function tasks.low_stock(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_scopes jsonb;
  v_tab uuid;
  v_out jsonb;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if v_args->>'tabId' is not null then
    begin v_tab := (v_args->>'tabId')::uuid; exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid tabId')); end;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'tabId', s.tab_id, 'name', s.name, 'category', s.category, 'unit', s.unit, 'location', s.location,
      'stock', st.stock, 'minQuantity', s.min_quantity, 'reorderQuantity', s.reorder_quantity,
      'supplierId', s.supplier_id, 'supplierName', s.supplier_name,
      'openRequestId', (select rq.id from tasks.purchase_requests rq
                        where rq.supply_item_id = s.id and rq.deleted_at is null and rq.status in ('requested', 'approved', 'purchased')
                        order by rq.created_at desc limit 1)
    ) order by s.position, s.id), '[]'::jsonb)
    into v_out
    from tasks.supply_items s
    cross join lateral (select coalesce(sum(mv.delta), 0) stock from tasks.supply_movements mv where mv.supply_item_id = s.id and mv.deleted_at is null) st
    where s.deleted_at is null and not s.archived and tasks.scope_full(v_scopes, s.tab_id)
      and (v_tab is null or s.tab_id = v_tab) and st.stock < s.min_quantity;
  return jsonb_build_object('items', v_out);
end $$;

select core.allow_read('tasks', 'tasks.low_stock', 'function');

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
