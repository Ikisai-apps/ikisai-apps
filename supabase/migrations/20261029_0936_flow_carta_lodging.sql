-- Ikisai Flow · «Alójate aquí» en la carta pública (encargo de Core, 27-10).
-- - `public_menu` da el código público del evento del flujo (`eventCode`); flow-api mira en Booking si ese evento admite
--   alojamiento (`booking_public_events`, `lodging`) y solo entonces la carta enseña el enlace.
-- - Al tocarlo, el móvil obtiene un visitante del kit y su cliente web se liga a ese visitante (`customers.visitor_id`), para
--   que «Mi pedido» siga a la misma persona en ven.ikisai.com. Lo hace el lote público con ese visitante: solo un cliente
--   web sin visitante, solo `visitor_id`, y solo con el visitante que firma el lote.

-- Un cliente de visitante siempre tiene visitante; uno web puede tenerlo (ligado con «Alójate aquí»); uno de huésped, no.
alter table flow.customers drop constraint customers_visitor_check;
alter table flow.customers add constraint customers_visitor_check
  check ((origin <> 'visitor' or visitor_id is not null) and (origin in ('visitor', 'web') or visitor_id is null));

create or replace function flow.public_menu(p jsonb) returns jsonb language sql stable as $$
  with project as (
    select id, name, booking_event_id from flow.projects where deleted_at is null and status = 'active' and serves_public order by created_at desc, id desc limit 1
  )
  select jsonb_build_object(
    'project', (select name from project),
    'projectId', (select id from project),
    -- Código público del evento del flujo (el del QR y de ven.ikisai.com), para «Alójate aquí» (0936).
    'eventCode', (select e.public_code from booking.event_projection e join project on e.event_id = project.booking_event_id),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'scope', pr.scope, 'code', pr.code, 'name', pr.name, 'description', pr.description,
               'priceCents', pr.price_cents, 'position', pr.position, 'imageKey', pr.image_key,
               'allergens', to_jsonb(pr.allergens), 'allergensChecked', pr.allergens_checked) order by pr.scope, pr.position, pr.code)
        from flow.products pr join project on project.id = pr.project_id
       where pr.deleted_at is null and pr.active), '[]'::jsonb))
$$;

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
      -- «Alójate aquí» (0936): el cliente web de la carta se liga al visitante del kit que lo pide, una vez y sin más cambios.
      if tg_op = 'UPDATE' and old.origin = 'web' and old.visitor_id is null and new.visitor_id is not null and new.visitor_id = core.current_visitor()
         and not flow.changed(v_old, v_new, array['project_id','number','origin','guest_id','display_name','token_hash','deleted_at']) then return new; end if;
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

/** Para flow-api (public/customer_visitor): el cliente web de un token, con su revisión. args = { token_hash } */
create or replace function flow.public_customer_for_link(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('customerId', c.id, 'revision', c.revision, 'origin', c.origin, 'visitorId', c.visitor_id, 'projectId', c.project_id)
    from flow.customers c where c.token_hash = p->>'token_hash' and c.deleted_at is null
$$;
select core.allow_public_read('flow_customer_for_link', 'flow.public_customer_for_link');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
