-- Ikisai Flow · visitantes por QR (FL2; kit de visitantes del núcleo, core 0096). Quien entra por el QR de un evento
-- (ven.ikisai.com/e/<código>) sin invitación tiene número de cliente en la barra de ese evento:
-- - `flow.customers.visitor_id` (origen 'visitor'): un cliente por visitante y flujo. Lo crea el lote público firmado por el
--   visitante (`POST public/visitor_join`, flow-api); «Soy el 142» sigue funcionando sin visitante (origen 'web').
-- - `flow_visitor_customer({event_code})` (lectura pública expuesta al navegador, con el visitor_id del kit): número,
--   enlace a la carta, si tiene cuenta abierta y sus pedidos («Mi pedido» en Guests).
-- - Los enlaces a la carta (huésped y visitante) firman también la revisión del cliente: el canje la sube, así que son de
--   un solo uso (y caducan a los 10 minutos). Los enlaces de huésped de tres partes (0910) siguen valiendo hasta caducar.
-- La barra v1 no cambia.

alter table flow.customers drop constraint customers_origin_check;
alter table flow.customers add constraint customers_origin_check check (origin in ('web','guest','visitor'));
alter table flow.customers add column visitor_id uuid;
alter table flow.customers add constraint customers_visitor_check check ((origin = 'visitor') = (visitor_id is not null));
create unique index customers_visitor_uidx on flow.customers (project_id, visitor_id) where visitor_id is not null;
select core.register_table('flow', 'flow', 'customers', array['project_id','number','token_hash','origin','guest_id','display_name','visitor_id'], '{reader,editor,owner,outsider}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Guarda (sustituye a la de la 0910): en el lote público, un cliente nuevo es 'web' o el 'visitor' del propio lote; de un
-- cliente de huésped o de visitante solo cambia el token (canje).
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Enlace firmado a la carta: <cliente>.<caducidad>.<revisión>.<firma> (un solo uso)
-- ---------------------------------------------------------------------------
create or replace function flow.carta_link(p_customer flow.customers) returns text language plpgsql stable as $$
declare v_key text := flow.portal_key(); v_msg text;
begin
  if v_key is null then return null; end if;
  v_msg := p_customer.id::text || '.' || (extract(epoch from now())::bigint + 600)::text || '.' || p_customer.revision::text;
  return 'https://flow.ikisai.com/?invitacion=' || v_msg || '.' || flow.hmac_sha256_hex(v_msg, v_key);
end $$;

-- portal_customer (0910) con el enlace de un solo uso.
create or replace function flow.portal_customer(p jsonb) returns jsonb language plpgsql stable as $$
declare v_res uuid; v_guest uuid; v_c flow.customers; v_public boolean;
begin
  begin
    v_res := (p->'args'->>'reservation_id')::uuid; v_guest := (p->'args'->>'guest_id')::uuid;
  exception when others then v_res := null;
  end;
  if v_res is null or v_guest is null or not core.portal_in_scope('guests', (p->>'actor')::uuid, v_res, v_guest) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'guest out of scope'));
  end if;
  select c.* into v_c from flow.customers c join flow.projects pr on pr.id = c.project_id
   where c.guest_id = v_guest and c.origin = 'guest' and c.deleted_at is null and pr.deleted_at is null and pr.status = 'active'
   order by pr.serves_public desc, c.created_at desc limit 1;
  if v_c.id is null then return jsonb_build_object('number', null, 'carta_url', null, 'account_open', false); end if;
  select serves_public into v_public from flow.projects where id = v_c.project_id;
  return jsonb_build_object('number', v_c.number, 'carta_url', case when v_public then flow.carta_link(v_c) end,
    'account_open', exists (select 1 from flow.accounts where customer_id = v_c.id and status = 'open' and deleted_at is null));
end $$;

-- Canje (flow-api, POST public/invitation): firma, caducidad y, con cuatro partes, la revisión (un solo uso).
create or replace function flow.public_guest_link(p jsonb) returns jsonb language plpgsql stable as $$
declare v_parts text[] := string_to_array(coalesce(p->>'invitation', ''), '.'); v_n int; v_id uuid; v_key text; v_c flow.customers; v_msg text; v_sig text;
begin
  v_n := coalesce(array_length(v_parts, 1), 0);
  if v_n not in (3, 4) or v_parts[2] !~ '^[0-9]{1,12}$' or v_parts[v_n] !~ '^[0-9a-f]{64}$' or (v_n = 4 and v_parts[3] !~ '^[0-9]{1,18}$') then return null; end if;
  begin v_id := v_parts[1]::uuid; exception when others then return null; end;
  v_key := flow.portal_key();
  v_msg := array_to_string(v_parts[1:v_n - 1], '.');
  v_sig := v_parts[v_n];
  if v_key is null or flow.hmac_sha256_hex(v_msg, v_key) <> v_sig then return null; end if;
  if v_parts[2]::bigint < extract(epoch from now()) then return jsonb_build_object('expired', true); end if;
  select * into v_c from flow.customers where id = v_id and deleted_at is null
     and (origin = 'guest' or (v_n = 4 and origin = 'visitor'));
  if v_c.id is null then return null; end if;
  if v_n = 4 and v_parts[3]::bigint <> v_c.revision then return jsonb_build_object('used', true); end if;
  return jsonb_build_object('customerId', v_c.id, 'revision', v_c.revision, 'number', v_c.number);
end $$;

-- ---------------------------------------------------------------------------
-- Visitantes
-- ---------------------------------------------------------------------------
/** El flujo de un evento de Booking (por su código) que atiende la carta pública, o null. */
create or replace function flow.visitor_project(p_event_code text) returns uuid language sql stable as $$
  select pr.id from flow.projects pr join booking.event_projection e on e.event_id = pr.booking_event_id
   where e.event_code = p_event_code and pr.deleted_at is null and pr.status = 'active' and pr.serves_public
   order by pr.created_at desc limit 1
$$;

/** Para flow-api (visitor_join): el flujo del evento y, si ya existe, el cliente de este visitante. args = { event_code, visitor_id } */
create or replace function flow.public_visitor_target(p jsonb) returns jsonb language sql stable as $$
  with pr as (select flow.visitor_project(p->>'event_code') as id)
  select jsonb_build_object('projectId', pr.id,
    'customerId', (select c.id from flow.customers c where c.project_id = pr.id and c.visitor_id = nullif(p->>'visitor_id', '')::uuid and c.deleted_at is null))
    from pr
$$;

/** «Mi pedido» del visitante en ese evento. args = { event_code, visitor_id (del kit) } */
create or replace function flow.public_visitor_customer(p jsonb) returns jsonb language plpgsql stable as $$
declare v_project uuid; v_c flow.customers; v_visitor uuid;
begin
  begin v_visitor := nullif(p->>'visitor_id', '')::uuid; exception when others then v_visitor := null; end;
  if coalesce(p->>'event_code', '') !~ '^[A-Za-z0-9_-]{1,40}$' then return jsonb_build_object('number', null, 'carta_url', null, 'account_open', false, 'orders', '[]'::jsonb); end if;
  v_project := flow.visitor_project(p->>'event_code');
  if v_project is not null and v_visitor is not null then
    select * into v_c from flow.customers where project_id = v_project and visitor_id = v_visitor and deleted_at is null;
  end if;
  if v_c.id is null then return jsonb_build_object('number', null, 'carta_url', null, 'account_open', false, 'orders', '[]'::jsonb); end if;
  return jsonb_build_object('number', v_c.number, 'carta_url', flow.carta_link(v_c),
    'account_open', exists (select 1 from flow.accounts where customer_id = v_c.id and status = 'open' and deleted_at is null),
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object('number', o.pay_seq, 'status', o.status,
        'summary', (select string_agg(l.quantity || ' ' || pr.code, ' · ' order by l.position) from flow.order_lines l join flow.products pr on pr.id = l.product_id
                     where l.order_id = o.id and l.deleted_at is null),
        'preparing', exists (select 1 from flow.units u where u.order_id = o.id and u.deleted_at is null and u.status in ('pending','in_progress')))
        order by o.created_at desc)
        from flow.orders o where o.customer_id = v_c.id and o.deleted_at is null), '[]'::jsonb));
end $$;

select core.allow_public_read('flow_visitor_target', 'flow.public_visitor_target');
select core.allow_public_read('flow_visitor_customer', 'flow.public_visitor_customer', true);

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
revoke all on function flow.portal_key() from public, anon, authenticated;
