-- Invoices · R4, PR 2: lo que debe tener en Recursos cada línea enlazada (coordinacion/invoices/R4_PREPARACION.md §2.2;
-- respuestas de Core del 14-10-2026). Toca solo el schema invoices; de resources solo lee.
--
-- `invoices.resource_entries` (lectura) devuelve los argumentos de `resources.reconcile_entries` (0804) para las facturas
-- dadas y las que rectifican. La Edge lo lee tras cada commit que toca facturas o líneas y lo manda en un lote de
-- Recursos; el procedimiento crea solo la diferencia, así que repetirlo cuadra.
--
-- Por línea (`source_ref = 'invoice_line:<id>'`):
-- - le toca `quantity × item_factor` (null = 1) si está viva, enlazada, con cantidad e importe positivos y su factura está
--   validada o archivada; si no, 0 (vuelta a revisión, anulación, línea borrada o desenlazada: sale el contrario);
-- - lo devuelto por las rectificativas validadas que la rectifican (`rectifies_line_id`) se resta de la original: las
--   líneas de una rectificativa no tienen entrada propia, porque `reconcile_entries` no admite cantidades negativas;
-- - coste por unidad base = importe sin IVA / cantidad en base; sitio = el de la línea o el habitual del artículo; fecha =
--   la de la factura (a mediodía en Madrid, para que no cambie de día en ninguna zona horaria);
-- - una línea que debería entrar pero no tiene cantidad o sitio se aparta en `skipped`, con el motivo, y no bloquea nada.
-- Con el interruptor `resources_links` apagado no devuelve nada.

create or replace function invoices.resource_entries(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_ids uuid[];
  v_out jsonb;
begin
  if not invoices.resources_links() then
    return jsonb_build_object('source_app', 'invoices', 'entries', '[]'::jsonb, 'refs', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  select coalesce(array_agg(distinct x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(coalesce(p->'args'->'invoice_ids', '[]'::jsonb)) x
   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  -- Las originales de las rectificativas tocadas
  v_ids := v_ids || coalesce((select array_agg(distinct i.rectifies_invoice_id) from invoices.invoices i
                               where i.id = any(v_ids) and i.rectifies_invoice_id is not null), '{}');
  with lines as (
    select li.id, li.item_id, li.item_factor, li.quantity, li.net_amount, li.deleted_at, li.rectifies_line_id,
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
     where l.counts),
  had as (
    select distinct m.source_ref from resources.movements m
     where m.source_app = 'invoices' and m.kind = 'entrada_factura' and m.deleted_at is null
       and m.source_ref in (select 'invoice_line:' || id from lines))
  select jsonb_build_object(
    'source_app', 'invoices',
    'entries', coalesce((select jsonb_agg(jsonb_build_object('source_ref', 'invoice_line:' || w.id, 'item_id', w.item_id, 'space_id', w.space_id,
                          'quantity', w.qty, 'unit_cost', round(w.net_amount / w.own, 6), 'at', (w.invoice_date + time '12:00') at time zone 'Europe/Madrid') order by w.id)
                          from wanted w where w.quantity > 0 and w.space_id is not null), '[]'::jsonb),
    -- Las líneas que tienen o han tenido entrada: sin entrada pedida, quedan a 0
    'refs', coalesce((select jsonb_agg(h.source_ref order by h.source_ref) from had h), '[]'::jsonb),
    'skipped', coalesce((select jsonb_agg(jsonb_build_object('line_id', w.id, 'reason', case when w.quantity is null or w.quantity <= 0 then 'sin_cantidad' else 'sin_sitio' end) order by w.id)
                          from wanted w where w.quantity is null or w.quantity <= 0 or w.space_id is null), '[]'::jsonb))
  into v_out;
  return v_out;
end $$;
select core.allow_read('invoices', 'invoices.resource_entries', 'function', '{editor,owner}', false);
