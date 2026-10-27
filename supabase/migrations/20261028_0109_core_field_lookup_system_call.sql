-- 0109 · Dos piezas del núcleo pedidas el 27-10:
--   A. `core.field_lookup`: lectura por id de campo del inventario (0100) abierta a editores y owners de cualquier app. Flow la
--      necesita para los handoff y el Guiado (ruta, anclaje, confirmación y etiqueta de un campo de otra app). Devuelve solo lo
--      necesario: nunca `raw`, y nunca campos marcados `personal` o `sensitive`.
--   B. Llamadas de procedimiento en el lote de sistema: `core.apply_system_operations` admite `op: 'call'` para procedimientos de
--      la propia app registrados con `core.allow_system_procedure(app, fn)`. Dentro de la llamada, `core.is_system_call()` es
--      verdadero, para que el procedimiento distinga a la cuenta de servicio de una persona (Booking: alojar solo cuando la
--      pasarela confirma el pago, sin dar a la cuenta de servicio una pertenencia de persona).

-- A --------------------------------------------------------------------------------------------------------------------------
create or replace function core.field_lookup(p_actor uuid, p_field_ids text[])
returns jsonb language plpgsql stable as $$
begin
  if p_actor is null or not exists (select 1 from core.memberships m where m.user_id = p_actor and m.role in ('editor', 'owner')) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'field lookup is for editors and owners'));
  end if;
  if p_field_ids is null or array_length(p_field_ids, 1) is null or array_length(p_field_ids, 1) > 200 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'between 1 and 200 field ids'));
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('fieldId', f.field_id, 'app', f.app, 'screen', f.screen, 'route', f.route,
      'anchorId', f.anchor_id, 'label', f.label, 'type', f.type, 'entity', f.entity, 'prop', f.prop, 'required', f.required,
      'confirm', f.raw->>'confirm', 'sensitivity', f.sensitivity) order by f.field_id)
    from core.field_inventory f
   where f.active and f.field_id = any (p_field_ids) and coalesce(f.sensitivity, 'internal') in ('public', 'internal')), '[]'::jsonb);
end $$;
create or replace function public.core_field_lookup(p_actor uuid, p_field_ids text[]) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.field_lookup(p_actor, p_field_ids) $$;
revoke all on function core.field_lookup(uuid, text[]), public.core_field_lookup(uuid, text[]) from public, anon, authenticated;
grant execute on function public.core_field_lookup(uuid, text[]) to service_role;

-- B --------------------------------------------------------------------------------------------------------------------------
alter table core.allowed_procedures add column if not exists system boolean not null default false;

-- Procedimiento de la propia app que puede llamar un lote de sistema (worker, webhook de pasarela). Lo registra la app dueña.
create or replace function core.allow_system_procedure(p_app text, p_procedure text)
returns void language sql as $$
  insert into core.allowed_procedures (app, procedure, agent_confirmation, system) values (p_app, p_procedure, true, true)
  on conflict (app, procedure) do update set system = true;
$$;

create or replace function core.is_system_call() returns boolean language sql stable as $$
  select coalesce(nullif(current_setting('core.system_call', true), '') = 'on', false)
$$;

create or replace function core.apply_system_operations(p_service text, p_operations jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := nullif(current_setting('core.app', true), '');
  v_role text := nullif(current_setting('core.role', true), '');
  v_actor uuid := core.service_actor(p_service);
  v_cursor bigint; v_next bigint; v_results jsonb; v_request text := 'system:' || p_service || ':' || gen_random_uuid();
  v_call jsonb;
begin
  if v_app is null or v_role is distinct from 'system' or nullif(current_setting('core.actor', true), '') is not null then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only system actions (worker) write through this path'));
  end if;
  if v_actor is null then perform core.fail('SERVICE_NOT_READY', 503, jsonb_build_object('service', p_service)); end if;
  if p_service <> v_app then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a service writes only in its own app', 'service', p_service, 'app', v_app)); end if;
  if jsonb_typeof(p_operations) <> 'array' or jsonb_array_length(p_operations) = 0 or jsonb_array_length(p_operations) > 500 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'operations must be an array of 1 to 500'));
  end if;
  -- Llamadas: solo procedimientos de esta app registrados para el sistema (core.allow_system_procedure).
  for v_call in select o from jsonb_array_elements(p_operations) o where o->>'op' = 'call' loop
    if not exists (select 1 from core.allowed_procedures a where a.app = v_app and a.procedure = v_call->>'procedure' and a.system) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'procedure not allowed for system batches', 'procedure', v_call->>'procedure'));
    end if;
  end loop;
  select cursor into v_cursor from core.app_state where app = v_app for update;
  v_next := v_cursor + 1;
  perform set_config('core.system_call', 'on', true);
  begin
    v_results := core.apply_operations(v_app, v_actor, 'editor', v_request, v_next, p_operations);
  exception when others then
    perform set_config('core.system_call', '', true);
    raise;
  end;
  perform set_config('core.system_call', '', true);
  update core.app_state set cursor = v_next where app = v_app;
  perform set_config('core.app', v_app, true);
  perform set_config('core.role', 'system', true);
  perform set_config('core.actor', '', true);
  return jsonb_build_object('cursor', v_next, 'results', v_results);
end $$;
revoke all on function core.allow_system_procedure(text, text), core.is_system_call() from public, anon, authenticated;
grant execute on function core.is_system_call() to service_role;
