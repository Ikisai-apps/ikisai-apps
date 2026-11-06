-- Ikisai Tasks · «Espacio» por selección visual (encargo de VG del 06-11-2026; docs/tasks/API.md §62). Toca solo el schema tasks y,
-- del núcleo, solo usa register_table y synced_tables.
-- - tasks.task_spaces.cell: el cuadrante de 1 m² opcional dentro del espacio, como lo da el selector del kit
--   (`createPlacePicker`, `cell: true`): `{"cellX": n, "cellY": n, "scale": 1}`, con celdas enteras no negativas en la
--   retícula del dibujo. Nulo = todo el espacio. Una tarea guarda uno por espacio (cada fila puente es un sitio).

alter table tasks.task_spaces add column cell jsonb
  check (cell is null or (
    jsonb_typeof(cell) = 'object'
    and jsonb_typeof(cell->'cellX') = 'number' and jsonb_typeof(cell->'cellY') = 'number'
    and (cell->>'cellX')::numeric >= 0 and (cell->>'cellY')::numeric >= 0
    and (cell->>'cellX')::numeric = trunc((cell->>'cellX')::numeric) and (cell->>'cellY')::numeric = trunc((cell->>'cellY')::numeric)
    and (cell->>'cellX')::numeric < 10000 and (cell->>'cellY')::numeric < 10000
    and coalesce(cell->>'scale', '1') = '1'
    and cell - 'cellX' - 'cellY' - 'scale' = '{}'::jsonb));

do $$
declare r record;
begin
  for r in select * from core.synced_tables where app = 'tasks' and schema_name = 'tasks' and table_name = 'task_spaces' loop
    perform core.register_table('tasks', 'tasks', r.table_name,
      r.writable_columns || array(select c from unnest(array['cell']) c where not (c = any(r.writable_columns))),
      r.readable_roles, r.writable_roles, r.never_purge);
  end loop;
end $$;
