-- Invoices · tanda 41: dos cosas que pide Food para la Compra con el envase (MUELA-093, #700). Toca solo el schema
-- invoices; de resources solo lee.
--
-- 1. H-C5: al cambiar la cantidad de una línea ya comprada, Food apunta la diferencia con la misma referencia
--    `shopping_item:<id>` (una `entrada_manual` más o una `salida_manual` de corrección). Hasta ahora Finance solo costeaba
--    la entrada enlazada (`invoice_lines.entered_movement_id`, 0237) y la diferencia se quedaba sin coste. Ahora, al cuadrar,
--    se costean todas las entradas vivas de esa referencia: el importe de la línea entre la cantidad que entró, con las
--    salidas de corrección restando. Las entradas ya costeadas no se tocan (un coste solo se añade, 0803): lo que falta se
--    reparte entre las que no lo tienen. Cuadrar dos veces no duplica nada.
--    Solo cambia `invoices.resource_entries` (0238); lo de Tasks y lo demás sigue igual.
-- 2. `invoices.food_stock_projection` (0230) con `item_id` e `item_factor` de la línea, para «Como en el último ticket»
--    (el último envase comprado de cada artículo). Sin datos personales: el proveedor es una empresa.

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
  -- «Ya entró desde Food» (0237) con H-C5: todas las entradas y salidas vivas de Food con la referencia de la entrada
  -- enlazada (`shopping_item:<id>`), del mismo artículo. Una línea por referencia (la primera, si hubiera varias).
  food_ref as (
    select distinct on (m.source_ref) l.id as line_id, l.net_amount, m.source_ref, m.item_id
      from lines l join resources.movements m on m.id = l.entered_movement_id
     where l.counts and l.entered_movement_id is not null and m.source_app = 'food' and m.source_ref is not null
     order by m.source_ref, l.id),
  food_moves as (
    select f.line_id, f.net_amount, m.id as movement_id, m.quantity,
           (m.unit_cost is not null or exists (select 1 from resources.movement_costs c where c.movement_id = m.id and c.deleted_at is null)) as costed,
           coalesce(m.unit_cost, (select c.unit_cost from resources.movement_costs c where c.movement_id = m.id and c.deleted_at is null)) as cost
      from food_ref f
      join resources.movements m on m.source_app = 'food' and m.source_ref = f.source_ref and m.item_id = f.item_id and m.deleted_at is null
     where (m.kind = 'entrada_manual' and m.quantity > 0) or (m.kind = 'salida_manual' and m.quantity < 0)),
  -- El importe de la línea se reparte entre lo que entró, con las salidas de corrección restando (N = entradas − salidas).
  -- El coste medio (`resources.item_costs`) solo mira las entradas, así que su valor tiene que ser importe × P / N
  -- (P = lo que entró). Las ya costeadas no se tocan (un coste solo se añade); a las que no lo tienen les toca lo que
  -- falta, a partes iguales por unidad. La primera vez es el importe entre N; cuadrar otra vez no cambia nada.
  food_rate as (
    select fm.line_id,
           greatest(0, max(fm.net_amount) * sum(fm.quantity) filter (where fm.quantity > 0) / nullif(sum(fm.quantity), 0)
                       - coalesce(sum(fm.quantity * fm.cost) filter (where fm.quantity > 0 and fm.costed), 0)) as rest,
           sum(fm.quantity) filter (where fm.quantity > 0 and not fm.costed) as open_qty,
           sum(fm.quantity) as net_qty
      from food_moves fm group by fm.line_id),
  costed as (
    select fm.line_id as id, fm.movement_id as entered_movement_id, round(fr.rest / fr.open_qty, 6) as unit_cost
      from food_moves fm join food_rate fr on fr.line_id = fm.line_id
     where fm.quantity > 0 and not fm.costed and fr.open_qty > 0 and fr.net_qty > 0
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

-- Proyección de stock para Food (de 0230), con el artículo y su factor al final.
create or replace view invoices.food_stock_projection as
  select a.id as allocation_id, a.target_kind, a.target_id, i.code as invoice_code, i.invoice_date, s.name as supplier_name,
         coalesce(l.label, l.description) as line_description, l.match_name, a.allocated_quantity, l.unit, a.allocated_amount, a.revision as allocation_revision,
         nu.unit as unit_normalized, round(a.allocated_quantity * nu.factor, 4) as quantity_normalized,
         l.item_id, l.item_factor
  from invoices.allocations a
  join invoices.invoice_lines l on l.id = a.invoice_line_id
  join invoices.invoices i on i.id = a.invoice_id
  join invoices.suppliers s on s.id = i.supplier_id
  cross join lateral invoices.normalize_unit(l.unit) nu
  where a.deleted_at is null and l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'food';
