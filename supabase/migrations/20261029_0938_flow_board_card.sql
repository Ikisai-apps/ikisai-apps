-- Ikisai Flow · «Avance por aplicaciones», paso 2: `flow.board_card`, crear o cambiar una tarjeta del tablero.
-- args = { project_id, card_id?, lane_key, title?, status?, prio?, flag?, kind?, ref?, url?, url_text?, steps?, note? }
-- - Sin `card_id` (o uno que no existe), la crea; con uno que existe, cambia solo lo que se da (`prio`/`flag` a null los quita).
-- - `status`: pending · in_progress · done; `flag`: pr · backlog (VG: «no ahora»); `kind`: card · recurring (sin urgencia).
-- - `ref` (número de PR…), `url` (https), `url_text`, `steps` (hasta 30 pasos) y `note` van en `payload`.
-- - El carril lo comprueba `flow.guard_board` (scopes.lanes; owner, todos). Lo usan la app (Dirección, Víctor) y la
--   capacidad `flow.board_card` del catálogo (agentes, idempotente por requestId).
create or replace function flow.board_card(p jsonb) returns jsonb language plpgsql as $$
declare
  a jsonb := p->'args'; v_project uuid := flow.arg_uuid(p, 'project_id'); v_id uuid; v_c flow.units;
  v_lane text := a->>'lane_key'; v_status text; v_kind text; v_payload jsonb; v_fields jsonb; v_title text;
begin
  perform flow.proc_begin();
  perform flow.check_scope(p, v_project);
  if not exists (select 1 from flow.columns where project_id = v_project and key = 'avance' and deleted_at is null) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'this flow has no board'));
  end if;
  if a ? 'card_id' and coalesce(a->>'card_id', '') <> '' then v_id := flow.arg_uuid(p, 'card_id'); end if;
  if v_id is not null then select * into v_c from flow.units where id = v_id for update; end if;
  if v_c.id is not null and (v_c.project_id <> v_project or v_c.kind not in ('card', 'recurring') or v_c.deleted_at is not null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'id', v_id));
  end if;

  v_title := nullif(btrim(coalesce(a->>'title', '')), '');
  v_status := coalesce(a->>'status', v_c.status, 'pending');
  v_kind := coalesce(a->>'kind', v_c.kind, 'card');
  if v_status not in ('pending', 'in_progress', 'done') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'status')); end if;
  if v_kind not in ('card', 'recurring') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'kind')); end if;
  if a ? 'prio' and a->>'prio' is not null and a->>'prio' not in ('urgente', 'importante', 'secundario', 'opcional') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'prio'));
  end if;
  if a ? 'flag' and a->>'flag' is not null and a->>'flag' not in ('pr', 'backlog') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'flag')); end if;
  if a ? 'url' and a->>'url' is not null and (a->>'url' !~ '^https://[^\s]{3,}$' or length(a->>'url') > 500) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'url'));
  end if;
  if a ? 'steps' and a->'steps' <> 'null'::jsonb and (jsonb_typeof(a->'steps') <> 'array' or jsonb_array_length(a->'steps') > 30
       or exists (select 1 from jsonb_array_elements(a->'steps') s where jsonb_typeof(s) <> 'string' or length(s #>> '{}') > 300)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'steps'));
  end if;
  if length(coalesce(a->>'ref', '')) > 40 or length(coalesce(a->>'url_text', '')) > 60 or length(coalesce(a->>'note', '')) > 1000 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'ref/url_text/note'));
  end if;

  -- Lo que va en payload: solo las claves que se dan (null las quita).
  v_payload := coalesce(v_c.payload, '{}'::jsonb);
  v_payload := v_payload || coalesce((select jsonb_object_agg(k, a->k) from unnest(array['ref', 'url', 'url_text', 'steps', 'note']) k where a ? k), '{}'::jsonb);
  v_payload := jsonb_strip_nulls(v_payload);

  if v_c.id is null then
    if v_lane is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'lane_key')); end if;
    if v_title is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'title')); end if;
    v_id := flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_project, 'column_key', 'avance', 'kind', v_kind, 'label', left(v_title, 300),
      'lane_key', v_lane, 'prio', case when v_kind = 'recurring' then null else a->>'prio' end, 'board_flag', a->>'flag', 'status', v_status,
      'done_at', case when v_status = 'done' then now() end, 'done_by', case when v_status = 'done' then (p->>'actor')::uuid end, 'payload', v_payload),
      coalesce(v_id, gen_random_uuid()));
    perform flow.proc_end();
    return jsonb_build_object('card_id', v_id, 'created', true);
  end if;

  v_fields := jsonb_build_object('status', v_status, 'kind', v_kind, 'payload', v_payload);
  if v_title is not null then v_fields := v_fields || jsonb_build_object('label', left(v_title, 300)); end if;
  if v_lane is not null then v_fields := v_fields || jsonb_build_object('lane_key', v_lane); end if;
  if a ? 'prio' or v_kind = 'recurring' then v_fields := v_fields || jsonb_build_object('prio', case when v_kind = 'recurring' then null else a->>'prio' end); end if;
  if a ? 'flag' then v_fields := v_fields || jsonb_build_object('board_flag', a->>'flag'); end if;
  if v_status = 'done' and v_c.status <> 'done' then v_fields := v_fields || jsonb_build_object('done_at', now(), 'done_by', (p->>'actor')::uuid);
  elsif v_status <> 'done' then v_fields := v_fields || jsonb_build_object('done_at', null, 'done_by', null);
  end if;
  perform flow.upd(p, 'flow.units', v_c.id, v_c.revision, v_fields);
  perform flow.proc_end();
  return jsonb_build_object('card_id', v_c.id, 'created', false);
end $$;
select core.allow_procedure('flow', 'flow.board_card');
-- Lo usan también los agentes con rol outsider en el proyecto del tablero.
select core.allow_outsider_procedure('flow', 'flow.board_card');

select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.board_card', 'app', 'flow', 'kind', 'execute', 'title', 'Escribir una tarjeta del Avance',
  'description', 'Crea o cambia una tarjeta del tablero «Avance por aplicaciones» en el carril de quien la escribe (scopes.lanes). Idempotente por requestId.',
  'route', 'POST board-card', 'roles', jsonb_build_array('editor', 'owner', 'outsider'), 'risk', 'low', 'idempotent', true, 'reversible', true,
  'input', '{"type":"object","required":["requestId","project_id","lane_key"],"properties":{"requestId":{"type":"string"},"project_id":{"type":"string","format":"uuid"},"card_id":{"type":"string","format":"uuid"},"lane_key":{"type":"string"},"title":{"type":"string","maxLength":300},"status":{"enum":["pending","in_progress","done"]},"prio":{"enum":["urgente","importante","secundario","opcional",null]},"flag":{"enum":["pr","backlog",null]},"kind":{"enum":["card","recurring"]},"ref":{"type":"string","maxLength":40},"url":{"type":"string","format":"uri"},"url_text":{"type":"string","maxLength":60},"steps":{"type":"array","maxItems":30,"items":{"type":"string","maxLength":300}},"note":{"type":"string","maxLength":1000}}}'::jsonb,
  'output', '{"type":"object","properties":{"card_id":{"type":"string","format":"uuid"},"created":{"type":"boolean"},"replayed":{"type":"boolean"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.avance'), 'since', '0938'));

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
