-- Ikisai Tasks · lectura para Central de la familia «Tipo: Acción» (coordinacion/ampliacion/RECURSOS.md §13.3, fase P1):
-- Central siembra con ella su catálogo de oficios, con vista previa. Toca solo el schema tasks y no cambia nada de Tasks.
-- La familia se reconoce por el nombre (sin mayúsculas, espacios de los lados ni tilde), no por la clave de sistema `trade`:
-- en los datos reales hay familias con la clave equivocada (ver 0318). Etiquetas vivas de familias vivas de áreas vivas o
-- del catálogo General (`tab_id` nulo), con las archivadas marcadas. `tab_id` dice de qué área es cada una (nulo = General),
-- para que Central junte las repetidas entre áreas; `parent_id` es la madre dentro de la misma familia (dos niveles).
create view tasks.action_labels as
select l.id as label_id, l.parent_id, l.name, l.position, (l.archived or f.archived) as archived, l.tab_id, l.family_id
  from tasks.labels l
  join tasks.families f on f.id = l.family_id
  left join tasks.tabs tb on tb.id = f.tab_id
 where l.deleted_at is null and f.deleted_at is null
   and (f.tab_id is null or (tb.id is not null and tb.deleted_at is null))
   and translate(lower(btrim(f.name)), 'áéíóú', 'aeiou') = 'tipo: accion';

revoke all on tasks.action_labels from public, anon, authenticated;
grant select on tasks.action_labels to service_role;
select core.allow_read('central', 'tasks.action_labels', 'view');
