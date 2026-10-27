-- Finance · «Cobros sin casar» para Dirección (cola de Core, 27-10; API.md §19.7). Toca solo el schema invoices.
--
-- Lo que la pasarela cobró o devolvió y Finance no pudo casar sola con una factura (avisos de `payment_event_apply`):
-- - `mismatch`: el pago llegó pero la factura ya no estaba por cobrar (cobrada a mano, anulada, rectificada) o el importe
--   no coincide → hay que devolverlo o ajustar;
-- - `unknown`: un pago de un enlace que Finance no conoce;
-- - `refunded`: una devolución hecha en la pasarela → su rectificativa.
-- Quien revisa lo marca «revisado» con una nota (qué hizo). Sin datos de quien paga.

alter table invoices.payment_events
  add column reviewed_at timestamptz,
  add column reviewed_by uuid,
  add column review_note text check (review_note is null or length(review_note) <= 500);

-- Lista para la pantalla (editor u owner): por defecto, solo lo pendiente de revisar; `all` = también lo revisado.
create or replace function invoices.payment_events_review(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'at', e.created_at, 'provider', e.provider, 'kind', e.kind, 'outcome', e.outcome, 'detail', e.detail,
      'amount', l.amount, 'issued_invoice_id', l.issued_invoice_id, 'invoice_number', i.full_number, 'invoice_total', i.total,
      'invoice_status', i.status, 'payment_status', i.payment_status,
      'reviewed_at', e.reviewed_at, 'review_note', e.review_note) order by e.reviewed_at is not null, e.created_at desc), '[]'::jsonb),
    'pending', (select count(*) from invoices.payment_events x where (x.outcome in ('mismatch', 'unknown') or x.kind = 'refunded') and x.reviewed_at is null))
    from invoices.payment_events e
    left join invoices.payment_links l on l.id = e.payment_link_id
    left join invoices.issued_invoices i on i.id = l.issued_invoice_id
   where (e.outcome in ('mismatch', 'unknown') or e.kind = 'refunded')
     and (coalesce((p->'args'->>'all')::boolean, false) or e.reviewed_at is null);
$$;

-- payment_event_resolve {id, note}: marcar revisado (editor u owner). La nota dice qué se hizo («devuelto en Stripe»,
-- «rectificativa R2026-0003»…). Volver a marcarlo cambia la nota.
create or replace function invoices.payment_event_resolve(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_note text := btrim(coalesce(a->>'note', '')); v_id uuid; v_n int;
begin
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('procedure', 'invoices.payment_event_resolve')); end if;
  begin v_id := (a->>'id')::uuid; exception when others then v_id := null; end;
  if v_note = '' or length(v_note) > 500 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'note')); end if;
  update invoices.payment_events set reviewed_at = now(), reviewed_by = nullif(p->>'actor', '')::uuid, review_note = v_note, updated_at = now()
   where id = v_id and (outcome in ('mismatch', 'unknown') or kind = 'refunded');
  get diagnostics v_n = row_count;
  if v_n = 0 then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.payment_events', 'id', a->>'id')); end if;
  return jsonb_build_object('id', v_id, 'reviewed', true);
end $$;
select core.allow_procedure('invoices', 'invoices.payment_event_resolve');

revoke all on function invoices.payment_events_review(jsonb), invoices.payment_event_resolve(jsonb) from public, anon, authenticated;
