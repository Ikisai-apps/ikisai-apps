-- Invoices · dinero del retiro para el portal de organizadores (fase 3 de los portales, F1 y F2 de
-- docs/organizers/PETICIONES.md). Toca solo el schema invoices.
--
-- Solo lectura, filtrada por el ámbito del enlace con core.portal_in_scope (K1). Una factura es «del retiro» si su ingreso
-- está asignado a esa reserva de Booking, o si es una rectificativa emitida de una de ellas. Nunca salen borradores ni
-- datos internos (notas, revisión de importes, categoría de ingreso, herramienta de origen, registro VERI*FACTU).
-- Fuera de ámbito o con un id inválido, la misma respuesta: OUT_OF_SCOPE.
--
-- F1 · invoices.portal_reservation_money {reservation_id}
-- F2 · invoices.portal_invoice_document {reservation_id, issued_invoice_id}: la copia congelada de la factura emitida
--      desde Finance (para imprimirla o guardarla en PDF desde el portal) y los PDF guardados de las registradas. Firmar
--      la URL de un PDF guardado lo hace la Edge que sirve el portal (no se puede desde SQL).

-- Ids de las facturas del retiro: asignadas a la reserva y sus rectificativas (sin borradores).
create or replace function invoices.portal_reservation_invoice_ids(p_reservation uuid)
returns setof uuid language sql stable as $$
  with direct as (
    select distinct i.id
      from invoices.issued_invoices i
      join invoices.issued_allocations a on a.issued_invoice_id = i.id and a.deleted_at is null
     where a.target_app = 'booking' and a.target_kind = 'reservation' and a.target_id = p_reservation::text
       and i.deleted_at is null and i.status <> 'borrador')
  select id from direct
  union
  select r.id from invoices.issued_invoices r
   where r.deleted_at is null and r.status <> 'borrador' and r.invoice_type like 'R%'
     and exists (select 1 from jsonb_array_elements(r.rectified) x join direct d on (x->>'issued_invoice_id') = d.id::text);
$$;

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
          'id', i.id, 'number', i.full_number, 'issue_date', i.issue_date, 'type', i.invoice_type,
          'rectifies', case when i.invoice_type like 'R%' then (select coalesce(jsonb_agg(x->>'full_number'), '[]'::jsonb) from jsonb_array_elements(i.rectified) x) end,
          'base', i.base_total, 'tax', i.quota_total + i.surcharge_total, 'withholding', i.withholding_total, 'total', i.total,
          'status', i.status, 'collected', i.payment_status = 'cobrada', 'collected_at', i.paid_at,
          'has_document', i.document is not null or exists (select 1 from invoices.issued_invoice_files f where f.issued_invoice_id = i.id and f.deleted_at is null))
        order by i.issue_date, i.full_number) from inv i), '[]'::jsonb),
      'totals', jsonb_build_object(
        'invoiced', coalesce((select sum(total) from inv where status <> 'anulada'), 0),
        'collected', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status = 'cobrada'), 0),
        'pending', coalesce((select sum(total) from inv where status <> 'anulada' and payment_status <> 'cobrada'), 0)))
  );
end $$;
select core.allow_read('organizers', 'invoices.portal_reservation_money', 'function', '{editor,owner}');

create or replace function invoices.portal_invoice_document(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_res uuid; v_inv uuid; i invoices.issued_invoices;
begin
  begin
    v_res := (p->'args'->>'reservation_id')::uuid;
    v_inv := (p->'args'->>'issued_invoice_id')::uuid;
  exception when others then v_res := null; end;
  if v_res is null or v_inv is null or not core.portal_in_scope('organizers', (p->>'actor')::uuid, v_res)
     or v_inv not in (select invoices.portal_reservation_invoice_ids(v_res)) then
    perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', p->'args'->>'reservation_id', 'issued_invoice_id', p->'args'->>'issued_invoice_id'));
  end if;
  select * into i from invoices.issued_invoices where id = v_inv;
  return jsonb_build_object(
    'id', i.id, 'number', i.full_number, 'issue_date', i.issue_date, 'status', i.status,
    -- Emitida desde Finance: la copia congelada (emisor, destinatario, líneas, desglose y totales), igual que se imprimió.
    'document', i.document,
    -- Registrada de otra herramienta: sus PDF guardados (la Edge del portal firma la URL con core.files).
    'files', coalesce((select jsonb_agg(jsonb_build_object('file_id', f.file_id, 'filename', f.normalized_filename, 'mime', f.mime_type, 'size', f.size_bytes) order by f.page_order)
      from invoices.issued_invoice_files f where f.issued_invoice_id = i.id and f.deleted_at is null), '[]'::jsonb));
end $$;
select core.allow_read('organizers', 'invoices.portal_invoice_document', 'function', '{editor,owner}');

revoke all on function invoices.portal_reservation_invoice_ids(uuid), invoices.portal_reservation_money(jsonb), invoices.portal_invoice_document(jsonb)
  from public, anon, authenticated;
