-- Finance · K2 de Organizers (27-10): el PDF guardado de una factura registrada, para el organizador de ese retiro.
--
-- Sin ruta nueva: el portal ya sirve `GET /api/v1/portal-files/:fileId` (C8, `_kit/handler.ts`) con una URL firmada de
-- 5 minutos si algún resolutor registrado para ese portal dice que sí. Este es el de Finance para `organizers`: el archivo
-- es uno de los `issued_invoice_files` vivos de una factura que el organizador ve en `portal_invoice_document` (F2), es
-- decir, de una reserva de su ámbito (`core.portal_in_scope`) y no borrador; y la persona es editora u owner del portal,
-- como en F2. Lo inexistente y lo de fuera responde igual (404 FILE_NOT_FOUND), sin decir qué archivos existen.

create or replace function invoices.portal_invoice_file(p jsonb)
returns boolean language sql stable as $$
  with f as (
    select x.issued_invoice_id from invoices.issued_invoice_files x
     where x.file_id = (p->>'file_id')::uuid and x.deleted_at is null),
  -- Reservas candidatas: las de la factura y, en una rectificativa, las de su original.
  cand as (
    select a.target_id from invoices.issued_allocations a
     where a.deleted_at is null and a.target_app = 'booking' and a.target_kind = 'reservation'
       and a.target_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and (a.issued_invoice_id in (select issued_invoice_id from f)
         or exists (select 1 from invoices.issued_invoices r join f on f.issued_invoice_id = r.id, jsonb_array_elements(coalesce(r.rectified, '[]'::jsonb)) o
                     where o->>'issued_invoice_id' = a.issued_invoice_id::text)))
  select p->>'portal' = 'organizers'
    and exists (select 1 from core.memberships m where m.app = 'organizers' and m.user_id = (p->>'actor')::uuid and m.role in ('editor', 'owner'))
    and exists (
      select 1 from cand c, f
       where core.portal_in_scope('organizers', (p->>'actor')::uuid, c.target_id::uuid)
         and f.issued_invoice_id in (select invoices.portal_reservation_invoice_ids(c.target_id::uuid)));
$$;

select core.allow_portal_file('organizers', 'invoices.portal_invoice_file');

revoke all on function invoices.portal_invoice_file(jsonb) from public, anon, authenticated;
