-- Finance · pagos en línea (finance-18, PR 2; decisiones de VG del 27-10 en
-- MUELA/equipo/feedback/finance/PAGOS_EN_LINEA_finance-18.md). Toca solo el schema invoices.
--
-- Se cobra **cada factura emitida** (enviada o no, sin borradores ni anuladas, aún «pendiente») con un enlace de la
-- pasarela que caduca a las 24 h. Ningún dato de tarjeta pasa por Ikisai: aquí solo el id de la sesión, la URL, el
-- importe y el estado. La pasarela la llama la Edge (`_domain/payments`); estas tablas son internas (sin roles, como las
-- de Drive y VERI*FACTU) y se escriben solo con acciones de sistema.
--
-- 1. `invoices.payment_links`: un enlace por intento; como mucho uno abierto por factura.
-- 2. `invoices.payment_events`: los avisos de la pasarela (idempotencia por id de evento).
-- 3. Acciones de sistema: preparar (qué se cobra y si ya hay uno abierto), guardar, marcar caducado o cancelado.
-- 4. Al anular, rectificar o cobrar a mano la factura, sus enlaces abiertos pasan a «cancelado» (la Edge caduca la sesión).
-- 5. Lecturas: los enlaces de una emitida (Finance) y `payment_link` en `portal_reservation_money` (F5 de Organizers).

create table invoices.payment_links (
  id uuid primary key default gen_random_uuid(),
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  provider text not null check (provider in ('stripe', 'redsys')),
  provider_ref text not null check (length(provider_ref) between 1 and 200),
  url text not null check (url ~ '^https://' and length(url) <= 1000),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'EUR' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'abierto' check (status in ('abierto', 'pagado', 'caducado', 'cancelado')),
  expires_at timestamptz not null,
  -- quién lo pidió: una persona de Finance o del portal (nunca datos de quien paga)
  requested_by uuid,
  requested_from text not null default 'finance' check (requested_from in ('finance', 'portal')),
  paid_at timestamptz,
  payment_ref text check (payment_ref is null or length(payment_ref) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1,
  unique (provider, provider_ref)
);
create unique index payment_links_one_open on invoices.payment_links (issued_invoice_id) where status = 'abierto';
create index payment_links_invoice_idx on invoices.payment_links (issued_invoice_id, created_at desc);

create table invoices.payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('stripe', 'redsys')),
  provider_event_id text not null check (length(provider_event_id) between 1 and 200),
  kind text not null check (kind in ('paid', 'expired', 'refunded', 'failed', 'ignored')),
  provider_ref text,
  payment_link_id uuid references invoices.payment_links(id),
  outcome text not null check (outcome in ('applied', 'duplicate', 'ignored', 'mismatch', 'unknown')),
  detail text check (detail is null or length(detail) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1,
  unique (provider, provider_event_id)
);

select core.register_table('invoices', 'invoices', 'payment_links', array[]::text[], '{}', '{}', true);
select core.register_table('invoices', 'invoices', 'payment_events', array[]::text[], '{}', '{}', true);

-- Factura cobrable: emitida (ni borrador ni anulada ni rectificada), no borrada y aún pendiente.
create or replace function invoices.payment_link_invoice(p_id uuid)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', i.id, 'number', i.full_number, 'description', i.description, 'total', i.total, 'currency', coalesce(i.currency, 'EUR'),
           'status', i.status, 'payment_status', i.payment_status,
           'payable', i.deleted_at is null and i.status not in ('borrador', 'anulada', 'rectificada') and i.payment_status = 'pendiente' and i.total > 0)
    from invoices.issued_invoices i where i.id = p_id;
$$;

-- 3. Acciones de sistema (solo la Edge, actor nulo).
-- prepare {issued_invoice_id}: la factura y el enlace abierto vigente (si queda más de 10 min); los abiertos ya vencidos
-- pasan a «caducado». Sin factura cobrable, PAYMENT_NOT_ALLOWED (409).
create or replace function invoices.payment_link_prepare(p jsonb)
returns jsonb language plpgsql as $$
declare v_id uuid; v_inv jsonb; v_open invoices.payment_links;
begin
  begin v_id := (p->'args'->>'issued_invoice_id')::uuid; exception when others then v_id := null; end;
  v_inv := invoices.payment_link_invoice(v_id);
  if v_inv is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('issued_invoice_id', p->'args'->>'issued_invoice_id')); end if;
  update invoices.payment_links set status = 'caducado', updated_at = now() where issued_invoice_id = v_id and status = 'abierto' and expires_at <= now() + interval '10 minutes';
  if not (v_inv->>'payable')::boolean then
    perform core.fail('PAYMENT_NOT_ALLOWED', 409, jsonb_build_object('issued_invoice_id', v_id, 'status', v_inv->>'status', 'payment_status', v_inv->>'payment_status'));
  end if;
  select * into v_open from invoices.payment_links where issued_invoice_id = v_id and status = 'abierto';
  -- `attempt`: cuántos enlaces ha tenido la factura; da la clave de idempotencia del siguiente (un reintento del mismo
  -- intento devuelve la misma sesión; tras caducar o cancelarse, otra nueva).
  return jsonb_build_object('attempt', (select count(*) from invoices.payment_links where issued_invoice_id = v_id), 'invoice', v_inv, 'open', case when v_open.id is null then null else
    jsonb_build_object('id', v_open.id, 'url', v_open.url, 'provider', v_open.provider, 'provider_ref', v_open.provider_ref, 'amount', v_open.amount, 'expires_at', v_open.expires_at) end);
end $$;

-- save {issued_invoice_id, provider, provider_ref, url, amount, currency, expires_at, requested_by, requested_from}:
-- guarda el enlace recién creado en la pasarela. El importe tiene que ser el total de la factura.
create or replace function invoices.payment_link_save(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_inv jsonb; v_row invoices.payment_links;
begin
  v_inv := invoices.payment_link_invoice((a->>'issued_invoice_id')::uuid);
  if v_inv is null or not (v_inv->>'payable')::boolean then perform core.fail('PAYMENT_NOT_ALLOWED', 409, jsonb_build_object('issued_invoice_id', a->>'issued_invoice_id')); end if;
  if (a->>'amount')::numeric <> (v_inv->>'total')::numeric then perform core.fail('PAYMENT_AMOUNT_MISMATCH', 409, jsonb_build_object('expected', v_inv->'total', 'got', a->'amount')); end if;
  -- Si ya estaba (misma sesión por idempotencia), se devuelve tal cual
  select * into v_row from invoices.payment_links where provider = a->>'provider' and provider_ref = a->>'provider_ref';
  if v_row.id is null then
    update invoices.payment_links set status = 'cancelado', updated_at = now() where issued_invoice_id = (a->>'issued_invoice_id')::uuid and status = 'abierto';
    insert into invoices.payment_links (issued_invoice_id, provider, provider_ref, url, amount, currency, expires_at, requested_by, requested_from)
    values ((a->>'issued_invoice_id')::uuid, a->>'provider', a->>'provider_ref', a->>'url', (a->>'amount')::numeric, upper(coalesce(a->>'currency', 'EUR')),
            (a->>'expires_at')::timestamptz, nullif(a->>'requested_by', '')::uuid, coalesce(nullif(a->>'requested_from', ''), 'finance'))
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'url', v_row.url, 'provider', v_row.provider, 'provider_ref', v_row.provider_ref, 'amount', v_row.amount, 'expires_at', v_row.expires_at, 'status', v_row.status);
end $$;

-- close {provider, provider_ref, status: caducado | cancelado}: la sesión caducó o se canceló en la pasarela.
create or replace function invoices.payment_link_close(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_n int;
begin
  if a->>'status' not in ('caducado', 'cancelado') then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'status')); end if;
  update invoices.payment_links set status = a->>'status', updated_at = now() where provider = a->>'provider' and provider_ref = a->>'provider_ref' and status = 'abierto';
  get diagnostics v_n = row_count;
  return jsonb_build_object('closed', v_n);
end $$;

select core.allow_read('invoices', 'invoices.payment_link_prepare', 'action', '{}');
select core.allow_read('invoices', 'invoices.payment_link_save', 'action', '{}');
select core.allow_read('invoices', 'invoices.payment_link_close', 'action', '{}');

-- 4. Al anular, rectificar o cobrar a mano: los abiertos pasan a «cancelado». La Edge caduca después la sesión en la
-- pasarela (`payment_links_to_expire`); si alguien llegara a pagar, el aviso se registra como `mismatch` y se avisa.
create or replace function invoices.cancel_payment_links()
returns trigger language plpgsql as $$
begin
  if new.status in ('anulada', 'rectificada') or new.payment_status = 'cobrada' or new.deleted_at is not null then
    update invoices.payment_links set status = 'cancelado', updated_at = now() where issued_invoice_id = new.id and status = 'abierto';
  end if;
  return new;
end $$;
create trigger invoices_cancel_payment_links after update of status, payment_status, deleted_at on invoices.issued_invoices
  for each row execute function invoices.cancel_payment_links();

-- 5. Lecturas.
-- Los enlaces de una emitida (ficha de Finance): estado, caducidad, importe y URL; nunca nada de quien paga.
create or replace function invoices.payment_links_of(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'provider', l.provider, 'url', case when l.status = 'abierto' then l.url end,
      'amount', l.amount, 'currency', l.currency, 'status', case when l.status = 'abierto' and l.expires_at <= now() then 'caducado' else l.status end,
      'expires_at', l.expires_at, 'paid_at', l.paid_at, 'requested_from', l.requested_from, 'created_at', l.created_at) order by l.created_at desc), '[]'::jsonb))
    from invoices.payment_links l where l.issued_invoice_id = nullif(p->'args'->>'issued_invoice_id', '')::uuid;
$$;
select core.allow_read('invoices', 'invoices.payment_links_of', 'function', '{reader,editor,owner}');

-- F5 de Organizers: `portal_reservation_money` (0221) con `payment_link` en cada factura: el enlace abierto y vigente
-- ({url, provider, expires_at}) o null. Leer no crea nada: el enlace se crea al pulsar «Pagar ahora».
create or replace function invoices.portal_reservation_money(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid;
begin
  begin v_res := (p->'args'->>'reservation_id')::uuid; exception when others then v_res := null; end;
  if v_res is null or not core.portal_in_scope('organizers', (p->>'actor')::uuid, v_res) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id'));
  end if;
  return (
    with inv as (
      select i.* from invoices.issued_invoices i where i.id in (select invoices.portal_reservation_invoice_ids(v_res))
    )
    select jsonb_build_object(
      'reservation_id', v_res,
      'currency', 'EUR',
      'invoices', coalesce((select jsonb_agg(jsonb_build_object(
          'id', i.id, 'number', i.full_number, 'issue_date', i.issue_date, 'type', i.invoice_type, 'purpose', i.purpose,
          'rectifies', case when i.invoice_type like 'R%' then (select coalesce(jsonb_agg(x->>'full_number'), '[]'::jsonb) from jsonb_array_elements(i.rectified) x) end,
          'base', i.base_total, 'tax', i.quota_total + i.surcharge_total, 'withholding', i.withholding_total, 'total', i.total,
          'status', i.status, 'collected', i.payment_status = 'cobrada', 'collected_at', i.paid_at,
          'has_document', i.document is not null or exists (select 1 from invoices.issued_invoice_files f where f.issued_invoice_id = i.id and f.deleted_at is null),
          'payment_link', (select jsonb_build_object('url', l.url, 'provider', l.provider, 'expires_at', l.expires_at) from invoices.payment_links l
                            where l.issued_invoice_id = i.id and l.status = 'abierto' and l.expires_at > now() + interval '10 minutes' and i.payment_status = 'pendiente'))
        order by i.issue_date, i.full_number) from inv i), '[]'::jsonb),
      'totals', jsonb_build_object(
        'invoiced', coalesce((select sum(total) from inv where status <> 'anulada'), 0),
        'collected', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status = 'cobrada'), 0),
        'pending', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status <> 'cobrada'), 0)))
  );
end $$;

revoke all on function invoices.payment_link_invoice(uuid), invoices.payment_link_prepare(jsonb), invoices.payment_link_save(jsonb), invoices.payment_link_close(jsonb),
  invoices.cancel_payment_links(), invoices.payment_links_of(jsonb), invoices.portal_reservation_money(jsonb) from public, anon, authenticated;
