-- Invoices · R4, PR 4: vista previa del enlace de lo ya validado y de la memoria con artículos de Recursos
-- (coordinacion/invoices/R4_PREPARACION.md §2.3; el usuario aprobó las retroactivas el 14-10-2026). Toca solo el schema
-- invoices; de resources solo lee.
--
-- `invoices.resource_links_preview` (lectura, owner) propone, para cada línea viva sin artículo de una factura validada o
-- archivada y para cada entrada de la memoria sin artículo:
-- - `enlazar`: ya hay un artículo con ese nombre (sin distinguir mayúsculas, acentos ni espacios);
-- - `crear`: un artículo nuevo con el nombre («Mi nombre» o la descripción), el tipo que sale de `item_type` y la unidad
--   base de `normalize_unit` (kg, l o ud; g, ml y cl se convierten con su factor);
-- - `dudoso` (lo decide el usuario en la ficha): sin tipo, unidad no reconocida, el mismo nombre con tipos o unidades
--   distintas, o un artículo existente con otra unidad base;
-- - `omitir`: las líneas genéricas «Base al X % según documento» y los servicios, que no son stock.
-- `digest` resume la propuesta: aplicar exige el mismo, así que se aplica exactamente lo que se vio.
-- Las entradas (también las retroactivas, con la fecha de cada factura) las crea `reconcile_entries` al encender el
-- interruptor (la Edge cuadra todas las facturas enlazadas cuando cambia `resources_links`).

create or replace function invoices.name_key(p text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(translate(lower(coalesce(p, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'), '\s+', ' ', 'g')), '')
$$;

create or replace function invoices.resource_links_preview(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_rows jsonb; v_counts jsonb;
begin
  with src as (
    select 'line' as source, li.id, i.supplier_id, i.code as invoice_code, li.description, li.label, li.item_type, li.quantity, li.unit,
           left(btrim(coalesce(li.label, li.description)), 120) as name
      from invoices.invoice_lines li join invoices.invoices i on i.id = li.invoice_id
     where li.deleted_at is null and i.deleted_at is null and li.item_id is null and li.rectifies_line_id is null
       and i.status in ('validada', 'archivada')
    union all
    select 'memory', m.id, m.supplier_id, null, null, m.label, null, null, null, left(btrim(m.label), 120)
      from invoices.item_labels m where m.deleted_at is null and m.item_id is null and m.label is not null),
  typed as (
    select s.*, invoices.name_key(s.name) as key,
           case s.item_type when 'food_ingredient' then 'ingrediente' when 'equipment' then 'maquina' when 'material' then 'material' when 'other' then 'otro' end as kind,
           u.unit as base_unit, case when s.unit is null then null else u.factor end as factor,
           (s.description ilike 'Base al % según documento%') as generic
      from src s left join lateral invoices.normalize_unit(s.unit) u on true),
  -- La memoria hereda tipo y unidad de las líneas del mismo nombre
  filled as (
    select t.source, t.id, t.supplier_id, t.invoice_code, t.description, t.label, t.item_type, t.quantity, t.unit, t.name, t.key, t.generic,
           coalesce(t.kind, (select min(x.kind) from typed x where x.source = 'line' and x.key = t.key)) as kind,
           coalesce(t.base_unit, (select min(x.base_unit) from typed x where x.source = 'line' and x.key = t.key), case when t.unit is null then 'ud' end) as base_unit,
           t.factor
      from typed t),
  groups as (
    select key, count(distinct kind) as kinds, count(distinct base_unit) as units from filled where not generic and item_type is distinct from 'service' group by key),
  decided as (
    select f.*, it.id as item_id, it.name as item_name,
           case
             when f.generic then 'omitir'
             when f.item_type = 'service' then 'omitir'
             when it.id is not null and f.unit is not null and f.base_unit is distinct from lower(btrim(it.base_unit)) then 'dudoso'
             when it.id is not null then 'enlazar'
             when f.key is null then 'dudoso'
             when f.kind is null then 'dudoso'
             when f.base_unit is null then 'dudoso'
             when g.kinds > 1 or g.units > 1 then 'dudoso'
             else 'crear' end as action,
           case
             when f.generic then 'generica'
             when f.item_type = 'service' then 'servicio'
             when it.id is not null and f.unit is not null and f.base_unit is distinct from lower(btrim(it.base_unit)) then 'unidad_distinta'
             when it.id is not null then null
             when f.key is null then 'sin_nombre'
             when f.kind is null then 'sin_tipo'
             when f.base_unit is null then 'unidad'
             when g.kinds > 1 or g.units > 1 then 'mismo_nombre'
           end as reason
      from filled f
      left join groups g on g.key = f.key
      left join lateral (select r.id, r.base_unit, r.name from resources.items r where r.deleted_at is null and invoices.name_key(r.name) = f.key order by r.created_at limit 1) it on true)
  select coalesce(jsonb_agg(jsonb_build_object('source', d.source, 'id', d.id, 'supplier_id', d.supplier_id, 'invoice_code', d.invoice_code,
           'description', d.description, 'label', d.label, 'quantity', d.quantity, 'unit', d.unit, 'name', d.name, 'action', d.action, 'reason', d.reason,
           'item_id', d.item_id, 'item_name', d.item_name, 'kind', d.kind, 'base_unit', d.base_unit, 'item_factor', d.factor) order by d.source, d.invoice_code, d.id), '[]'::jsonb),
         jsonb_build_object(
           'lines', count(*) filter (where d.source = 'line'), 'memory', count(*) filter (where d.source = 'memory'),
           'enlazar', count(*) filter (where d.action = 'enlazar'), 'crear', count(*) filter (where d.action = 'crear'),
           'dudoso', count(*) filter (where d.action = 'dudoso'), 'omitir', count(*) filter (where d.action = 'omitir'),
           'new_items', count(distinct d.key) filter (where d.action = 'crear'))
    into v_rows, v_counts
    from decided d;
  return jsonb_build_object('rows', v_rows, 'counts', v_counts, 'digest', md5(v_rows::text));
end $$;
select core.allow_read('invoices', 'invoices.resource_links_preview', 'function', '{owner}', true);

-- Facturas con alguna línea enlazada o con entradas en Recursos: las que hay que cuadrar al encender o apagar el interruptor.
create or replace function invoices.resource_invoice_ids(p jsonb)
returns jsonb language plpgsql stable as $$
begin
  -- plpgsql (no sql): la migración corre antes que las de resources (0802), y así el cuerpo se comprueba al usarse.
  return (select coalesce(jsonb_agg(distinct li.invoice_id), '[]'::jsonb)
            from invoices.invoice_lines li
           where li.item_id is not null
              or exists (select 1 from resources.movements m where m.source_app = 'invoices' and m.source_ref = 'invoice_line:' || li.id and m.deleted_at is null));
end $$;
select core.allow_read('invoices', 'invoices.resource_invoice_ids', 'function', '{editor,owner}', false);
