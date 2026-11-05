-- Flow 0965: las cuentas abiertas se deciden al cerrar el día (fl-27a; VG F-P4, contrato de Finance del 05-11).
-- Al cerrar el día, cada cuenta abierta se cobra en ese momento, pasa a Finance como pendiente de cobro con su nombre, o se
-- anula. flow-api no manda el cierre a Finance mientras quede alguna sin decidir.
-- - `flow.accounts.status` admite 'deferred' (pasada a Finance como pendiente); se puede liquidar más tarde con settle_account.
-- - Estado del envío a Finance de la cuenta (`finance_status`, `finance_sent_at`, `finance_result`): lo anota flow-api cuando
--   Finance responde, con el lote público del servidor y solo esos campos, igual que en los justificantes (0917).
-- - `flow.defer_account(account_id, expected_revision)`: pasa una cuenta de abierta a «pasada a Finance». La puede usar el owner
--   o quien la abrió.
-- - `flow.void_account(account_id, reason)`: anula la cuenta y sus pedidos, que no fueron reales y no cuentan ni en ventas ni en
--   Finance. Solo el owner, y con la cuenta abierta o pasada a Finance; una liquidada no se anula.
-- - `flow.account_for_send`: lo que flow-api manda a Finance de una cuenta (`flow:account:<id>`).

alter table flow.accounts drop constraint if exists accounts_status_check;
alter table flow.accounts add constraint accounts_status_check check (status in ('open', 'settled', 'deferred'));
alter table flow.accounts add column if not exists finance_status text check (finance_status is null or finance_status in ('sent', 'error'));
alter table flow.accounts add column if not exists finance_sent_at timestamptz;
alter table flow.accounts add column if not exists finance_result jsonb;
select core.register_table('flow', 'flow', 'accounts', array['project_id','customer_id','holder','status','opened_by','settled_at','settled_by','payment_id','finance_status','finance_sent_at','finance_result'], '{reader,editor,owner,outsider}', '{editor,owner}', true);
alter table flow.events drop constraint events_kind_check;
alter table flow.events add constraint events_kind_check check (kind in ('paid','payment_reversed','order_adjusted','units_cancelled','unit_reverted',
  'delivered','order_reopened','extension_created','refund_settled','public_order','stock_moved','stock_reverted','tasks_generated',
  'account_opened','account_settled','guest_numbers','account_deferred','account_voided'));

create or replace function flow.guard_accounts() returns trigger language plpgsql as $$
begin
  if flow.in_proc() then return new; end if;
  if core.is_public_batch() and tg_op = 'UPDATE'
     and not flow.changed(to_jsonb(old), to_jsonb(new), array['project_id','customer_id','holder','status','opened_by','settled_at','settled_by','payment_id','deleted_at'])
     and new.finance_status in ('sent','error') then
    return new;
  end if;
  perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.' || tg_table_name));
end $$;
drop trigger if exists flow_guard on flow.accounts;
create trigger flow_guard before insert or update on flow.accounts for each row execute function flow.guard_accounts();
select core.allow_public_write('flow', 'flow.accounts');

create or replace function flow.settle_account(p jsonb) returns jsonb language plpgsql as $$
declare v_a flow.accounts; v_method text := p->'args'->>'method'; v_total int; v_n int; v_pay uuid; v_expected bigint := (p->'args'->>'expected_revision')::bigint;
begin
  perform flow.proc_begin();
  select * into v_a from flow.accounts where id = flow.arg_uuid(p, 'account_id') for update;
  if v_a.id is null or v_a.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.accounts', 'id', p->'args'->>'account_id')); end if;
  perform flow.check_scope(p, v_a.project_id);
  if v_expected is not null and v_expected <> v_a.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.accounts', 'id', v_a.id, 'expectedRevision', v_expected, 'currentRevision', v_a.revision, 'current', to_jsonb(v_a)));
  end if;
  if v_a.status not in ('open', 'deferred') then perform core.fail('ACCOUNT_NOT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'status', v_a.status)); end if;
  if p->>'role' <> 'owner' and v_a.opened_by is distinct from (p->>'actor')::uuid then
    perform core.fail('SETTLE_FORBIDDEN', 403, jsonb_build_object('account_id', v_a.id, 'openedBy', v_a.opened_by));
  end if;
  if v_method is null or v_method not in ('cash','bizum','card') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'method must be cash, bizum or card')); end if;
  select coalesce(sum(total_cents), 0), count(*) into v_total, v_n from flow.orders where account_id = v_a.id and deleted_at is null and status in ('paid','delivered');
  if v_total > 0 then
    v_pay := flow.ins(p, 'flow.payments', jsonb_build_object('account_id', v_a.id, 'kind', 'charge', 'method', v_method, 'amount_cents', v_total,
      'note', left('Cuenta: ' || v_a.holder, 300)));
  end if;
  perform flow.upd(p, 'flow.accounts', v_a.id, v_a.revision, jsonb_build_object('status', 'settled', 'settled_at', now(), 'settled_by', (p->>'actor')::uuid, 'payment_id', v_pay));
  perform flow.log(p, v_a.project_id, 'account_settled', null, null, jsonb_build_object('accountId', v_a.id, 'holder', v_a.holder, 'method', v_method,
    'totalCents', v_total, 'orders', v_n, 'paymentId', v_pay));
  perform flow.proc_end();
  return jsonb_build_object('account_id', v_a.id, 'total_cents', v_total, 'orders', v_n, 'payment_id', v_pay);
end $$;

create or replace function flow.defer_account(p jsonb) returns jsonb language plpgsql as $$
declare v_a flow.accounts; v_expected bigint := (p->'args'->>'expected_revision')::bigint; v_total int; v_n int;
begin
  perform flow.proc_begin();
  select * into v_a from flow.accounts where id = flow.arg_uuid(p, 'account_id') for update;
  if v_a.id is null or v_a.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.accounts', 'id', p->'args'->>'account_id')); end if;
  perform flow.check_scope(p, v_a.project_id);
  if v_expected is not null and v_expected <> v_a.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'flow.accounts', 'id', v_a.id, 'expectedRevision', v_expected, 'currentRevision', v_a.revision, 'current', to_jsonb(v_a)));
  end if;
  if v_a.status <> 'open' then perform core.fail('ACCOUNT_NOT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'status', v_a.status)); end if;
  if p->>'role' <> 'owner' and v_a.opened_by is distinct from (p->>'actor')::uuid then
    perform core.fail('SETTLE_FORBIDDEN', 403, jsonb_build_object('account_id', v_a.id, 'openedBy', v_a.opened_by));
  end if;
  select coalesce(sum(total_cents), 0), count(*) into v_total, v_n from flow.orders where account_id = v_a.id and deleted_at is null and status in ('paid','delivered');
  perform flow.upd(p, 'flow.accounts', v_a.id, v_a.revision, jsonb_build_object('status', 'deferred'));
  perform flow.log(p, v_a.project_id, 'account_deferred', null, null, jsonb_build_object('accountId', v_a.id, 'holder', v_a.holder, 'totalCents', v_total, 'orders', v_n));
  perform flow.proc_end();
  return jsonb_build_object('account_id', v_a.id, 'total_cents', v_total, 'orders', v_n);
end $$;

create or replace function flow.void_account(p jsonb) returns jsonb language plpgsql as $$
declare v_a flow.accounts; v_reason text := nullif(btrim(coalesce(p->'args'->>'reason', '')), ''); r record; x record; v_n int := 0; v_total int := 0;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'voiding an account is for the owner')); end if;
  select * into v_a from flow.accounts where id = flow.arg_uuid(p, 'account_id') for update;
  if v_a.id is null or v_a.deleted_at is not null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.accounts', 'id', p->'args'->>'account_id')); end if;
  perform flow.check_scope(p, v_a.project_id);
  if v_a.status not in ('open', 'deferred') then perform core.fail('ACCOUNT_NOT_OPEN', 409, jsonb_build_object('account_id', v_a.id, 'status', v_a.status)); end if;
  if v_reason is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'reason')); end if;
  -- Fuera sus pedidos (no fueron reales): primero la preparación y las líneas, después el pedido. La unidad del pedido en el
  -- motor la quita su propio disparador (0961).
  for r in select * from flow.orders where account_id = v_a.id and deleted_at is null loop
    for x in select id, revision from flow.units where order_id = r.id and deleted_at is null and kind <> 'order' loop
      perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.units', 'id', x.id, 'expectedRevision', x.revision));
    end loop;
    for x in select id, revision from flow.order_lines where order_id = r.id and deleted_at is null loop
      perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.order_lines', 'id', x.id, 'expectedRevision', x.revision));
    end loop;
    perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.orders', 'id', r.id, 'expectedRevision', (select revision from flow.orders where id = r.id)));
    v_n := v_n + 1; v_total := v_total + coalesce(r.total_cents, 0);
  end loop;
  perform flow.row_op(p, jsonb_build_object('op', 'delete', 'table', 'flow.accounts', 'id', v_a.id, 'expectedRevision', (select revision from flow.accounts where id = v_a.id)));
  perform flow.log(p, v_a.project_id, 'account_voided', null, null, jsonb_build_object('accountId', v_a.id, 'holder', v_a.holder, 'reason', v_reason,
    'totalCents', v_total, 'orders', v_n));
  perform flow.proc_end();
  return jsonb_build_object('account_id', v_a.id, 'total_cents', v_total, 'orders', v_n);
end $$;

/** Para flow-api: lo que se manda a Finance de una cuenta (pasada como pendiente o, después, liquidada). args = { id } */
create or replace function flow.account_for_send(p jsonb) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'account', jsonb_build_object('id', a.id, 'revision', a.revision, 'holder', a.holder, 'status', a.status, 'settled_at', a.settled_at,
      'finance_status', a.finance_status, 'updated_at', a.updated_at),
    'method', (select pa.method from flow.payments pa where pa.id = a.payment_id),
    'project', jsonb_build_object('id', pr.id, 'name', pr.name, 'booking_event_id', pr.booking_event_id),
    'orders', coalesce((select jsonb_agg(jsonb_build_object('pay_seq', o.pay_seq, 'total_cents', o.total_cents) order by o.pay_seq)
       from flow.orders o where o.account_id = a.id and o.deleted_at is null and o.status in ('paid','delivered')), '[]'::jsonb))
  from flow.accounts a join flow.projects pr on pr.id = a.project_id
  where a.id = (p->'args'->>'id')::uuid and a.deleted_at is null
$$;
select core.allow_read('flow', 'flow.account_for_send', 'function', '{editor,owner}');

/** Para flow-api: cuentas abiertas con pedidos del flujo, que hay que decidir antes de mandar el cierre. args = { project_id } */
create or replace function flow.undecided_accounts(p jsonb) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'holder', a.holder, 'total_cents', t.total, 'orders', t.n) order by a.created_at), '[]'::jsonb)
  from flow.accounts a
  join lateral (select coalesce(sum(o.total_cents), 0) total, count(*) n from flow.orders o
                 where o.account_id = a.id and o.deleted_at is null and o.status in ('paid','delivered')) t on t.n > 0
  where a.project_id = (p->'args'->>'project_id')::uuid and a.deleted_at is null and a.status = 'open'
$$;
select core.allow_read('flow', 'flow.undecided_accounts', 'function', '{owner}');

select core.allow_procedure('flow', 'flow.defer_account');
select core.allow_procedure('flow', 'flow.void_account');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
