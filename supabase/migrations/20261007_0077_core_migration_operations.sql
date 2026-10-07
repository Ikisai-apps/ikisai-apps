-- Ikisai Core · siembra de datos sincronizados desde migraciones (petición de Finance, series de facturas 2026).
-- Una migración de app que crea filas sincronizadas las aplica con un lote propio de su app (cursor, hooks, core.changes), para
-- que lleguen a los dispositivos ya sincronizados. Sin actor (es el despliegue), rol owner. Solo para migraciones: no tiene
-- envoltorio público, así que la Edge no puede llamarla.

create or replace function core.apply_migration_operations(p_app text, p_request_id text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare v_cursor bigint; v_next bigint; v_results jsonb;
begin
  if p_request_id is null or p_request_id !~ '^migration:[A-Za-z0-9_.:-]{1,100}$' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'requestId must start with migration:'));
  end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 or jsonb_array_length(p_operations) > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array of 1 to 500'));
  end if;
  if exists (select 1 from jsonb_array_elements(p_operations) o where o->>'op' = 'call') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'migration batches take row operations only'));
  end if;
  select cursor into v_cursor from core.app_state where app = p_app for update;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  v_next := v_cursor + 1;
  v_results := core.apply_operations(p_app, null, 'owner', p_request_id, v_next, p_operations);
  update core.app_state set cursor = v_next where app = p_app;
  return jsonb_build_object('cursor', v_next, 'results', v_results);
end $$;

revoke all on function core.apply_migration_operations(text, text, jsonb) from public, anon, authenticated;
grant execute on function core.apply_migration_operations(text, text, jsonb) to service_role;
