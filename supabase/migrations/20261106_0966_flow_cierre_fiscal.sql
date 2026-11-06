-- Flow 0966: el cierre del día hacia Finance según el contrato de fl-27 (UX-Finance, 05-11), §2.
-- - `flow.fiscal_of_day` también descuenta, del apunte fiscal del día, los cobros de cuentas que ya fueron a Finance con su
--   propio apunte (`flow:account:<id>`, 0965): así cada euro llega a Finance una sola vez.
-- - `flow.receipt_for_send` lleva `order_code` («P 14») en cada línea del justificante.
-- - `flow.closing_extras`: lo informativo del resumen de proceso (`flow:closing:<p>:<día>`): cuentas abiertas a fin de día y lo
--   vendido a cuenta ese día (sin dinero propio).

create or replace function flow.fiscal_of_day(p jsonb) returns jsonb language sql stable as $$
  with r as (
    select * from flow.receipts where project_id = (p->'args'->>'project_id')::uuid and deleted_at is null and finance_status = 'sent'
       and (created_at at time zone 'Europe/Madrid')::date = (p->'args'->>'day')::date
  ),
  -- Cobros de cuentas ya enviadas a Finance con su apunte: el pago de liquidar ese día.
  ac as (
    select pa.method, pa.amount_cents, pa.account_id from flow.payments pa join flow.accounts a on a.id = pa.account_id
     where pa.project_id = (p->'args'->>'project_id')::uuid and pa.deleted_at is null and pa.kind = 'charge' and pa.order_id is null
       and a.finance_status = 'sent' and (pa.created_at at time zone 'Europe/Madrid')::date = (p->'args'->>'day')::date
  ),
  money as (select method, total_cents as cents from r union all select method, amount_cents from ac),
  lines as (
    select l.* from r, flow.order_lines l where l.order_id = any(r.order_ids) and l.deleted_at is null
    union all
    select l.* from ac join flow.orders o on o.account_id = ac.account_id and o.deleted_at is null
      join flow.order_lines l on l.order_id = o.id and l.deleted_at is null
  )
  select jsonb_build_object(
    'amount_cents', coalesce((select sum(cents) from money), 0),
    'methods', coalesce((select jsonb_object_agg(method, s) from (select method, sum(cents) as s from money group by method) m), '{}'::jsonb),
    'detail', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'units', units, 'amount_cents', amount)) from (
        select p2.scope || ':' || p2.code as code, sum(l.quantity)::int as units, sum(l.quantity * coalesce(l.unit_price_cents, 0))::int as amount
          from lines l join flow.products p2 on p2.id = l.product_id group by 1) d), '[]'::jsonb))
$$;

create or replace function flow.receipt_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('receipt', to_jsonb(r), 'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'booking_event_id', pr.booking_event_id),
    'day', (r.created_at at time zone 'Europe/Madrid')::date,
    'receipt_number', (select case when length(string_agg(o.pay_seq::text, '+' order by o.pay_seq)) <= 64 then string_agg(o.pay_seq::text, '+' order by o.pay_seq)
                                   else min(o.pay_seq)::text || '…' || max(o.pay_seq)::text end
                         from flow.orders o where o.id = any(r.order_ids) and o.pay_seq is not null),
    'detail', coalesce((select jsonb_agg(jsonb_build_object('code', p2.scope || ':' || p2.code, 'name', p2.name, 'quantity', l.quantity,
                          'amount_cents', l.quantity * coalesce(l.unit_price_cents, 0), 'order_code', 'P ' || o.pay_seq)
                         order by o.pay_seq, p2.scope, p2.code)
                          from flow.order_lines l join flow.products p2 on p2.id = l.product_id join flow.orders o on o.id = l.order_id
                         where l.order_id = any(r.order_ids) and l.deleted_at is null), '[]'::jsonb))
    from flow.receipts r join flow.projects pr on pr.id = r.project_id
   where r.id = (p->'args'->>'id')::uuid and r.deleted_at is null and flow.in_scope((p->>'actor')::uuid, r.project_id)
$$;

/** Para el resumen de proceso del cierre: cuentas abiertas a fin de día y lo vendido a cuenta ese día. args = { project_id, day } */
create or replace function flow.closing_extras(p jsonb) returns jsonb language sql stable as $$
  with pr as (select (p->'args'->>'project_id')::uuid as id, (p->'args'->>'day')::date as day),
  opened as (
    select a.id, coalesce(sum(o.total_cents), 0) as cents from flow.accounts a join pr on a.project_id = pr.id
      left join flow.orders o on o.account_id = a.id and o.deleted_at is null and o.status in ('paid','delivered')
     where a.deleted_at is null and a.status = 'open' group by a.id),
  charged as (
    select o.total_cents from flow.orders o join pr on o.project_id = pr.id
     where o.deleted_at is null and o.pay_method = 'account' and not o.test_excluded and (o.paid_at at time zone 'Europe/Madrid')::date = pr.day)
  select jsonb_build_object(
    'open_accounts', jsonb_build_object('n', (select count(*) from opened), 'cents', coalesce((select sum(cents) from opened), 0)),
    'a_cuenta', jsonb_build_object('n', (select count(*) from charged), 'cents', coalesce((select sum(total_cents) from charged), 0)))
$$;
select core.allow_read('flow', 'flow.closing_extras', 'function', '{owner}');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
