-- Invoices · unidad normalizada en `invoices.food_stock_projection` (petición de Food). Toca solo el schema invoices.
--
-- La unidad de una línea es texto libre del documento («Kg», «litros», «ud.», «gr»). `invoices.normalize_unit` la traduce a
-- una de tres unidades canónicas con su factor: kg (g ×0,001), l (ml ×0,001, cl ×0,01) y ud. Si no la reconoce, devuelve
-- null en ambas y Food sigue con su lectura del texto. La proyección añade al final `unit_normalized` y
-- `quantity_normalized` (cantidad asignada en esa unidad); las columnas anteriores no cambian.

create or replace function invoices.normalize_unit(p_unit text, out unit text, out factor numeric)
language sql immutable as $$
  with k as (
    select regexp_replace(regexp_replace(translate(lower(btrim(coalesce(p_unit, ''))), 'áéíóú', 'aeiou'), '\s+', ' ', 'g'), '[.\s]+$', '') as v
  )
  select
    case
      when v in ('kg', 'kgs', 'k', 'kilo', 'kilos', 'kilogramo', 'kilogramos', 'g', 'gr', 'grs', 'gramo', 'gramos') then 'kg'
      when v in ('l', 'lt', 'lts', 'ltr', 'litro', 'litros', 'ml', 'mililitro', 'mililitros', 'cl', 'centilitro', 'centilitros') then 'l'
      when v in ('ud', 'uds', 'u', 'un', 'und', 'unid', 'unidad', 'unidades', 'pieza', 'piezas', 'pza', 'pzas') then 'ud'
    end,
    case
      when v in ('kg', 'kgs', 'k', 'kilo', 'kilos', 'kilogramo', 'kilogramos', 'l', 'lt', 'lts', 'ltr', 'litro', 'litros',
                 'ud', 'uds', 'u', 'un', 'und', 'unid', 'unidad', 'unidades', 'pieza', 'piezas', 'pza', 'pzas') then 1::numeric
      when v in ('g', 'gr', 'grs', 'gramo', 'gramos', 'ml', 'mililitro', 'mililitros') then 0.001::numeric
      when v in ('cl', 'centilitro', 'centilitros') then 0.01::numeric
    end
  from k;
$$;
revoke all on function invoices.normalize_unit(text) from public, anon, authenticated;

create or replace view invoices.food_stock_projection as
  select a.id as allocation_id, a.target_kind, a.target_id, i.code as invoice_code, i.invoice_date, s.name as supplier_name,
         l.description as line_description, l.match_name, a.allocated_quantity, l.unit, a.allocated_amount, a.revision as allocation_revision,
         nu.unit as unit_normalized, round(a.allocated_quantity * nu.factor, 4) as quantity_normalized
  from invoices.allocations a
  join invoices.invoice_lines l on l.id = a.invoice_line_id
  join invoices.invoices i on i.id = a.invoice_id
  join invoices.suppliers s on s.id = i.supplier_id
  cross join lateral invoices.normalize_unit(l.unit) nu
  where a.deleted_at is null and l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'food';
