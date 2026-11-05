-- 0119 · App cliente del lote (Recursos R7, VG 5-11 · R-8 c): `core.client_app()` dice desde qué app se confirmó el lote que se
-- está aplicando, o null si no se sabe (lote de sistema, migración, carga fuera de lote). Lo usan los hooks de los módulos
-- compartidos (Recursos) para aplicar reglas por app cliente: la estructura de espacios solo la toca Central; Booking solo añade
-- camas en habitaciones ya creadas.
--   - La marca la pone la Edge que sirve el lote con su propia app (no la cabecera Origin, que cualquier cliente puede falsear):
--     `public.core_commit(..., p_origin, p_client_app)` (sobrecarga; las de 7 y 8 argumentos siguen valiendo).
--   - Debe ser una app registrada en core.apps o null.

create or replace function core.client_app() returns text language sql stable as $$
  select nullif(current_setting('core.client_app', true), '')
$$;

create or replace function public.core_commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb, p_confirmation jsonb, p_origin text, p_client_app text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_origin not in ('server', 'browser') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'origin must be server or browser')); end if;
  if p_client_app is not null and not exists (select 1 from core.apps where id = p_client_app) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'unknown client app', 'clientApp', p_client_app));
  end if;
  perform set_config('core.origin', p_origin, true);
  perform set_config('core.client_app', coalesce(p_client_app, ''), true);
  return core.commit(p_app, p_actor, p_request_id, p_digest, p_expected_cursor, p_operations, p_confirmation);
end $$;

revoke all on function core.client_app(), public.core_commit(text, uuid, text, text, bigint, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function core.client_app(), public.core_commit(text, uuid, text, text, bigint, jsonb, jsonb, text, text) to service_role;
