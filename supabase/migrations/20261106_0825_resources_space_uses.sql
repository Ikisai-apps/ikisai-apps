-- Ikisai Recursos · los usos generales de cada espacio (VG, 06-11-2026): valen para todos los eventos; un espacio puede
-- tener varios. Las marcas de un evento concreto no van aquí: son de Booking.
-- - `resources.spaces.uses`: text[] (por defecto '{}') con claves de una lista cerrada y sin repetir (acordada con Central
--   y Booking): alojamiento, eventos, trabajo, almacen, cocina, comedor, ocio, servicio (baños, lavandería, cuartos
--   técnicos) y exterior. Para ampliarla, se sustituye `resources.valid_space_uses` en una migración.
-- - Solo se cambian desde Central (como la estructura, R7) o fuera de una app (sistema, carga): `core.client_app()`
--   (núcleo 0119). Las demás apps los leen.
-- - Lo que ya existe sale con usos según su tipo (habitación con camas → alojamiento, sala → eventos, …).
-- Toca solo el schema resources.

create or replace function resources.valid_space_uses(p text[])
returns boolean language sql immutable as $$
  select p is not null
     and p <@ array['alojamiento', 'eventos', 'trabajo', 'almacen', 'cocina', 'comedor', 'ocio', 'servicio', 'exterior']::text[]
     and cardinality(p) = (select count(distinct u) from unnest(p) u)
$$;

alter table resources.spaces add column uses text[] not null default '{}';
alter table resources.spaces add constraint spaces_uses_check check (resources.valid_space_uses(uses));
select core.register_table('resources', 'resources', 'spaces',
  array['parent_id', 'kind', 'name', 'public_name', 'code', 'position', 'active', 'notes', 'attributes', 'source_refs', 'plan_id', 'plan_shape',
        'uses']);

-- Lo que ya existe, según su tipo. La habitación solo es alojamiento si tiene alguna cama viva.
update resources.spaces s set uses = case s.kind
    when 'habitacion' then case when exists (select 1 from resources.spaces b where b.parent_id = s.id and b.kind = 'cama' and b.deleted_at is null)
                                then '{alojamiento}'::text[] else '{}'::text[] end
    when 'sala' then '{eventos}'::text[]
    when 'oficina' then '{trabajo}'::text[]
    when 'almacen' then '{almacen}'::text[]
    when 'cocina' then '{cocina}'::text[]
    when 'comedor' then '{comedor}'::text[]
    when 'bano' then '{servicio}'::text[]
    when 'instalacion' then '{servicio}'::text[]
    when 'exterior' then '{exterior}'::text[]
    else '{}'::text[] end
 where s.deleted_at is null and s.uses = '{}';

-- Fuera de Central (y de lo que va sin app), los usos no se ponen ni se cambian.
create or replace function resources.check_space_uses(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_client text := core.client_app();
  v_change record;
begin
  if v_client is null or v_client = 'central' then return; end if;
  for v_change in select c.row_id, c.op, c.before, c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'spaces'
                     and c.op <> 'delete' loop
    if coalesce(v_change.after->'uses', '[]'::jsonb) is distinct from coalesce(v_change.before->'uses', '[]'::jsonb) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'resources.spaces', 'id', v_change.row_id, 'field', 'uses',
        'clientApp', v_client, 'reason', 'space uses are managed from Central'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_space_uses');

revoke all on function resources.valid_space_uses(text[]), resources.check_space_uses(jsonb) from public, anon, authenticated;
grant execute on function resources.valid_space_uses(text[]), resources.check_space_uses(jsonb) to service_role;
