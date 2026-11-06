-- Ikisai Recursos · familias automáticas a partir del nombre de los artículos (C-03, FB_2026_070; VG, 05-11-2026): al
-- escribir el nombre de un suministro se van proponiendo las palabras que ya se repiten («tubo» › «tubo multicapa» ›
-- «tubo multicapa 20» › «tubo multicapa 20 mm»). Nada se guarda aparte: sale de los nombres de los artículos vivos.
-- - `resources.item_families`: cada prefijo de palabras (`family`, en minúsculas, para agrupar), su forma tal como se
--   escribió (`label`, la más usada), cuántas palabras tiene (`depth`) y cuántos artículos lo comparten (`items`).
--   El campo con sugerencias lo pinta UI-kit; Tasks y Central lo usan en la ficha.
-- Toca solo el schema resources.

create view resources.item_families as
with words as (
  select i.id, w.ord, w.word
    from resources.items i
    cross join lateral regexp_split_to_table(btrim(i.name), '\s+') with ordinality as w(word, ord)
   where i.deleted_at is null and btrim(i.name) <> ''),
prefixes as (
  select id, ord as depth, string_agg(word, ' ') over (partition by id order by ord) as label from words)
select lower(label) as family, mode() within group (order by label) as label, depth::int as depth, count(distinct id)::int as items
  from prefixes
 group by lower(label), depth;

revoke all on resources.item_families from public, anon, authenticated;
grant select on resources.item_families to service_role;
select core.allow_read('resources', 'resources.item_families', 'view', '{reader,editor,owner}');
