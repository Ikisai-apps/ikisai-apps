-- Ikisai Flow · frenos de la carta pública (auditoría de seguridad del 27-10, FL5).
-- Las altas de clientes y los pedidos públicos entran por lote público (sin sesión). Sin freno, un script crea miles de
-- clientes o pedidos abiertos en plena barra. Como `core.visitor_create`, se cuenta en la base de datos:
-- - clientes: como mucho 60 altas por minuto en un flujo (un QR en la barra no da para más; un script sí);
-- - pedidos públicos: 6 por minuto por cliente (token), 5 abiertos (sin cobrar) por cliente y 120 por minuto en un flujo.
-- Solo en lotes públicos: la caja, los huéspedes y las cuentas no pasan por aquí. El límite por IP lo pone flow-api.

create index if not exists customers_project_created_idx on flow.customers (project_id, created_at);
create index if not exists orders_project_created_idx on flow.orders (project_id, created_at);

create or replace function flow.guard_public_limits() returns trigger language plpgsql as $$
begin
  if not core.is_public_batch() then return new; end if;
  if tg_table_name = 'customers' then
    if (select count(*) from flow.customers where project_id = new.project_id and created_at > now() - interval '1 minute') >= 60 then
      perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many customers created', 'limit', 60, 'window', '1m'));
    end if;
  elsif tg_table_name = 'orders' and new.customer_id is not null then
    if (select count(*) from flow.orders where customer_id = new.customer_id and status = 'open' and deleted_at is null) >= 5 then
      perform core.fail('TOO_MANY_OPEN_ORDERS', 429, jsonb_build_object('limit', 5));
    end if;
    if (select count(*) from flow.orders where customer_id = new.customer_id and created_at > now() - interval '1 minute') >= 6 then
      perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many orders from this customer', 'limit', 6, 'window', '1m'));
    end if;
    if (select count(*) from flow.orders where project_id = new.project_id and origin = 'public' and created_at > now() - interval '1 minute') >= 120 then
      perform core.fail('RATE_LIMITED', 429, jsonb_build_object('reason', 'too many public orders', 'limit', 120, 'window', '1m'));
    end if;
  end if;
  return new;
end $$;

create trigger flow_public_limits before insert on flow.customers for each row execute function flow.guard_public_limits();
create trigger flow_public_limits before insert on flow.orders for each row execute function flow.guard_public_limits();

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
