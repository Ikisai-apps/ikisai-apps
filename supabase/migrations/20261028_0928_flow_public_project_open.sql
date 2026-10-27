-- Ikisai Flow · la carta pública solo pide en un flujo abierto (auditoría de seguridad del 27-10, FL11).
-- Un token web antiguo seguía pidiendo en un flujo que ya no sirve la carta o está cerrado. En lote público, un pedido (o
-- una línea de un pedido) entra solo si su flujo está activo y vivo, y además:
-- - cliente web (la carta del QR de la barra): el flujo atiende la carta pública (`serves_public`);
-- - huésped o visitante: el flujo es el de su evento (su cliente ya es de ese flujo), aunque no atienda la carta pública.

create or replace function flow.guard_public_project() returns trigger language plpgsql as $$
declare v_project uuid; v_customer uuid;
begin
  if not core.is_public_batch() then return new; end if;
  if tg_table_name = 'orders' then
    v_project := new.project_id; v_customer := new.customer_id;
  else
    select o.project_id, o.customer_id into v_project, v_customer from flow.orders o where o.id = new.order_id;
  end if;
  if not exists (
    select 1 from flow.projects pr join flow.customers c on c.id = v_customer and c.project_id = pr.id
     where pr.id = v_project and pr.deleted_at is null and pr.status = 'active'
       and (pr.serves_public or c.origin in ('guest', 'visitor'))) then
    perform core.fail('MENU_CLOSED', 409, jsonb_build_object('project_id', v_project));
  end if;
  return new;
end $$;

create trigger flow_public_project before insert on flow.orders for each row execute function flow.guard_public_project();
create trigger flow_public_project before insert or update on flow.order_lines for each row execute function flow.guard_public_project();

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
