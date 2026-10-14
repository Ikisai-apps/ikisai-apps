-- Ikisai Core · pregunta de Booking (O2, «Apuntarme»): avisar a la app cuando llega una sugerencia nueva.
-- Cada tipo puede tener un procedimiento `on_submit` de su app (permitido con core.allow_procedure) que `core.suggest` llama
-- en la misma transacción con {app, kind, suggestion}. No escribe por core.commit: sirve para encolar avisos (p. ej. a Tasks).
-- Si falla, la sugerencia no se crea.

alter table core.suggestion_kinds add column if not exists on_submit text;

create or replace function core.set_suggestion_on_submit(p_app text, p_kind text, p_procedure text)
returns void language plpgsql as $$
begin
  if p_procedure is not null and not exists (select 1 from core.allowed_procedures where app = p_app and procedure = p_procedure) then
    perform core.fail('PROCEDURE_NOT_ALLOWED', 422, jsonb_build_object('procedure', p_procedure));
  end if;
  update core.suggestion_kinds set on_submit = p_procedure where app = p_app and kind = p_kind;
  if not found then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', p_kind)); end if;
end $$;

create or replace function core.suggest(p_app text, p_actor uuid, p_request_id text, p_kind text, p_summary text, p_detail jsonb, p_operations jsonb)
returns jsonb language plpgsql as $$
declare k core.suggestion_kinds; s core.suggestions;
begin
  if p_request_id is null or p_request_id !~ '^[A-Za-z0-9_.:-]{1,120}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'invalid requestId')); end if;
  select * into k from core.suggestion_kinds where app = p_app and kind = p_kind;
  if k.app is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', p_kind)); end if;
  if not core.suggestion_can_submit(k, p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'cannot suggest', 'kind', p_kind)); end if;
  select * into s from core.suggestions where app = p_app and author_id = p_actor and request_id = p_request_id;
  if s.id is not null then
    if s.operations <> p_operations or s.kind <> p_kind then perform core.fail('IDEMPOTENCY_REUSE', 409, jsonb_build_object('requestId', p_request_id)); end if;
    return core.suggestion_json(s) || jsonb_build_object('replayed', true);
  end if;
  if p_summary is null or char_length(btrim(p_summary)) = 0 or char_length(p_summary) > 300 then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('field', 'summary')); end if;
  if p_detail is not null and length(p_detail::text) > 8000 then perform core.fail('PAYLOAD_TOO_LARGE', 413, jsonb_build_object('field', 'detail')); end if;
  perform core.suggestion_check_operations(k, p_operations);
  if (select count(*) from core.suggestions where app = p_app and author_id = p_actor and status = 'pending') >= 30 then
    perform core.fail('TOO_MANY_SUGGESTIONS', 429, jsonb_build_object('limit', 30));
  end if;
  insert into core.suggestions (app, kind, author_id, request_id, summary, detail, operations)
  values (p_app, p_kind, p_actor, p_request_id, btrim(p_summary), p_detail, p_operations) returning * into s;
  -- Aviso de la app al llegar una sugerencia nueva (p. ej. Booking avisa a Tasks de un «Apuntarme»), en la misma transacción.
  if k.on_submit is not null then
    execute format('select %s($1)', k.on_submit) using jsonb_build_object('app', p_app, 'kind', p_kind, 'suggestion', core.suggestion_json(s));
  end if;
  return core.suggestion_json(s);
end $$;

revoke all on function core.set_suggestion_on_submit(text, text, text) from public, anon, authenticated;
grant execute on function core.set_suggestion_on_submit(text, text, text) to service_role;
revoke all on function core.suggest(text, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function core.suggest(text, uuid, text, text, text, jsonb, jsonb) to service_role;
