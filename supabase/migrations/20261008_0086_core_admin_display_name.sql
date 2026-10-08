-- FB_2026_013 (opción A del usuario): el nombre de la ficha de Personas manda. Central actualiza el nombre visible de la
-- cuenta enlazada (`core.profiles.display_name`) al renombrar la ficha. Solo administradores; nunca cuentas de servicio.
create or replace function core.admin_set_display_name(p_actor uuid, p_user uuid, p_name text)
returns jsonb language plpgsql as $$
declare v_name text := btrim(coalesce(p_name, '')); v_kind text;
begin
  perform core.require_admin(p_actor);
  if length(v_name) < 1 or length(v_name) > 120 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'displayName must have 1–120 characters'));
  end if;
  select kind into v_kind from core.profiles where user_id = p_user;
  if v_kind is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('userId', p_user)); end if;
  if v_kind = 'service' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'service accounts keep their name')); end if;
  update core.profiles set display_name = v_name where user_id = p_user;
  perform core.log_access('central', p_actor, null, 'member_changed', jsonb_build_object('userId', p_user, 'event', 'display_name_changed'));
  return jsonb_build_object('userId', p_user, 'displayName', v_name);
end $$;

create or replace function public.core_admin_set_display_name(p_actor uuid, p_user uuid, p_name text) returns jsonb
language sql security definer set search_path = '' as $$ select core.admin_set_display_name(p_actor, p_user, p_name) $$;

revoke all on function core.admin_set_display_name(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.core_admin_set_display_name(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.core_admin_set_display_name(uuid, uuid, text) to service_role;
