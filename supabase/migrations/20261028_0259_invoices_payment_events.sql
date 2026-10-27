-- Finance · pagos en línea: aviso de la pasarela y conciliación (finance-18, PR 4). Toca solo el schema invoices.
--
-- El webhook de Stripe (`POST invoices-api/api/v1/public/payments/stripe`, firma comprobada en la Edge) y la
-- conciliación horaria (`worker/payments/reconcile`) llaman a `invoices.payment_event_apply` como sistema:
-- - idempotente por evento (`payment_events`, único por proveedor e id);
-- - `paid`: si el enlace existe, la factura sigue cobrable y el importe coincide, el enlace pasa a `pagado` y la factura a
--   `cobrada` (fecha del pago en Madrid, medio «tarjeta») por `core.apply_system_operations` con «Finance (sistema)»
--   (núcleo 0112), con historial y sincronización como cualquier cambio. Si no cuadra (ya cobrada a mano, anulada,
--   enlace cancelado, otro importe), no toca la factura: queda `mismatch` para revisarlo en Finance;
-- - `expired`: el enlace pasa a `caducado`; `refunded` y `failed`: se registran (una devolución se refleja con su
--   rectificativa, como hoy).
-- Los enlaces cancelados se caducan también en la pasarela (`gateway_closed_at`), para que nadie pague uno cancelado.

alter table invoices.payment_links add column gateway_closed_at timestamptz;

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
          'paid_at', (v_paid_at at time zone 'Europe/Madrid')::date, 'payment_method', 'tarjeta'))));
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

-- Para la conciliación: los enlaces abiertos y los cancelados o caducados aún sin cerrar en la pasarela.
create or replace function invoices.payment_links_to_check(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('provider', l.provider, 'provider_ref', l.provider_ref, 'status', l.status) order by l.created_at), '[]'::jsonb))
    from (select * from invoices.payment_links
           where (status = 'abierto' or (status in ('cancelado', 'caducado') and gateway_closed_at is null and created_at > now() - interval '2 days'))
           order by created_at limit least(greatest(coalesce((p->'args'->>'limit')::int, 50), 1), 200)) l;
$$;

-- La pasarela ya tiene cerrada la sesión de un enlace cancelado o caducado.
create or replace function invoices.payment_link_gateway_closed(p jsonb)
returns jsonb language sql as $$
  update invoices.payment_links set gateway_closed_at = coalesce(gateway_closed_at, now()),
         status = case when status = 'abierto' then 'caducado' else status end, updated_at = now()
   where provider = p->'args'->>'provider' and provider_ref = p->'args'->>'provider_ref'
  returning jsonb_build_object('status', status);
$$;

-- Avisos que no cuadraron (para revisarlos en Finance): sin datos de quien paga.
create or replace function invoices.payment_events_review(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('at', e.created_at, 'kind', e.kind, 'outcome', e.outcome, 'detail', e.detail,
      'issued_invoice_id', l.issued_invoice_id) order by e.created_at desc), '[]'::jsonb))
    from invoices.payment_events e left join invoices.payment_links l on l.id = e.payment_link_id
   where e.outcome in ('mismatch', 'unknown') or e.kind = 'refunded';
$$;

select core.allow_read('invoices', 'invoices.payment_event_apply', 'action', '{}');
select core.allow_read('invoices', 'invoices.payment_links_to_check', 'action', '{}');
select core.allow_read('invoices', 'invoices.payment_link_gateway_closed', 'action', '{}');
select core.allow_read('invoices', 'invoices.payment_events_review', 'function', '{editor,owner}');

-- Conciliación cada hora, solo si hay algo que mirar.
create or replace function invoices.payments_have_work()
returns boolean language sql stable as $$
  select exists (select 1 from invoices.payment_links
                  where status = 'abierto' or (status in ('cancelado', 'caducado') and gateway_closed_at is null and created_at > now() - interval '2 days'));
$$;
select core.schedule_tick('invoices', 'payments/reconcile', '17 * * * *', 'invoices.payments_have_work');

revoke all on function invoices.payment_event_apply(jsonb), invoices.payment_links_to_check(jsonb), invoices.payment_link_gateway_closed(jsonb),
  invoices.payment_events_review(jsonb), invoices.payments_have_work() from public, anon, authenticated;
