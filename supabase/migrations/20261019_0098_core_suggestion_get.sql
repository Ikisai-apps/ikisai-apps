-- Ikisai core · una sugerencia por id, para quien decide (staff o dirección). La Edge la usa para aplicar el hook de la app
-- `suggestionVisible` antes de previsualizar o decidir (riesgo señalado por Tasks en O1: un editor con ámbitos veía y
-- decidía las sugerencias de toda la app).
create or replace function core.suggestion_get(p_app text, p_actor uuid, p_id uuid)
returns jsonb language plpgsql stable as $$
declare v jsonb;
begin
  perform core.suggestion_require_reviewer(p_app, p_actor);
  select core.suggestion_json(s) into v from core.suggestions s where s.app = p_app and s.id = p_id;
  if v is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('id', p_id)); end if;
  return v;
end $$;

create or replace function public.core_suggestion_get(p_app text, p_actor uuid, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.suggestion_get(p_app, p_actor, p_id) $$;
revoke all on function public.core_suggestion_get(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.core_suggestion_get(text, uuid, uuid) to service_role;
revoke all on function core.suggestion_get(text, uuid, uuid) from public, anon, authenticated;
