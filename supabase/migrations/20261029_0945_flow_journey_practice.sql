-- Ikisai Flow · recorridos: probar un borrador y «hacerlo de verdad» tras un ensayo (flow-14; D2 del roadmap de Core).
-- - Probar: el owner puede ensayar (modo `learn`) una versión en borrador antes de publicarla. Ejecutar de verdad sigue
--   exigiendo una versión publicada.
-- - «Hacerlo de verdad»: al terminar un ensayo, una ejecución real nueva enlazada a la práctica (`practice_of`), auditable, que
--   parte de lo respondido en el ensayo (se revisa y se vuelve a validar: lo fijo y lo heredado lo pone el servidor otra vez).

alter table flow.executions add column practice_of uuid references flow.executions(id);
select core.register_table('flow', 'flow', 'executions', array['version_id','mode','status','actor','values','result','finished_at','stages','practice_of'], '{owner}', '{editor,owner}', true);

-- Empezar. args = { execution_id, version_id, mode, practice_of? }
create or replace function flow.start_execution(p jsonb) returns jsonb language plpgsql as $$
declare v_id uuid := flow.arg_uuid(p, 'execution_id'); v_version uuid := flow.arg_uuid(p, 'version_id'); v_mode text := p->'args'->>'mode';
  v_status text; v_practice uuid; v_pe flow.executions;
begin
  perform flow.proc_begin();
  if v_mode is null or v_mode not in ('learn','run') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'mode must be learn or run')); end if;
  select status into v_status from flow.definition_versions where id = v_version and deleted_at is null;
  -- Publicada para todos; un borrador solo lo ensaya el owner.
  if v_status is null or (v_status <> 'published' and not (v_status = 'draft' and v_mode = 'learn' and p->>'role' = 'owner')) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.definition_versions'));
  end if;
  if coalesce(p->'args'->>'practice_of', '') <> '' then
    v_practice := flow.arg_uuid(p, 'practice_of');
    select * into v_pe from flow.executions where id = v_practice and deleted_at is null;
    if v_mode <> 'run' or v_pe.id is null or v_pe.actor is distinct from (p->>'actor')::uuid or v_pe.mode <> 'learn' or v_pe.status <> 'practiced' or v_pe.version_id <> v_version then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'practice_of must be your practiced rehearsal of this version'));
    end if;
  end if;
  perform flow.ins(p, 'flow.executions', jsonb_build_object('version_id', v_version, 'mode', v_mode, 'status', 'draft', 'actor', (p->>'actor')::uuid, 'practice_of', v_practice), v_id);
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v_id);
end $$;

create or replace function flow.start_stage(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions; v_pos int := (p->'args'->>'position')::int; v_stage flow.definition_stages; v_step flow.definition_steps;
  v_values jsonb := '{}'::jsonb; v_src jsonb; v_from int; v_rest text; v_stages jsonb; v_existing jsonb;
begin
  perform flow.proc_begin();
  v := flow.lock_execution(p);
  select * into v_stage from flow.definition_stages where version_id = v.version_id and position = v_pos and deleted_at is null;
  if v_stage.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.definition_stages', 'position', v_pos)); end if;
  v_stages := v.stages;
  -- Un tramo ya cerrado no se repite; uno con error o en borrador se retoma con lo que ya se respondió.
  select s into v_existing from jsonb_array_elements(v_stages) s where (s->>'position')::int = v_pos;
  if v_existing is not null and v_existing->>'status' not in ('draft', 'error') then
    perform core.fail('STAGE_FINISHED', 409, jsonb_build_object('position', v_pos, 'status', v_existing->>'status'));
  end if;
  v_values := coalesce(v_existing->'values', '{}'::jsonb);
  -- «Hacerlo de verdad» tras un ensayo (0945): lo respondido en la práctica de ese tramo, como punto de partida (se revisa).
  if v_existing is null and v.practice_of is not null then
    select coalesce(x->'values', '{}'::jsonb) into v_values from flow.executions pe, jsonb_array_elements(pe.stages) x
     where pe.id = v.practice_of and (x->>'position')::int = v_pos;
    v_values := coalesce(v_values, '{}'::jsonb);
  end if;
  if v_pos > 1 and not exists (select 1 from jsonb_array_elements(v_stages) s where (s->>'position')::int = v_pos - 1 and s->>'status' in ('done', 'skipped', 'practiced')) then
    perform core.fail('STAGE_NOT_READY', 409, jsonb_build_object('position', v_pos));
  end if;
  for v_step in select * from flow.definition_steps where stage_id = v_stage.id and deleted_at is null and mode <> 'ask' order by position loop
    if v_step.mode = 'fixed' then
      v_values := flow.json_set_path(v_values, v_step.key, v_step.fixed_value);
    else
      v_from := substring(v_step.default_from from '^stages\[([0-9]+)\]')::int;
      v_rest := substring(v_step.default_from from '^stages\[[0-9]+\]\.(.*)$');
      select s into v_src from jsonb_array_elements(v_stages) s where (s->>'position')::int = v_from;
      if v_src is not null then
        v_values := flow.json_set_path(v_values, v_step.key, coalesce(flow.json_path(v_src, v_rest), 'null'::jsonb));
      end if;
    end if;
  end loop;
  v_stages := coalesce((select jsonb_agg(s order by (s->>'position')::int) from jsonb_array_elements(v_stages) s where (s->>'position')::int <> v_pos), '[]'::jsonb)
    || jsonb_build_array(jsonb_build_object('position', v_pos, 'status', 'draft', 'values', v_values));
  perform flow.upd(p, 'flow.executions', v.id, v.revision, jsonb_build_object('stages', (select jsonb_agg(s order by (s->>'position')::int) from jsonb_array_elements(v_stages) s)));
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v.id, 'position', v_pos, 'kind', v_stage.kind, 'values', v_values);
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
