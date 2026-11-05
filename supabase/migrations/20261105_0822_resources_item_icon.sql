-- Ikisai Recursos · el icono de un artículo (C-06, FB_2026_090; VG, 05-11-2026): en la ficha se elige de una lista
-- (maquinaria, herramienta y un par por oficio). El juego de iconos lo hace UI-kit; aquí solo se guarda su clave.
-- - `resources.items.icon`: clave de texto opcional (`^[a-z][a-z0-9_-]{0,40}$`). Se valida el formato, no una lista
--   cerrada, para no atar la base al juego del kit.
-- Toca solo el schema resources.

alter table resources.items add column icon text check (icon is null or icon ~ '^[a-z][a-z0-9_-]{0,40}$');
select core.register_table('resources', 'resources', 'items',
  array['name', 'kind', 'category', 'base_unit', 'min_quantity', 'reorder_quantity', 'default_space_id', 'default_supplier_id',
        'tracks_lots', 'tracks_expiry', 'attributes', 'active', 'notes', 'source_refs', 'trade_id', 'icon']);
