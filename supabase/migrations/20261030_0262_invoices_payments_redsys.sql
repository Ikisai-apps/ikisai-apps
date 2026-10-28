-- Finance · pagos en línea con Redsys (tarjeta y Bizum), detrás del interruptor `PAYMENTS_PROVIDER` (API.md §19.6).
-- Toca solo el schema invoices. El adaptador está en `_domain/payments/redsys.ts` (§19.5).
--
-- - `payment_links.gateway_form`: el formulario firmado que se manda a Redsys (Redsys no da URL de pago). El enlace que se
--   comparte es la página de paso de Finance (`public/payments/redsys/go/<pedido>`), que solo lo sirve si el enlace sigue
--   abierto y sin caducar. No lleva datos de quien paga: importe, pedido, URLs de vuelta y la firma.
-- - `payment_link_save` (de 0255) guarda el formulario; `payment_link_form` lo da a la página de paso.
-- - `payment_event_apply` (de 0259) con el medio del cobro (`tarjeta` o `bizum`).
-- - `payment_links_to_check` (de 0259) con la proveedora y la caducidad: Redsys no se pregunta, la caducidad la lleva Finance.

alter table invoices.payment_links add column gateway_form jsonb check (gateway_form is null or jsonb_typeof(gateway_form) = 'object');

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
    insert into invoices.payment_links (issued_invoice_id, provider, provider_ref, url, amount, currency, expires_at, requested_by, requested_from, gateway_form)
    values ((a->>'issued_invoice_id')::uuid, a->>'provider', a->>'provider_ref', a->>'url', (a->>'amount')::numeric, upper(coalesce(a->>'currency', 'EUR')),
            (a->>'expires_at')::timestamptz, nullif(a->>'requested_by', '')::uuid, coalesce(nullif(a->>'requested_from', ''), 'finance'), nullif(a->'form', 'null'::jsonb))
    returning * into v_row;
  end if;
  return jsonb_build_object('id', v_row.id, 'url', v_row.url, 'provider', v_row.provider, 'provider_ref', v_row.provider_ref, 'amount', v_row.amount, 'expires_at', v_row.expires_at, 'status', v_row.status);
end $$;

-- form {provider_ref}: el formulario de un enlace de Redsys, solo si sigue abierto y sin caducar.
create or replace function invoices.payment_link_form(p jsonb)
returns jsonb language sql stable as $$
  select coalesce((select jsonb_build_object('status', case when l.status = 'abierto' and l.expires_at <= now() then 'caducado' else l.status end,
      'form', case when l.status = 'abierto' and l.expires_at > now() then l.gateway_form end)
    from invoices.payment_links l where l.provider = 'redsys' and l.provider_ref = p->'args'->>'provider_ref'), jsonb_build_object('status', 'desconocido', 'form', null));
$$;

create or replace function invoices.payment_links_to_check(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('provider', l.provider, 'provider_ref', l.provider_ref, 'status', l.status, 'expires_at', l.expires_at) order by l.created_at), '[]'::jsonb))
    from (select * from invoices.payment_links
           where (status = 'abierto' or (status in ('cancelado', 'caducado') and gateway_closed_at is null and created_at > now() - interval '2 days'))
           order by created_at limit least(greatest(coalesce((p->'args'->>'limit')::int, 50), 1), 200)) l;
$$;

-- payment_event_apply (de 0259) con el medio: `method` = bizum con Redsys si se pagó con Bizum; si no, tarjeta.
create or replace function invoices.payment_event_apply(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args';
  v_provider text := coalesce(a->>'provider', 'stripe');
  v_link invoices.payment_links; v_inv invoices.issued_invoices; v_outcome text; v_detail text; v_paid_at timestamptz;
begin
  if coalesce(a->>'event_id', '') = '' or a->>'kind' not in ('paid', 'expired', 'refunded', 'failed', 'ignored') then
    perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'event_id/kind'));
  end if;
  if exists (select 1 from invoices.payment_events where provider = v_provider and provider_event_id = a->>'event_id') then
    return jsonb_build_object('outcome', 'duplicate');
  end if;
  select * into v_link from invoices.payment_links where provider = v_provider and provider_ref = a->>'provider_ref' for update;
  if v_link.id is null then
    v_outcome := case when a->>'kind' = 'ignored' then 'ignored' else 'unknown' end;
  elsif a->>'kind' = 'paid' then
    select * into v_inv from invoices.issued_invoices where id = v_link.issued_invoice_id for update;
    v_paid_at := coalesce((a->>'paid_at')::timestamptz, now());
    if v_link.status = 'pagado' then
      v_outcome := 'duplicate';
    elsif v_inv.deleted_at is not null or v_inv.status in ('anulada', 'rectificada', 'borrador') or v_inv.payment_status <> 'pendiente' then
      v_outcome := 'mismatch'; v_detail := 'La factura ya no estaba por cobrar (cobrada a mano, anulada o rectificada): revisa y devuelve si hace falta.';
    elsif round(v_inv.total * 100) <> (a->>'amount_cents')::bigint then
      v_outcome := 'mismatch'; v_detail := format('Importe pagado %s céntimos; la factura es de %s.', a->>'amount_cents', round(v_inv.total * 100));
    else
      -- El enlace primero (así el disparador de cobro no lo cancela) y luego la factura, como sistema.
      update invoices.payment_links set status = 'pagado', paid_at = v_paid_at, payment_ref = nullif(a->>'payment_ref', ''), updated_at = now() where id = v_link.id;
      perform core.apply_system_operations('invoices', jsonb_build_array(jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v_inv.id,
        'expectedRevision', v_inv.revision, 'fields', jsonb_build_object('payment_status', 'cobrada',
          'paid_at', (v_paid_at at time zone 'Europe/Madrid')::date, 'payment_method', case when a->>'method' = 'bizum' then 'bizum' else 'tarjeta' end))));
      v_outcome := 'applied';
    end if;
  elsif a->>'kind' = 'expired' then
    update invoices.payment_links set status = 'caducado', gateway_closed_at = coalesce(gateway_closed_at, now()), updated_at = now() where id = v_link.id and status = 'abierto';
    v_outcome := 'applied';
  else
    v_outcome := case when a->>'kind' = 'ignored' then 'ignored' else 'applied' end;
    if a->>'kind' = 'refunded' then v_detail := format('Devueltos %s céntimos en la pasarela: refléjalo con una rectificativa.', coalesce(a->>'refunded_cents', '?')); end if;
  end if;
  insert into invoices.payment_events (provider, provider_event_id, kind, provider_ref, payment_link_id, outcome, detail)
  values (v_provider, a->>'event_id', a->>'kind', a->>'provider_ref', v_link.id, v_outcome, left(v_detail, 300))
  on conflict (provider, provider_event_id) do nothing;
  return jsonb_build_object('outcome', v_outcome, 'payment_link_id', v_link.id, 'issued_invoice_id', v_link.issued_invoice_id);
end $$;

select core.allow_read('invoices', 'invoices.payment_link_form', 'action', '{}');
revoke all on function invoices.payment_link_save(jsonb), invoices.payment_link_form(jsonb), invoices.payment_links_to_check(jsonb),
  invoices.payment_event_apply(jsonb) from public, anon, authenticated;
