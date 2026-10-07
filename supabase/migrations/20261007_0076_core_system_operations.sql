-- Ikisai Core · escrituras de un worker de sistema en su propia app (petición P22 de Booking, SES-4).
-- Una acción invocada por el planificador (`worker/<schema>.<fn>`, sin actor, rol `system`) escribe filas de SU app con un lote
-- propio: cursor, hooks y core.changes, para que los cambios (p. ej. la anonimización de huéspedes) lleguen a los dispositivos.
-- El actor del lote es la cuenta de servicio de la app («Booking (sistema)»), nunca una persona.

create or replace function core.apply_system_operations(p_service text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := nullif(current_setting('core.app', true), '');
  v_role text := nullif(current_setting('core.role', true), '');
  v_actor uuid := core.service_actor(p_service);
  v_cursor bigint; v_next bigint; v_results jsonb; v_request text := 'system:' || p_service || ':' || gen_random_uuid();
begin
  if v_app is null or v_role is distinct from 'system' or nullif(current_setting('core.actor', true), '') is not null then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only system actions (worker) write through this path'));
  end if;
  if v_actor is null then perform core.fail('SERVICE_NOT_READY', 503, jsonb_build_object('service', p_service)); end if;
  if p_service <> v_app then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a service writes only in its own app', 'service', p_service, 'app', v_app)); end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 or jsonb_array_length(p_operations) > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array of 1 to 500'));
  end if;
  if exists (select 1 from jsonb_array_elements(p_operations) o where o->>'op' = 'call') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'system batches take row operations only'));
  end if;
  select cursor into v_cursor from core.app_state where app = v_app for update;
  v_next := v_cursor + 1;
  v_results := core.apply_operations(v_app, v_actor, 'editor', v_request, v_next, p_operations);
  update core.app_state set cursor = v_next where app = v_app;
  perform set_config('core.app', v_app, true);
  perform set_config('core.role', 'system', true);
  perform set_config('core.actor', '', true);
  return jsonb_build_object('cursor', v_next, 'results', v_results);
end $$;

revoke all on function core.apply_system_operations(text, jsonb) from public, anon, authenticated;
grant execute on function core.apply_system_operations(text, jsonb) to service_role;
