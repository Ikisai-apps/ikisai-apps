-- Ikisai Recursos · los espacios se gestionan desde Central (vg-52 y R-8 c de VG, 05-11-2026; R7). Con la app cliente del
-- lote (`core.client_app()`, núcleo 0119):
-- - null (sistema, migración, carga fuera de lote) o 'central': la estructura de espacios se puede cambiar;
-- - 'booking': solo añadir camas en habitaciones que ya existían antes del lote (sin crear, renombrar, mover ni archivar);
-- - 'tasks': solo los espacios que derivan de sus etiquetas o zonas (`source_refs` con `tasks.label:` o `tasks.zone:`), que
--   crea y cambia al convertirlas (decisión de Core, 06-11); nada más;
-- - cualquier otra: nada de estructura.
-- Estructura = crear, borrar o restaurar un espacio, o cambiar su padre, tipo, nombre, nombre público o si está activo.
-- Lo demás (datos, notas, forma en el plano) sigue con sus reglas de siempre. Toca solo el schema resources.

create or replace function resources.check_space_structure(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_client text := core.client_app();
  v_change record;
  v_refs_before text[]; v_refs_after text[];
begin
  if v_client is null or v_client = 'central' then return; end if;
  for v_change in select c.row_id, c.op, c.before, c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'spaces' loop
    -- Las referencias a etiquetas o zonas de Tasks (lo que hace «derivado» a un espacio), antes y después del cambio.
    select coalesce(array_agg(r order by r), '{}') into v_refs_before from jsonb_array_elements_text(coalesce(v_change.before->'source_refs', '[]'::jsonb)) r
     where r like 'tasks.label:%' or r like 'tasks.zone:%';
    select coalesce(array_agg(r order by r), '{}') into v_refs_after from jsonb_array_elements_text(coalesce(v_change.after->'source_refs', '[]'::jsonb)) r
     where r like 'tasks.label:%' or r like 'tasks.zone:%';
    -- Añadir o quitar esas referencias a un espacio que ya existe es estructura: fuera de Central, no.
    if v_change.op <> 'insert' and v_change.op <> 'delete' and v_refs_before is distinct from v_refs_after then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.spaces', 'id', v_change.row_id, 'clientApp', v_client,
        'reason', 'spaces are managed from Central'));
    end if;
    -- Lo que no es estructura se deja pasar.
    if v_change.op = 'update'
       and (v_change.before->>'parent_id', v_change.before->>'kind', v_change.before->>'name', v_change.before->>'public_name',
            v_change.before->>'active', v_change.before->>'deleted_at')
           is not distinct from
           (v_change.after->>'parent_id', v_change.after->>'kind', v_change.after->>'name', v_change.after->>'public_name',
            v_change.after->>'active', v_change.after->>'deleted_at') then
      continue;
    end if;
    -- Tasks: solo sus derivados. Uno nuevo, con su referencia; uno que ya existía, si ya era derivado antes del lote (lo que
    -- guarda la base, no lo que manda el cliente).
    if v_client = 'tasks' and ((v_change.op = 'insert' and cardinality(v_refs_after) > 0)
                               or (v_change.op <> 'insert' and cardinality(v_refs_before) > 0)) then
      continue;
    end if;
    -- Booking: solo una cama nueva dentro de una habitación que ya existía.
    if v_client = 'booking' and v_change.op = 'insert' and v_change.after->>'kind' = 'cama'
       and exists (select 1 from resources.spaces r
                    where r.id = (v_change.after->>'parent_id')::uuid and r.kind = 'habitacion' and r.deleted_at is null
                      and not exists (select 1 from core.changes x where x.app = 'resources' and x.cursor = v_cursor
                                        and x.schema_name = 'resources' and x.table_name = 'spaces' and x.row_id = r.id and x.op = 'insert')) then
      continue;
    end if;
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.spaces', 'id', v_change.row_id, 'clientApp', v_client,
      'reason', 'spaces are managed from Central'));
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_space_structure');

revoke all on function resources.check_space_structure(jsonb) from public, anon, authenticated;
grant execute on function resources.check_space_structure(jsonb) to service_role;
