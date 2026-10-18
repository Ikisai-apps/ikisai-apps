-- Ikisai Tasks · O1, paso 1: el outsider puede LEER lo que se le abra, y nada más (RECURSOS.md §14.2, aprobado el
-- 18-10-2026, docs/tasks/API.md §31).
-- - Lectura: las tablas de las tareas (áreas, catálogo, proyectos, tareas, etiquetas, espacios, dependencias, adjuntos y
--   ajustes) admiten el rol `outsider`. Qué filas ve lo decide el hook `visible` de tasks-api con sus ámbitos efectivos:
--   la pertenencia del outsider nace vacía (`core.apply_house_level`) y, para él, vacío o «*» es NADA.
-- - Nunca: compras y almacén, reglas y peticiones de Entrada, vistas guardadas.
-- - Escritura: ninguna todavía (`writable_roles` no cambia; el dominio también lo rechaza). Marcar hecha y comentar, paso 2.
-- Las lecturas de SQL (`core.allow_read`) siguen sin `outsider`.

update core.synced_tables
   set readable_roles = array_append(readable_roles, 'outsider')
 where app = 'tasks' and schema_name = 'tasks'
   and table_name in ('tabs', 'families', 'labels', 'projects', 'tasks', 'project_labels', 'task_labels',
                      'project_spaces', 'task_spaces', 'task_dependencies', 'attachments', 'settings')
   and not ('outsider' = any(readable_roles));
