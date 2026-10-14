-- Food · R5 · vista previa de la migración de ingredientes y maquinaria a artículos de Recursos
-- (coordinacion/ampliacion/RECURSOS.md §6 «Food»; docs/resources/API.md §3).
--
-- SOLO LECTURA: un único SELECT, sin escrituras, sin bloqueos y sin funciones nuevas. La lanza Core contra producción
-- y devuelve el JSON; Food la prueba contra PGlite en tests/food/r5-vista-previa.test.ts.
--
-- Devuelve:
-- - `recuentos`: filas vivas, inactivas y en papelera, y su uso (líneas de receta, maquinaria de receta, compra).
-- - `recursos`: artículos que ya existen en Recursos, por tipo (para ver choques de nombre).
-- - `ingredientes`: uno por ingrediente vivo, con el artículo propuesto (tipo, unidad base y conversiones que harían
--   falta) y sus `dudas`.
-- - `maquinaria`: una por máquina viva, con el artículo propuesto (tipo, sitio y datos propios) y sus `dudas`.
--
-- Dudas posibles:
-- - `ya_existe_en_recursos`: hay un artículo vivo con el mismo nombre; se enlazaría con él en vez de crear otro.
-- - `parecido_a`: otro ingrediente o máquina con casi el mismo nombre (acentos, mayúsculas, plural).
-- - `unidades_de_otra_familia`: hay líneas en masa, volumen o unidades distintas de la base; hace falta un factor
--   («1 unidad de tomate ≈ 150 g») que hoy no existe.
-- - `unidad_sin_medida`: la unidad preferida es paquete, manojo u otro: no se sabe cuánto es.
-- - `inactivo`, `sin_uso`: candidatos a archivar en vez de migrar activos.
-- - `nombre_compartido`: un ingrediente y una máquina se llaman igual (en Recursos el nombre es único).
-- - `ubicacion_sin_espacio`: la ubicación escrita no coincide con ningún espacio de Recursos.
-- - `estado_no_operativo`: Recursos no tiene estado de máquina; se guardaría en `attributes.status`.
-- - `cantidad_cero`, `tipo_dudoso` (parece menaje o herramienta, no máquina).
with
-- Clave para comparar nombres: minúsculas, sin acentos, sin espacios dobles y sin plural simple.
norm as (
  select 'ingrediente'::text as source, i.id, i.name, i.preferred_unit, i.preferred_supplier, i.active, i.deleted_at,
         null::text as category, null::int as quantity, null::text as capacity, null::text as location, null::text as status, null::text as notes,
         lower(btrim(regexp_replace(i.name, '\s+', ' ', 'g'))) as exact_key,
         regexp_replace(translate(lower(btrim(regexp_replace(i.name, '\s+', ' ', 'g'))), 'áéíóúüñàèìòùç', 'aeiouunaeiouc'), '(es|s|e)$', '') as loose_key
    from food.ingredients i
  union all
  select 'maquina', e.id, e.name, null, null, true, e.deleted_at, e.category, e.quantity, e.capacity, e.location, e.status, e.notes,
         lower(btrim(regexp_replace(e.name, '\s+', ' ', 'g'))),
         regexp_replace(translate(lower(btrim(regexp_replace(e.name, '\s+', ' ', 'g'))), 'áéíóúüñàèìòùç', 'aeiouunaeiouc'), '(es|s|e)$', '')
    from food.equipment e
),
live as (select * from norm where deleted_at is null),
items as (select id, name, kind, lower(btrim(name)) as exact_key from resources.items where deleted_at is null),
spaces as (select id, name, lower(btrim(name)) as exact_key from resources.spaces where deleted_at is null),
-- Familia de cada unidad de Food: masa, volumen, unidades o sin medida.
fam(unit, family, base) as (values ('g','masa','g'), ('kg','masa','g'), ('ml','volumen','ml'), ('l','volumen','ml'),
  ('unidad','unidades','ud'), ('paquete','sin_medida','paquete'), ('manojo','sin_medida','manojo'), ('otro','sin_medida','otro')),
lines as (
  select l.ingredient_id, l.unit, f.family, count(*) as n
    from food.recipe_ingredients l join food.recipes r on r.id = l.recipe_id join fam f on f.unit = l.unit
   where l.deleted_at is null and r.deleted_at is null
   group by l.ingredient_id, l.unit, f.family
),
buys as (
  select si.ingredient_id, count(*) as n, count(*) filter (where sl.status <> 'cerrada') as open_n
    from food.shopping_list_items si join food.shopping_lists sl on sl.id = si.shopping_list_id
   where si.deleted_at is null and sl.deleted_at is null
   group by si.ingredient_id
),
needs as (
  select n.equipment_id, count(*) as n
    from food.recipe_equipment n join food.recipes r on r.id = n.recipe_id
   where n.deleted_at is null and r.deleted_at is null
   group by n.equipment_id
),
ingredient_rows as (
  select g.id, g.name, g.preferred_unit, g.preferred_supplier, g.active, f.family, f.base,
         coalesce((select jsonb_object_agg(l.unit, l.n) from lines l where l.ingredient_id = g.id), '{}'::jsonb) as line_units,
         coalesce((select sum(l.n) from lines l where l.ingredient_id = g.id), 0) as recipe_lines,
         coalesce((select b.n from buys b where b.ingredient_id = g.id), 0) as shopping_lines,
         coalesce((select b.open_n from buys b where b.ingredient_id = g.id), 0) as open_shopping_lines,
         (select jsonb_build_object('id', it.id, 'kind', it.kind) from items it where it.exact_key = g.exact_key limit 1) as existing,
         (select jsonb_agg(o.name order by o.name) from live o where o.id <> g.id and o.loose_key = g.loose_key and o.source = 'ingrediente') as similar_names,
         exists (select 1 from live o where o.source = 'maquina' and o.exact_key = g.exact_key) as shared_name,
         (select jsonb_agg(distinct l.family) from lines l where l.ingredient_id = g.id and l.family <> f.family) as other_families
    from live g join fam f on f.unit = g.preferred_unit
   where g.source = 'ingrediente'
),
machine_rows as (
  select m.id, m.name, m.category, m.quantity, m.capacity, m.location, m.status, m.notes,
         coalesce((select n.n from needs n where n.equipment_id = m.id), 0) as recipes,
         (select jsonb_build_object('id', it.id, 'kind', it.kind) from items it where it.exact_key = m.exact_key limit 1) as existing,
         (select jsonb_build_object('id', s.id, 'name', s.name) from spaces s where m.location is not null and s.exact_key = lower(btrim(m.location)) limit 1) as space,
         (select jsonb_agg(o.name order by o.name) from live o where o.id <> m.id and o.loose_key = m.loose_key and o.source = 'maquina') as similar_names,
         lower(coalesce(m.category, '') || ' ' || m.name) ~ '(olla|cazuela|sart[eé]n|bandeja|cuchill|tabla|cazo|bol|recipiente|gastronorm|cubo|paellera|tupper)' as looks_like_ware
    from live m
   where m.source = 'maquina'
)
select jsonb_build_object(
  'generada', now(),
  'recuentos', jsonb_build_object(
    'ingredientes', jsonb_build_object(
      'vivos', (select count(*) from food.ingredients where deleted_at is null),
      'inactivos', (select count(*) from food.ingredients where deleted_at is null and not active),
      'en_papelera', (select count(*) from food.ingredients where deleted_at is not null),
      'sin_uso', (select count(*) from ingredient_rows where recipe_lines = 0 and shopping_lines = 0)),
    'lineas_de_receta', (select count(*) from food.recipe_ingredients l join food.recipes r on r.id = l.recipe_id where l.deleted_at is null and r.deleted_at is null),
    'lineas_por_unidad', (select coalesce(jsonb_object_agg(unit, n), '{}'::jsonb) from (select unit, sum(n) as n from lines group by unit) u),
    'lineas_de_compra', jsonb_build_object(
      'todas', (select coalesce(sum(n), 0) from buys), 'en_listas_abiertas', (select coalesce(sum(open_n), 0) from buys),
      'a_mano', (select count(*) from food.shopping_list_items where deleted_at is null and manual)),
    'maquinaria', jsonb_build_object(
      'vivas', (select count(*) from food.equipment where deleted_at is null),
      'unidades', (select coalesce(sum(quantity), 0) from food.equipment where deleted_at is null),
      'por_estado', (select coalesce(jsonb_object_agg(status, n), '{}'::jsonb) from (select status, count(*) as n from food.equipment where deleted_at is null group by status) s),
      'en_papelera', (select count(*) from food.equipment where deleted_at is not null),
      'con_ubicacion', (select count(*) from food.equipment where deleted_at is null and location is not null)),
    'maquinaria_de_receta', (select count(*) from food.recipe_equipment n join food.recipes r on r.id = n.recipe_id where n.deleted_at is null and r.deleted_at is null),
    'recetas_vivas', (select count(*) from food.recipes where deleted_at is null),
    'con_dudas', jsonb_build_object(
      'ingredientes', (select count(*) from ingredient_rows where existing is not null or similar_names is not null or shared_name or other_families is not null
                         or family = 'sin_medida' or not active or (recipe_lines = 0 and shopping_lines = 0)),
      'maquinaria', (select count(*) from machine_rows where existing is not null or similar_names is not null or (location is not null and space is null)
                       or status <> 'operativo' or quantity = 0 or looks_like_ware))),
  'recursos', jsonb_build_object(
    'articulos_por_tipo', (select coalesce(jsonb_object_agg(kind, n), '{}'::jsonb) from (select kind, count(*) as n from items group by kind) k),
    'espacios', (select count(*) from spaces)),
  'ingredientes', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'nombre', name,
      'propuesta', jsonb_build_object('tipo', 'ingrediente', 'unidad_base', base, 'proveedor_texto', preferred_supplier, 'activo', active,
        'enlazar_con', existing),
      'uso', jsonb_build_object('lineas_de_receta', recipe_lines, 'unidades_en_recetas', line_units, 'lineas_de_compra', shopping_lines, 'en_listas_abiertas', open_shopping_lines),
      'dudas', to_jsonb(array_remove(array[
        case when existing is not null then 'ya_existe_en_recursos' end,
        case when similar_names is not null then 'parecido_a: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(similar_names) x) end,
        case when other_families is not null then 'unidades_de_otra_familia: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(other_families) x) end,
        case when family = 'sin_medida' then 'unidad_sin_medida' end,
        case when not active then 'inactivo' end,
        case when recipe_lines = 0 and shopping_lines = 0 then 'sin_uso' end,
        case when shared_name then 'nombre_compartido' end], null))
    ) order by name), '[]'::jsonb) from ingredient_rows),
  'maquinaria', (select coalesce(jsonb_agg(jsonb_build_object(
      'id', id, 'nombre', name,
      'propuesta', jsonb_build_object('tipo', case when looks_like_ware then 'menaje' else 'maquina' end, 'unidad_base', 'ud', 'cantidad', quantity,
        'espacio', space, 'atributos', jsonb_strip_nulls(jsonb_build_object('categoria', category, 'capacidad', capacity, 'estado', status, 'ubicacion_texto', location)),
        'enlazar_con', existing),
      'uso', jsonb_build_object('recetas', recipes),
      'dudas', to_jsonb(array_remove(array[
        case when existing is not null then 'ya_existe_en_recursos' end,
        case when similar_names is not null then 'parecido_a: ' || (select string_agg(x, ', ') from jsonb_array_elements_text(similar_names) x) end,
        case when location is not null and space is null then 'ubicacion_sin_espacio' end,
        case when status <> 'operativo' then 'estado_no_operativo' end,
        case when quantity = 0 then 'cantidad_cero' end,
        case when looks_like_ware then 'tipo_dudoso' end], null))
    ) order by name), '[]'::jsonb) from machine_rows)
) as vista_previa;
