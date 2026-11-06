-- Ikisai Tasks · ni personas, ni oficios, ni espacios, ni fases como etiquetas (VG, 06-11-2026; docs/tasks/API.md §63). Toca
-- solo el schema tasks y, del núcleo, solo usa apply_migration_operations.
-- Las etiquetas se quedan como algo ligero, libres; lo demás tiene su campo:
-- - personas → `task_people` y el responsable de Central (§33), oficios → `task_trades` (§32), espacios → `task_spaces` (§30),
--   fases → `project_phases` (0356 y 0367).
-- Las idas de §30, §32 y §33 (las lanza la propietaria con su correspondencia confirmada) ya archivan las familias que
-- convierten. Quedan las familias de sistema que se crean con cada área («Persona», «Oficio», «Edificio», «Espacio»): aquí
-- se archivan, con sus etiquetas, **solo si su conversión ya está hecha** (`people_source = 'central'`, `trade_source =
-- 'central'`, `zone_source = 'spaces'`); sin ella, la familia se queda como está (la etiqueta aún es el dato) y un aviso lo
-- dice. Archivar no borra: cada etiqueta recuerda si ya lo estaba (`archived_before_family`), como en las idas.
-- `tasks.archive_converted_families()` devuelve cuántas operaciones aplicó; repetirla no hace nada.

create or replace function tasks.archive_converted_families()
returns int language plpgsql as $$
declare
  v_keys text[] := '{}'; v_ops jsonb := '[]'::jsonb; v_n int := 0; v_batch int := 0; r record;
  setting text; v_stamp text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
begin
  select s.value #>> '{}' into setting from tasks.settings s where s.key = 'people_source' and s.deleted_at is null;
  if setting = 'central' then v_keys := v_keys || 'person'; else raise notice 'tasks 0369: las personas siguen en etiquetas (falta la ida de §33).'; end if;
  setting := null;
  select s.value #>> '{}' into setting from tasks.settings s where s.key = 'trade_source' and s.deleted_at is null;
  if setting = 'central' then v_keys := v_keys || 'trade'; else raise notice 'tasks 0369: los oficios siguen en etiquetas (falta la ida de §32).'; end if;
  setting := null;
  select s.value #>> '{}' into setting from tasks.settings s where s.key = 'zone_source' and s.deleted_at is null;
  if setting = 'spaces' then v_keys := v_keys || array['space', 'building']; else raise notice 'tasks 0369: los espacios siguen en etiquetas (falta la ida de §30).'; end if;
  if cardinality(v_keys) = 0 then return 0; end if;

  for r in
    select 'tasks.labels' as tbl, l.id, l.revision, l.archived from tasks.labels l join tasks.families f on f.id = l.family_id
     where f.system_key = any(v_keys) and f.deleted_at is null and not f.archived and l.deleted_at is null and not l.archived
    union all
    select 'tasks.families', f.id, f.revision, f.archived from tasks.families f
     where f.system_key = any(v_keys) and f.deleted_at is null and not f.archived
    order by 1 desc
  loop
    v_ops := v_ops || case when r.tbl = 'tasks.labels'
      then jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('archived', true, 'archived_before_family', r.archived))
      else jsonb_build_object('op', 'update', 'table', 'tasks.families', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('archived', true)) end;
    v_n := v_n + 1;
    if jsonb_array_length(v_ops) >= 400 then
      v_batch := v_batch + 1;
      perform core.apply_migration_operations('tasks', 'migration:tasks-0369-familias-' || v_stamp || '-' || v_batch, v_ops);
      v_ops := '[]'::jsonb;
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    v_batch := v_batch + 1;
    perform core.apply_migration_operations('tasks', 'migration:tasks-0369-familias-' || v_stamp || '-' || v_batch, v_ops);
  end if;
  return v_n;
end $$;
revoke all on function tasks.archive_converted_families() from public, anon, authenticated;
select tasks.archive_converted_families();
