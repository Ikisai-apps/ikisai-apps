-- Ikisai Flow · número de cobro del justificante para Finance (petición de Finance, 27-10).
-- `receipt_for_send` devuelve `receipt_number`: los números de cobro (`pay_seq`) de sus pedidos, en orden, unidos con «+»
-- («12» o «12+13»). Si no caben en los 64 caracteres de Finance, el primero y el último («12…41»).
-- flow-api lo manda a `invoices.record_app_entry` con `receipt_kind: 'ticket'`.

create or replace function flow.receipt_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object('receipt', to_jsonb(r), 'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'booking_event_id', pr.booking_event_id),
    'day', (r.created_at at time zone 'Europe/Madrid')::date,
    'receipt_number', (select case when length(string_agg(o.pay_seq::text, '+' order by o.pay_seq)) <= 64 then string_agg(o.pay_seq::text, '+' order by o.pay_seq)
                                   else min(o.pay_seq)::text || '…' || max(o.pay_seq)::text end
                         from flow.orders o where o.id = any(r.order_ids) and o.pay_seq is not null),
    'detail', coalesce((select jsonb_agg(jsonb_build_object('code', p2.scope || ':' || p2.code, 'name', p2.name, 'quantity', l.quantity, 'amount_cents', l.quantity * coalesce(l.unit_price_cents, 0))
                         order by p2.scope, p2.code)
                          from flow.order_lines l join flow.products p2 on p2.id = l.product_id where l.order_id = any(r.order_ids) and l.deleted_at is null), '[]'::jsonb))
    from flow.receipts r join flow.projects pr on pr.id = r.project_id
   where r.id = (p->'args'->>'id')::uuid and r.deleted_at is null and flow.in_scope((p->>'actor')::uuid, r.project_id)
$$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
