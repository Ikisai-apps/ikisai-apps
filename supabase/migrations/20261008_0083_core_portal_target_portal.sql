-- K6 (portales): core.apply_portal_operations admite como destino otro portal distinto del que invoca (respuestas de
-- Guests en organizers.answers). Solo cambia la comprobación del destino; el resto es igual que en 0065.
create or replace function core.apply_portal_operations(p_app text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_portal text := nullif(current_setting('core.app', true), '');
  v_actor uuid := nullif(current_setting('core.actor', true), '')::uuid;
  v_role text := nullif(current_setting('core.role', true), '');
  v_cursor bigint; v_next bigint; v_results jsonb; v_changes jsonb; v_request text := 'portal:' || gen_random_uuid();
begin
  -- Solo dentro de una acción invocada desde un portal, por un miembro editor de ese portal, sobre otra app.
  if v_portal is null or v_actor is null or not exists (select 1 from core.apps where id = v_portal and kind = 'portal') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only portal actions write through this path'));
  end if;
  if v_role is distinct from 'editor' or not exists (select 1 from core.memberships where app = v_portal and user_id = v_actor and role = 'editor') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'portal member required'));
  end if;
  -- K6: el destino puede ser otro portal (Guests responde a las preguntas de Organizers con una acción de Organizers);
  -- nunca el propio portal que invoca, que escribe sus datos con core.commit.
  if p_app = v_portal then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a portal writes its own data with commit', 'app', p_app));
  end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be a non-empty array')); end if;
  if jsonb_array_length(p_operations) > 100 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'max 100 operations')); end if;
  if exists (select 1 from jsonb_array_elements(p_operations) o where o->>'op' = 'call') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'portal batches take row operations only'));
  end if;

  select cursor into v_cursor from core.app_state where app = p_app for update;
  if v_cursor is null then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  v_next := v_cursor + 1;
  v_results := core.apply_operations(p_app, v_actor, 'editor', v_request, v_next, p_operations);
  update core.app_state set cursor = v_next where app = p_app;
  select coalesce(jsonb_agg(jsonb_build_object('table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'op', c.op, 'revision', c.revision) order by c.seq), '[]'::jsonb)
    into v_changes from core.changes c where c.app = p_app and c.cursor = v_next;

  -- apply_operations dejó el contexto en la app dueña: se restaura el del portal para el resto de la acción.
  perform set_config('core.app', v_portal, true);
  perform set_config('core.role', v_role, true);
  return jsonb_build_object('cursor', v_next, 'results', v_results, 'changes', v_changes);
end $$;
