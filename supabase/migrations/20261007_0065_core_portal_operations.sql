-- Ikisai Core · escrituras de los portales en los datos de la app dueña (contrato §3.6, peticiones P20 y P21 de Booking).
-- Una acción de portal (Organizers, Guests) invocada con `invoke` escribe en las tablas de la app dueña (Booking) con su
-- propio lote: cursor propio, hooks de validación y core.changes, como core.commit pero sin pertenencia a la app dueña
-- (el ámbito lo comprueba la acción) ni recibo (la idempotencia la da expectedRevision).

create or replace function core.apply_portal_operations(p_app text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_portal text := nullif(current_setting('core.app', true), '');
  v_actor uuid := nullif(current_setting('core.actor', true), '')::uuid;
  v_role text := nullif(current_setting('core.role', true), '');
  v_cursor bigint; v_next bigint; v_results jsonb; v_changes jsonb; v_request text := 'portal:' || gen_random_uuid();
begin
  -- Solo dentro de una acción invocada desde un portal, por un miembro editor de ese portal, sobre una app que no es portal.
  if v_portal is null or v_actor is null or not exists (select 1 from core.apps where id = v_portal and kind = 'portal') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only portal actions write through this path'));
  end if;
  if v_role is distinct from 'editor' or not exists (select 1 from core.memberships where app = v_portal and user_id = v_actor and role = 'editor') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'portal member required'));
  end if;
  if exists (select 1 from core.apps where id = p_app and kind = 'portal') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'target must be an internal app', 'app', p_app));
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

-- Revoca los enlaces de un portal cuyo ámbito tiene esa clave y valor (p. ej. guest_id al dar de baja a un huésped) y quita
-- el permiso correspondiente de la pertenencia, para que una sesión ya abierta tampoco lo conserve. Devuelve cuántos enlaces.
create or replace function core.portal_revoke_scope(p_app text, p_key text, p_value text)
returns integer language plpgsql as $$
declare v_count integer; v_user uuid;
begin
  if not exists (select 1 from core.apps where id = p_app and kind = 'portal') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'not a portal', 'app', p_app)); end if;
  if p_key not in ('reservation_id', 'guest_id') or coalesce(p_value, '') = '' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid scope key')); end if;
  with r as (update core.portal_links set revoked_at = now() where app = p_app and scope->>p_key = p_value and revoked_at is null returning 1)
  select count(*) into v_count from r;
  for v_user in select user_id from core.memberships where app = p_app and jsonb_typeof(scopes->'grants') = 'array'
                  and exists (select 1 from jsonb_array_elements(scopes->'grants') g where g->>p_key = p_value) loop
    update core.memberships set
      scopes = jsonb_set(scopes, '{grants}', coalesce((select jsonb_agg(g) from jsonb_array_elements(scopes->'grants') g where g->>p_key is distinct from p_value), '[]'::jsonb)),
      updated_at = now(), revision = revision + 1
    where app = p_app and user_id = v_user;
  end loop;
  return v_count;
end $$;

revoke all on function core.apply_portal_operations(text, jsonb) from public, anon, authenticated;
revoke all on function core.portal_revoke_scope(text, text, text) from public, anon, authenticated;
grant execute on function core.apply_portal_operations(text, jsonb) to service_role;
grant execute on function core.portal_revoke_scope(text, text, text) to service_role;
