-- Invoices · R4, PR 3: «Ya entró desde la compra de Food» (decisión del usuario del 14-10-2026, respuestas de Core). Toca
-- solo el schema invoices; de resources solo lee.
--
-- Lo comprado desde la lista de Food entra al stock en ese momento, sin coste (`entrada_manual`, `source_app = 'food'`).
-- Si una línea de factura corresponde a esa compra, no se cuenta dos veces:
-- - `invoice_lines.entered_movement_id`: la entrada de Food que ya metió ese artículo;
-- - esa línea no pide entrada propia (`resource_entries` la deja a 0);
-- - al validar, `resource_entries` devuelve en `costs` el coste por unidad base para esa entrada, si aún no lo tiene, y la
--   Edge lo añade con `resources.movement_costs` (0803). Un coste solo se añade: anular la factura después no lo quita.
-- - Comprobación (`INVALID_RESOURCE_LINK`): la entrada existe, es una `entrada_manual` positiva de Food y es del mismo
--   artículo que la línea.

alter table invoices.invoice_lines add column entered_movement_id uuid;

select core.register_table('invoices', 'invoices', 'invoice_lines', array[
  'invoice_id','position','description','quantity','unit','unit_price','discount_amount','net_amount','vat_rate','vat_amount','gross_amount',
  'item_type','match_name','expense_category','is_investment','confidence','notes','rectifies_line_id','label',
  'item_id','item_factor','space_id','entered_movement_id'], '{reader,editor,owner}', '{editor,owner}', true);

-- Cambiar solo el enlace (también «ya entró») no devuelve una validada a revisión.
create or replace function invoices.label_only_change(p_op text, p_before jsonb, p_after jsonb)
returns boolean language sql immutable as $$
  select p_op = 'update' and p_before is not null and p_after is not null
     and (p_before - array['label', 'label_source', 'item_id', 'item_factor', 'space_id', 'item_source', 'entered_movement_id', 'revision', 'updated_at', 'updated_by'])
       = (p_after - array['label', 'label_source', 'item_id', 'item_factor', 'space_id', 'item_source', 'entered_movement_id', 'revision', 'updated_at', 'updated_by']);
$$;

create or replace function invoices.check_resource_links(p jsonb)
returns void language plpgsql as $$
declare v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; r record;
begin
  for r in
    select li.id, li.item_id, li.space_id, li.entered_movement_id from invoices.invoice_lines li
     where li.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices'
                       and ch.table_name = 'invoice_lines' and ch.op in ('insert', 'update'))
       and li.deleted_at is null and (li.item_id is not null or li.space_id is not null or li.entered_movement_id is not null)
  loop
    if r.item_id is not null and not exists (select 1 from resources.items it where it.id = r.item_id and it.deleted_at is null) then
      perform core.fail('INVALID_RESOURCE_LINK', 422, jsonb_build_object('lineId', r.id, 'itemId', r.item_id, 'reason', 'item not found'));
    end if;
    if r.space_id is not null and not exists (select 1 from resources.spaces s where s.id = r.space_id and s.deleted_at is null and s.active) then
      perform core.fail('INVALID_RESOURCE_LINK', 422, jsonb_build_object('lineId', r.id, 'spaceId', r.space_id, 'reason', 'space not found'));
    end if;
    if r.entered_movement_id is not null and not exists (
         select 1 from resources.movements m where m.id = r.entered_movement_id and m.deleted_at is null and m.kind = 'entrada_manual'
            and m.source_app = 'food' and m.quantity > 0 and m.item_id = r.item_id) then
      perform core.fail('INVALID_RESOURCE_LINK', 422, jsonb_build_object('lineId', r.id, 'movementId', r.entered_movement_id, 'reason', 'not a food entry of this item'));
    end if;
  end loop;
  if exists (select 1 from core.changes ch join invoices.settings s on s.id = ch.row_id
              where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'settings'
                and s.deleted_at is null and jsonb_typeof(s.value) <> 'boolean') then
    perform core.fail('INVALID_SETTING', 422, jsonb_build_object('reason', 'resources_links is true or false'));
  end if;
end $$;

-- resource_entries (0235) con «ya entró»: esas líneas no piden entrada y dan su coste a la entrada de Food.
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
  returned as (
    select r.rectifies_line_id as line_id, sum(abs(r.quantity)) as qty
      from invoices.invoice_lines r join invoices.invoices ri on ri.id = r.invoice_id
     where r.rectifies_line_id in (select id from lines) and r.deleted_at is null and ri.deleted_at is null
       and ri.status in ('validada', 'archivada') and r.quantity is not null
     group by 1),
  wanted as (
    select l.*, l.quantity * coalesce(l.item_factor, 1) as own,
           greatest(0, l.quantity - coalesce(rt.qty, 0)) * coalesce(l.item_factor, 1) as qty
      from lines l left join returned rt on rt.line_id = l.id
     where l.counts and l.entered_movement_id is null),
  costed as (
    select l.id, l.entered_movement_id, round(l.net_amount / (l.quantity * coalesce(l.item_factor, 1)), 6) as unit_cost
      from lines l
     where l.counts and l.entered_movement_id is not null and l.quantity > 0
       and exists (select 1 from resources.movements m where m.id = l.entered_movement_id and m.deleted_at is null and m.unit_cost is null)
       and not exists (select 1 from resources.movement_costs c where c.movement_id = l.entered_movement_id and c.deleted_at is null)),
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
