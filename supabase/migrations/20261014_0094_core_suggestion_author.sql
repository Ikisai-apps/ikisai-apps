-- Ikisai Core · peticiones P23 y P24 de Booking («Apuntarme», O2).
-- P23: al aprobar una sugerencia, el procedimiento del lote sabe quién la hizo con `core.suggestion_author()` (y cuál con
--      `core.suggestion_id()`), fijados por el núcleo; fuera de una aprobación, null. Así la cuenta autora no viaja en `args`.
-- P24: `core.portal_grant` (0064) se permite desde las migraciones de las apps (lint): al aceptar, la cuenta autora ve sus fichas.

create or replace function core.suggestion_author()
returns uuid language sql stable as $$ select nullif(current_setting('core.suggestion_author', true), '')::uuid $$;

create or replace function core.suggestion_id()
returns uuid language sql stable as $$ select nullif(current_setting('core.suggestion_id', true), '')::uuid $$;

create or replace function core.suggestion_decide(p_app text, p_actor uuid, p_id uuid, p_decision text, p_comment text default null, p_operations jsonb default null)
returns jsonb language plpgsql as $$
declare s core.suggestions; k core.suggestion_kinds; v_ops jsonb; v_result jsonb;
begin
  perform core.suggestion_require_reviewer(p_app, p_actor);
  if p_decision not in ('approve', 'reject') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'decision must be approve or reject')); end if;
  if p_comment is not null and char_length(p_comment) > 1000 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'comment')); end if;
  select * into s from core.suggestions where id = p_id and app = p_app for update;
  if s.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('suggestionId', p_id)); end if;
  if s.status <> 'pending' then perform core.fail('SUGGESTION_UNAVAILABLE', 409, jsonb_build_object('suggestionId', p_id, 'status', s.status)); end if;
  if p_decision = 'reject' then
    update core.suggestions set status = 'rejected', comment = nullif(btrim(coalesce(p_comment, '')), ''), decided_by = p_actor, decided_at = now(), updated_at = now()
     where id = p_id returning * into s;
    return core.suggestion_json(s);
  end if;
  select * into k from core.suggestion_kinds where app = s.app and kind = s.kind;
  -- Sin lote corregido (null o JSON null), el de la sugerencia.
  if p_operations is null or jsonb_typeof(p_operations) = 'null' then v_ops := s.operations;
  else v_ops := p_operations; perform core.suggestion_check_operations(k, v_ops); end if;
  -- Quien sugirió y qué sugerencia, para los procedimientos del lote (P23): `core.suggestion_author()`; no se puede falsear en `args`.
  perform set_config('core.suggestion_author', s.author_id::text, true);
  perform set_config('core.suggestion_id', s.id::text, true);
  v_result := core.commit(p_app, p_actor, 'suggestion:' || p_id::text, encode(sha256(convert_to(v_ops::text, 'UTF8')), 'hex'), null, v_ops, null);
  update core.suggestions set status = 'approved', comment = nullif(btrim(coalesce(p_comment, '')), ''), decided_by = p_actor, decided_at = now(), updated_at = now(),
         applied_cursor = (v_result->>'cursor')::bigint, result = v_result->'results', operations = v_ops
   where id = p_id returning * into s;
  return core.suggestion_json(s);
end $$;

revoke all on function core.suggestion_author(), core.suggestion_id() from public, anon, authenticated;
grant execute on function core.suggestion_author(), core.suggestion_id() to service_role;
revoke all on function core.suggestion_decide(text, uuid, uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function core.suggestion_decide(text, uuid, uuid, text, text, jsonb) to service_role;
