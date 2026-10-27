-- 0118 · Origen del lote (FO4 de Food y Recursos, 27-10): `core.batch_origin()` dice si el lote que se está aplicando viene de un
-- navegador ('browser') o de un servidor ('server': otra Edge con identidad de servicio, un lote de sistema o una migración).
-- Lo usan los hooks de las apps para no fiarse de lo que el cliente declara (Recursos: `source_app` solo lo pone el servidor).
--   - La Edge marca el origen al confirmar: `public.core_commit(..., p_origin)` (sobrecarga; la de 7 argumentos sigue valiendo).
--   - Sin marca, es `server`: el navegador solo llega a core.commit por `/commands`, y el kit marca ahí siempre; las Edges que
--     llaman a `core_commit` directamente (Finance y Tasks hacia Recursos, lotes de sistema, migraciones) son servidor.

create or replace function core.batch_origin() returns text language sql stable as $$
  select case
    when nullif(current_setting('core.origin', true), '') in ('server', 'browser') then current_setting('core.origin', true)
    else 'server' end
$$;

create or replace function public.core_commit(p_app text, p_actor uuid, p_request_id text, p_digest text, p_expected_cursor bigint, p_operations jsonb, p_confirmation jsonb, p_origin text)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if p_origin not in ('server', 'browser') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'origin must be server or browser')); end if;
  perform set_config('core.origin', p_origin, true);
  return core.commit(p_app, p_actor, p_request_id, p_digest, p_expected_cursor, p_operations, p_confirmation);
end $$;

revoke all on function core.batch_origin(), public.core_commit(text, uuid, text, text, bigint, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function core.batch_origin(), public.core_commit(text, uuid, text, text, bigint, jsonb, jsonb, text) to service_role;
