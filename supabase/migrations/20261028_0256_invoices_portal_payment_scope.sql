-- Finance · pagos en línea desde el portal del organizador (finance-18, PR 3; F5 de Organizers, acordado el 27-10).
-- Toca solo el schema invoices.
--
-- «Pagar ahora» en Organizers: si la factura no trae `payment_link` (o caducó), el servidor de Organizers pide uno a
-- Finance (`POST invoices-api/api/v1/worker/payment-links/portal`, clave de worker + `X-Ikisai-Caller: organizers`) en
-- nombre del organizador. Antes de crear nada, esta acción de sistema comprueba lo mismo que F2: que la persona es
-- editora u owner del portal, que la reserva es de su ámbito (`core.portal_in_scope`) y que la factura es de esa reserva.
-- Lo de fuera responde igual que lo inexistente (403 OUT_OF_SCOPE).

create or replace function invoices.portal_payment_scope(p jsonb)
returns jsonb language plpgsql stable as $$
declare a jsonb := p->'args'; v_actor uuid; v_res uuid; v_inv uuid;
begin
  begin
    v_actor := (a->>'actor')::uuid; v_res := (a->>'reservation_id')::uuid; v_inv := (a->>'issued_invoice_id')::uuid;
  exception when others then v_actor := null; end;
  if v_actor is null or v_res is null or v_inv is null
     or not exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = v_actor and m.role in ('editor', 'owner'))
     or not core.portal_in_scope('organizers', v_actor, v_res)
     or v_inv not in (select invoices.portal_reservation_invoice_ids(v_res)) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', a->>'reservation_id', 'issued_invoice_id', a->>'issued_invoice_id'));
  end if;
  return jsonb_build_object('ok', true);
end $$;
select core.allow_read('invoices', 'invoices.portal_payment_scope', 'action', '{}');

revoke all on function invoices.portal_payment_scope(jsonb) from public, anon, authenticated;
