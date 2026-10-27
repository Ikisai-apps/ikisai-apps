-- Ikisai Flow · el enlace de una unidad a Tasks lo anota el servidor (auditoría de seguridad del 27-10, FL6).
-- Antes, cualquier editor del proyecto llamaba a `flow.unit_link_external` con un enlace arbitrario y marcaba una unidad como
-- «ya pedida» apuntando a algo ajeno. Ahora `POST units/:id/tasks` anota en la unidad lo que Tasks devolvió, con el lote
-- público del servidor, que de una unidad solo puede cambiar `payload.external`. Fuera el procedimiento.

create or replace function flow.guard() returns trigger language plpgsql as $$
declare v_new jsonb := to_jsonb(new); v_old jsonb; v_status text;
begin
  if flow.in_proc() then return new; end if;
  if tg_op = 'UPDATE' then v_old := to_jsonb(old); end if;
  -- Lote público (carta, sin sesión): crear su cliente, crear su pedido abierto y poner líneas en un pedido público abierto.
  -- (Un `if` por tabla: PL/pgSQL resuelve `new.<campo>` aunque la condición anterior del `and` sea falsa.)
  if core.is_public_batch() then
    if tg_table_name = 'customers' then
      if tg_op = 'INSERT' and new.guest_id is null and new.display_name is null
         and ((new.origin = 'web' and new.visitor_id is null) or (new.origin = 'visitor' and new.visitor_id = core.current_visitor())) then return new; end if;
      -- Canje de una invitación (0910): solo cambiar el token de un cliente de huésped.
      if tg_op = 'UPDATE' and old.origin in ('guest','visitor') and not flow.changed(v_old, v_new, array['project_id','number','origin','guest_id','display_name','visitor_id','deleted_at']) then return new; end if;
    elsif tg_table_name = 'orders' then
      if tg_op = 'INSERT' and new.status = 'open' and new.origin = 'public' and new.customer_id is not null and new.parent_id is null
         and new.pay_seq is null and new.paid_at is null and new.total_cents is null and not new.delivery_exception and new.account_id is null then
        return new;
      end if;
    elsif tg_table_name = 'units' then
      -- Enlace a otra app (FL6, 0931): flow-api anota en la unidad lo que creó en Tasks; solo `payload.external`.
      if tg_op = 'UPDATE' and not flow.changed(v_old, v_new, array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by','source_ref','deleted_at'])
         and (old.payload - 'external') = (new.payload - 'external') then
        return new;
      end if;
    elsif tg_table_name = 'order_lines' then
      if new.unit_price_cents is null and new.delivered_qty = 0
         and exists (select 1 from flow.orders o where o.id = new.order_id and o.status = 'open' and o.origin = 'public' and o.deleted_at is null)
         -- Solo productos de la carta: activos y del mismo proyecto que el pedido.
         and exists (select 1 from flow.products pr join flow.orders o on o.id = new.order_id
                      where pr.id = new.product_id and pr.project_id = o.project_id and pr.active and pr.deleted_at is null)
         and (tg_op = 'INSERT' or not flow.changed(v_old, v_new, array['order_id'])) then
        return new;
      end if;
    end if;
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'public batch', 'table', 'flow.' || tg_table_name));
  end if;
  if tg_table_name = 'orders' then
    if (tg_op = 'INSERT' and (new.status <> 'open' or new.pay_seq is not null or new.paid_at is not null or new.total_cents is not null or new.delivered_at is not null
                              or new.delivery_exception or new.parent_id is not null or new.account_id is not null))
       or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['status','pay_seq','paid_at','paid_by','pay_method','total_cents','delivered_at','delivered_by','delivery_ident','delivery_exception','project_id','parent_id','account_id'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.orders'));
    end if;
    -- Un pedido cobrado no se borra ni cambia de origen o de cliente desde el cliente (§4.6).
    if tg_op = 'UPDATE' and old.status <> 'open' and flow.changed(v_old, v_new, array['deleted_at','origin','customer_id']) then
      perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', old.id, 'status', old.status));
    end if;
    if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and exists (select 1 from flow.payments where order_id = old.id) then
      perform core.fail('ORDER_HAS_PAYMENTS', 409, jsonb_build_object('order_id', old.id));
    end if;
  elsif tg_table_name = 'order_lines' then
    select status into v_status from flow.orders where id = new.order_id;
    if (tg_op = 'INSERT' and new.unit_price_cents is not null) or (tg_op = 'UPDATE' and flow.changed(v_old, v_new, array['unit_price_cents','order_id'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.order_lines'));
    end if;
    if v_status <> 'open' and (tg_op = 'INSERT' or flow.changed(v_old, v_new, array['product_id','quantity','position','deleted_at'])) then
      perform core.fail('ORDER_NOT_OPEN', 409, jsonb_build_object('order_id', new.order_id, 'status', v_status));
    end if;
  elsif tg_table_name = 'units' then
    if tg_op = 'INSERT' and not (new.kind = 'task' and new.column_key = 'logistics' and new.status = 'pending' and new.order_id is null and new.line_id is null
                                 and new.product_id is null and new.assigned_to is null and new.done_at is null and new.done_by is null and new.pay_seq is null) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
    if tg_op = 'UPDATE' and (old.kind <> 'task' or flow.changed(v_old, v_new, array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','status','assigned_to','done_at','done_by'])) then
      perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units'));
    end if;
  elsif tg_table_name in ('payments','events','customers','accounts') then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
  end if;
  return new;
end $$;

select core.allow_public_write('flow', 'flow.units');

-- La revisión, para anotar el enlace sin pisar otros cambios.
create or replace function flow.unit_for_tasks(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('unit', jsonb_build_object('id', u.id, 'revision', u.revision, 'kind', u.kind, 'label', u.label, 'priority', u.priority, 'status', u.status,
           'column_key', u.column_key, 'payload', u.payload),
         'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'tasks_project_id', pr.tasks_project_id))
    from flow.units u join flow.projects pr on pr.id = u.project_id
   where u.id = (p->'args'->>'id')::uuid and u.deleted_at is null and flow.in_scope((p->>'actor')::uuid, u.project_id)
$$;

-- El permiso registrado lo retira el núcleo (`core.disallow_procedure`, pendiente): sin la función, la llamada falla igual.
drop function if exists flow.unit_link_external(jsonb);

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
