-- Ikisai Central · el nivel de casa de una ficha con cuenta lo cambia solo el owner de Central (auditoría de rutas del
-- 27-10, C1, seguridad ALTA). Hasta ahora, cualquier editor de Central podía ponerse `house_level = 'direccion'` en su
-- propia ficha por `commands`, y el trigger `central.sync_house_level` (1506) le daba owner en las apps del nivel.
-- Como `check_account_link` (0502): en una ficha con cuenta (antes o después), cambiar `house_level`, `active`,
-- `deleted_at` o `merged_into` exige owner de Central. Se comprueba en la base, para cualquier camino que llegue a
-- core.commit; la Edge lo rechaza antes (validate.ts). Las fichas sin cuenta las siguen llevando los editores.
--
-- El rol que vale es el del lote **al empezar** (`core.role`, que fija core.commit), no la membresía al final: el trigger
-- `sync_house_level` corre al aplicar la fila, antes que los hooks, y ya le habría dado owner a quien se sube de nivel.
-- Por lo mismo se rehace `check_account_link` (0502): un editor enlazaba su cuenta a una ficha de «dirección», el trigger
-- le hacía owner y la comprobación, que miraba la membresía, le dejaba pasar.
-- Toca solo el schema central.

-- ¿Era owner de Central quien manda el lote, cuando empezó? (`core.role`; sin él, la membresía, que entonces no ha cambiado.)
create or replace function central.batch_by_owner(p jsonb)
returns boolean language sql stable as $$
  select case when coalesce(current_setting('core.role', true), '') <> '' then current_setting('core.role', true) = 'owner'
              else exists (select 1 from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid and m.role = 'owner') end
$$;

create or replace function central.check_account_link(p jsonb)
returns void language plpgsql as $$
declare v_row uuid;
begin
  -- Cambios de `user_id` en este lote: alta con valor o modificación (borrar o restaurar la fila no lo cambia).
  select c.row_id into v_row
    from core.changes c
   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
     and c.schema_name = 'central' and c.table_name = 'people'
     and (c.before->>'user_id') is distinct from (c.after->>'user_id')
   limit 1;
  if v_row is null then return; end if;
  if not central.batch_by_owner(p) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.people', 'id', v_row, 'field', 'user_id',
      'reason', 'only the central owner links accounts'));
  end if;
end $$;

create or replace function central.check_house_level_change(p jsonb)
returns void language plpgsql as $$
declare v_row uuid;
begin
  if central.batch_by_owner(p) then return; end if;
  select c.row_id into v_row
    from core.changes c
   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
     and c.schema_name = 'central' and c.table_name = 'people'
     and coalesce(c.after->>'user_id', c.before->>'user_id') is not null
     and ((c.before->>'house_level') is distinct from (c.after->>'house_level')
       or (c.before->>'active') is distinct from (c.after->>'active')
       or (c.before->>'deleted_at') is distinct from (c.after->>'deleted_at')
       or (c.before->>'merged_into') is distinct from (c.after->>'merged_into'))
   limit 1;
  if v_row is null then return; end if;
  perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.people', 'id', v_row, 'field', 'house_level',
    'reason', 'only the central owner changes the house level, activity or removal of a person with an account'));
end $$;

select core.add_validate_hook('central', 'central.check_house_level_change');

-- Para la Edge: de esas fichas, cuáles tienen cuenta (sin decir cuál). Solo ids; editores y owner.
create or replace function central.people_with_account(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v_ids uuid[];
begin
  if jsonb_typeof(p_ctx->'args'->'ids') <> 'array' or jsonb_array_length(p_ctx->'args'->'ids') > 500 then
    perform core.fail('INVALID_ARGS', 422);
  end if;
  select coalesce(array_agg(x::uuid), '{}') into v_ids
    from jsonb_array_elements_text(p_ctx->'args'->'ids') x
   where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  return jsonb_build_object('ids', coalesce((select jsonb_agg(p.id) from central.people p where p.id = any(v_ids) and p.user_id is not null), '[]'::jsonb));
end $$;
select core.allow_read('central', 'central.people_with_account', 'function', '{editor,owner}');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
