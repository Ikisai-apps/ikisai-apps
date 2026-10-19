-- Invoices · R4, PR 5: no duplicar en el inventario las compras recibidas en Tasks (RESPUESTAS de Core del 19-10-2026).
-- Toca solo el schema invoices; de resources solo lee.
--
-- Tasks (R6, 0333) apunta en Recursos una `entrada_manual` al marcar una solicitud como «Recibida»
-- (`source_app 'tasks'`, `source_ref 'purchase_request:<id>'`, el `item_id` de la solicitud). Si una línea validada y
-- enlazada está asignada (`allocations`, destino `tasks/purchase_request`) a esa solicitud y es del mismo artículo:
-- - la línea pide solo lo que no entró ya por la solicitud: cantidad − rectificado − recibido (nunca menos de 0);
-- - si una solicitud cubre varias líneas, lo recibido se reparte por orden (fecha de la factura, factura, posición);
-- - si la entrada de Tasks entró sin coste, `costs` le da el de la factura (lo añade la Edge con `movement_costs`,
--   como «ya entró desde Food»). Un coste solo se añade: anular la factura después no lo quita, pero sí su entrada.
-- Solo cambia `invoices.resource_entries` (0237); con el interruptor apagado sigue sin devolver nada.

create or replace function invoices.resource_entries(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  if not invoices.resources_links() then
    return jsonb_build_object('source_app', 'invoices', 'entries', '[]'::jsonb, 'refs', '[]'::jsonb, 'skipped', '[]'::jsonb, 'costs', '[]'::jsonb);
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(coalesce(p->'args'->'invoice_ids', '[]'::jsonb)) x
   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  v_ids := v_ids || coalesce((select array_agg(distinct i.rectifies_invoice_id) from invoices.invoices i
                               where i.id = any(v_ids) and i.rectifies_invoice_id is not null), '{}');
  with lines as (
    select li.id, li.item_id, li.item_factor, li.quantity, li.net_amount, li.deleted_at, li.rectifies_line_id, li.entered_movement_id,
           coalesce(li.space_id, it.default_space_id) as space_id, i.status, i.invoice_date,
           (li.deleted_at is null and li.item_id is not null and it.id is not null and i.deleted_at is null
            and i.status in ('validada', 'archivada') and li.rectifies_line_id is null and li.net_amount > 0) as counts
      from invoices.invoice_lines li
      join invoices.invoices i on i.id = li.invoice_id
      left join resources.items it on it.id = li.item_id and it.deleted_at is null
     where li.invoice_id = any(v_ids)),
  -- Lo devuelto por rectificativas validadas, por línea original (de cualquier factura: sirve también al reparto).
  returned as (
    select r.rectifies_line_id as line_id, sum(abs(r.quantity)) as qty
      from invoices.invoice_lines r join invoices.invoices ri on ri.id = r.invoice_id
     where r.rectifies_line_id is not null and r.deleted_at is null and ri.deleted_at is null
       and ri.status in ('validada', 'archivada') and r.quantity is not null
     group by 1),
  -- Entradas de Tasks de las solicitudes a las que están asignadas estas líneas (una por solicitud).
  receipts as (
    select m.id as movement_id, m.item_id, m.quantity, m.unit_cost, substr(m.source_ref, length('purchase_request:') + 1) as request_id,
           exists (select 1 from resources.movement_costs c where c.movement_id = m.id and c.deleted_at is null) as costed
      from resources.movements m
     where m.source_app = 'tasks' and m.kind = 'entrada_manual' and m.deleted_at is null and m.quantity > 0
       and m.source_ref in (select 'purchase_request:' || a.target_id from invoices.allocations a join lines l on l.id = a.invoice_line_id
                             where a.deleted_at is null and a.target_app = 'tasks' and a.target_kind = 'purchase_request' and l.counts)),
  -- Todas las líneas que cuentan (de cualquier factura) asignadas a esas solicitudes, del mismo artículo.
  cover as (
    select distinct on (rc.movement_id, li.id) rc.movement_id, rc.quantity as received, li.id as line_id, li.net_amount,
           li.quantity * coalesce(li.item_factor, 1) as own,
           greatest(0, li.quantity - coalesce(rt.qty, 0)) * coalesce(li.item_factor, 1) as base,
           i.invoice_date, i.id as invoice_id, li.position
      from receipts rc
      join invoices.allocations a on a.target_app = 'tasks' and a.target_kind = 'purchase_request' and a.target_id = rc.request_id and a.deleted_at is null
      join invoices.invoice_lines li on li.id = a.invoice_line_id and li.item_id = rc.item_id and li.deleted_at is null
           and li.rectifies_line_id is null and li.net_amount > 0 and li.entered_movement_id is null and li.quantity > 0
      join invoices.invoices i on i.id = li.invoice_id and i.deleted_at is null and i.status in ('validada', 'archivada')
      left join returned rt on rt.line_id = li.id
     order by rc.movement_id, li.id),
  -- Lo recibido se reparte por orden entre las líneas que lo cubren.
  shares as (
    select c.*, least(c.base, greatest(0, c.received - coalesce(sum(c.base) over (partition by c.movement_id
             order by c.invoice_date, c.invoice_id, c.position, c.line_id rows between unbounded preceding and 1 preceding), 0))) as take
      from cover c),
  taken as (select s.line_id, sum(s.take) as qty from shares s group by 1),
  wanted as (
    select l.*, l.quantity * coalesce(l.item_factor, 1) as own,
           greatest(0, greatest(0, l.quantity - coalesce(rt.qty, 0)) * coalesce(l.item_factor, 1) - coalesce(tk.qty, 0)) as qty
      from lines l left join returned rt on rt.line_id = l.id left join taken tk on tk.line_id = l.id
     where l.counts and l.entered_movement_id is null),
  costed as (
    select l.id, l.entered_movement_id, round(l.net_amount / (l.quantity * coalesce(l.item_factor, 1)), 6) as unit_cost
      from lines l
     where l.counts and l.entered_movement_id is not null and l.quantity > 0
       and exists (select 1 from resources.movements m where m.id = l.entered_movement_id and m.deleted_at is null and m.unit_cost is null)
       and not exists (select 1 from resources.movement_costs c where c.movement_id = l.entered_movement_id and c.deleted_at is null)
    union all
    -- La entrada de Tasks sin coste toma el de la primera línea que la cubre (si es de estas facturas).
    select f.line_id, f.movement_id, round(f.net_amount / f.own, 6)
      from (select distinct on (s.movement_id) s.* from shares s where s.take > 0
             order by s.movement_id, s.invoice_date, s.invoice_id, s.position, s.line_id) f
      join receipts rc on rc.movement_id = f.movement_id
     where rc.unit_cost is null and not rc.costed and f.line_id in (select id from lines)),
  had as (
    select distinct m.source_ref from resources.movements m
     where m.source_app = 'invoices' and m.kind = 'entrada_factura' and m.deleted_at is null
       and m.source_ref in (select 'invoice_line:' || id from lines))
  select jsonb_build_object(
    'source_app', 'invoices',
    'entries', coalesce((select jsonb_agg(jsonb_build_object('source_ref', 'invoice_line:' || w.id, 'item_id', w.item_id, 'space_id', w.space_id,
                          'quantity', w.qty, 'unit_cost', round(w.net_amount / w.own, 6), 'at', (w.invoice_date + time '12:00') at time zone 'Europe/Madrid') order by w.id)
                          from wanted w where w.quantity > 0 and w.space_id is not null), '[]'::jsonb),
    'refs', coalesce((select jsonb_agg(h.source_ref order by h.source_ref) from had h), '[]'::jsonb),
    'skipped', coalesce((select jsonb_agg(jsonb_build_object('line_id', w.id, 'reason', case when w.quantity is null or w.quantity <= 0 then 'sin_cantidad' else 'sin_sitio' end) order by w.id)
                          from wanted w where w.quantity is null or w.quantity <= 0 or w.space_id is null), '[]'::jsonb),
    'costs', coalesce((select jsonb_agg(jsonb_build_object('movement_id', c.entered_movement_id, 'unit_cost', c.unit_cost, 'source_ref', 'invoice_line:' || c.id) order by c.id)
                        from costed c), '[]'::jsonb))
  into v_out;
  return v_out;
end $$;
