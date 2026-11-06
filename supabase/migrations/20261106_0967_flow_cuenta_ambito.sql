-- Flow 0967: `flow.account_for_send` (y `flow.undecided_accounts`) solo devuelven cuentas del ámbito de quien llama (revisión de seguridad, 06-11).
-- Sin esto, alguien con acceso a un flujo podía mandar a Finance (y marcar como enviada) una cuenta de otro flujo sabiendo su
-- id. Ahora, fuera del ámbito, la lectura no devuelve nada y flow-api responde 404, como `receipt_for_send`.

create or replace function flow.account_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'revision', a.revision, 'holder', a.holder, 'status', a.status, 'settled_at', a.settled_at,
      'finance_status', a.finance_status, 'updated_at', a.updated_at),
    'method', (select pa.method from flow.payments pa where pa.id = a.payment_id),
    'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'booking_event_id', pr.booking_event_id),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('pay_seq', o.pay_seq, 'total_cents', o.total_cents) order by o.pay_seq)
       from flow.orders o where o.account_id = a.id and o.deleted_at is null and o.status in ('paid','delivered')), '[]'::jsonb))
  from flow.accounts a join flow.projects pr on pr.id = a.project_id
  where a.id = (p->'args'->>'id')::uuid and a.deleted_at is null and flow.in_scope((p->>'actor')::uuid, a.project_id)
$$;

-- Por simetría, las cuentas sin decidir de un flujo también solo dentro del ámbito.
create or replace function flow.undecided_accounts(p jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'holder', a.holder, 'total_cents', t.total, 'orders', t.n) order by a.created_at), '[]'::jsonb)
  from flow.accounts a
  join lateral (select coalesce(sum(o.total_cents), 0) total, count(*) n from flow.orders o
                 where o.account_id = a.id and o.deleted_at is null and o.status in ('paid','delivered')) t on t.n > 0
  where a.project_id = (p->'args'->>'project_id')::uuid and a.deleted_at is null and a.status = 'open' and flow.in_scope((p->>'actor')::uuid, a.project_id)
$$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
