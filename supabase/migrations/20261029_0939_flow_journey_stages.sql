-- Ikisai Flow · recorridos por tramos (flow-14; diseño de Core en MUELA/equipo/feedback/flow/RECORRIDOS_EDITOR.md y
-- análisis de Flow en ANALISIS_RECORRIDOS_flow-14.md), paso 1: modelo, datos y ejecución por tramos en el servidor.
-- - Un recorrido es una lista ordenada de tramos (`flow.definition_stages`):
--   - `capability`: pregunta por los campos del `input` de esa capacidad y, en «ejecutar», la app la invoca al acabar el tramo;
--   - `record`: solo registra respuestas (forma 3, «modo formulario»); sus pasos tienen tipo (texto, número, sí/no, opción, foto);
--   - `handoff`: «ahora ve a <app> y haz <pantalla>»; se cierra cuando la persona marca «hecho».
-- - Los pasos cuelgan del tramo. Cada paso se pregunta (`ask`), es fijo (`fixed`) o viene de un tramo anterior (`from`, con
--   `default_from` = `stages[N].values.<ruta>` o `stages[N].result.<ruta>`). Lo fijo y lo heredado lo pone el servidor al
--   empezar el tramo, nunca el navegador.
-- - La ejecución guarda cada tramo en `executions.stages` ({position, status, values, result, receipt_id, error}). Un tramo con
--   error detiene ahí; «Reintentar» repite solo ese tramo (requestId `flow-<ejecución>-s<N>`, idempotente en la app dueña).
-- - Publicar (`flow.publish_version`, owner) valida el recorrido; lo publicado no se toca (editar = versión nueva).
-- - «Registrar compra» (0919) pasa a un único tramo `capability` con sus 8 pasos, sin cambiar sus ids.

create table flow.definition_stages (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  version_id uuid not null references flow.definition_versions(id),
  position integer not null check (position between 1 and 20),
  kind text not null check (kind in ('capability', 'record', 'handoff')),
  capability text check (capability is null or capability ~ '^[a-z]+\.[a-z0-9_]+$'),
  title text not null check (length(title) between 1 and 120),
  explain text check (explain is null or length(explain) <= 600),
  -- `handoff`: a qué app y pantalla manda (el enlace sale del inventario de campos del núcleo).
  target_app text check (target_app is null or target_app ~ '^[a-z][a-z0-9_]{1,30}$'),
  target_anchor text check (target_anchor is null or target_anchor ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$'),
  check (kind <> 'capability' or capability is not null),
  check (kind <> 'handoff' or target_app is not null)
);
create unique index definition_stages_uidx on flow.definition_stages (version_id, position) where deleted_at is null;
select core.register_table('flow', 'flow', 'definition_stages', array['version_id','position','kind','capability','title','explain','target_app','target_anchor'], '{reader,editor,owner}', '{owner}', true);

alter table flow.definition_steps add column stage_id uuid references flow.definition_stages(id);
alter table flow.definition_steps add column input_type text check (input_type is null or input_type in ('text', 'number', 'boolean', 'choice', 'photo'));
alter table flow.definition_steps add column options jsonb check (options is null or (jsonb_typeof(options) = 'array' and jsonb_array_length(options) <= 30));
alter table flow.definition_steps add column mode text not null default 'ask' check (mode in ('ask', 'fixed', 'from'));
alter table flow.definition_steps add column fixed_value jsonb;
alter table flow.definition_steps add column default_from text check (default_from is null or default_from ~ '^stages\[[1-9][0-9]?\]\.(values|result)(\.[a-z][a-z0-9_]*){1,4}$');
alter table flow.definition_steps add constraint definition_steps_mode_shape check (
  (mode <> 'fixed' or fixed_value is not null) and (mode <> 'from' or default_from is not null) and (input_type <> 'choice' or options is not null));
alter table flow.definition_versions alter column capability drop not null;
alter table flow.executions add column stages jsonb not null default '[]'::jsonb;

-- Datos: cada versión de un solo tramo (0919) pasa a tener su tramo `capability` y sus pasos cuelgan de él.
insert into flow.definition_stages (version_id, position, kind, capability, title)
select v.id, 1, 'capability', v.capability, d.name
  from flow.definition_versions v join flow.definitions d on d.id = v.definition_id
 where v.capability is not null and not exists (select 1 from flow.definition_stages s where s.version_id = v.id);
update flow.definition_steps st set stage_id = s.id
  from flow.definition_stages s where s.version_id = st.version_id and s.position = 1 and st.stage_id is null;
alter table flow.definition_steps alter column stage_id set not null;
drop index flow.definition_steps_uidx;
create unique index definition_steps_uidx on flow.definition_steps (stage_id, key) where deleted_at is null;

select core.register_table('flow', 'flow', 'definition_steps', array['version_id','stage_id','position','key','title','explain','essential','anchor','input_type','options','mode','fixed_value','default_from'], '{reader,editor,owner}', '{owner}', true);
select core.register_table('flow', 'flow', 'executions', array['version_id','mode','status','actor','values','result','finished_at','stages'], '{owner}', '{editor,owner}', true);

-- Lo publicado no se toca: ni la versión ni sus tramos ni sus pasos (salvo dentro de un procedimiento: publicar).
create or replace function flow.guard_published() returns trigger language plpgsql as $$
declare v_version uuid; v_status text;
begin
  if flow.in_proc() then return new; end if;
  -- Por jsonb: PL/pgSQL resuelve `old.<campo>` aunque la rama del case no se tome (y las versiones no tienen version_id).
  v_version := case when tg_table_name = 'definition_versions' then (to_jsonb(old)->>'id')::uuid else (to_jsonb(old)->>'version_id')::uuid end;
  if tg_op = 'INSERT' then v_version := case when tg_table_name = 'definition_versions' then null else (to_jsonb(new)->>'version_id')::uuid end; end if;
  if v_version is null then return new; end if;
  select status into v_status from flow.definition_versions where id = v_version;
  if v_status = 'published' then perform core.fail('VERSION_PUBLISHED', 409, jsonb_build_object('version_id', v_version)); end if;
  return new;
end $$;
create trigger flow_published before insert or update on flow.definition_stages for each row execute function flow.guard_published();
create trigger flow_published before insert or update on flow.definition_steps for each row execute function flow.guard_published();
create trigger flow_published before update on flow.definition_versions for each row execute function flow.guard_published();

/** Valor en una ruta con puntos dentro de un jsonb («supplier.name»). */
create or replace function flow.json_path(p_obj jsonb, p_path text) returns jsonb language sql immutable as $$
  select p_obj #> string_to_array(p_path, '.')
$$;
/** Pone un valor en una ruta con puntos, creando los objetos intermedios. */
create or replace function flow.json_set_path(p_obj jsonb, p_path text, p_value jsonb) returns jsonb language plpgsql immutable as $$
declare v_keys text[] := string_to_array(p_path, '.'); v_out jsonb := coalesce(p_obj, '{}'::jsonb); i int;
begin
  for i in 1 .. array_length(v_keys, 1) - 1 loop
    if jsonb_typeof(v_out #> v_keys[1:i]) is distinct from 'object' then v_out := jsonb_set(v_out, v_keys[1:i], '{}'::jsonb, true); end if;
  end loop;
  return jsonb_set(v_out, v_keys, p_value, true);
end $$;

/** Publicar un borrador (owner): valida y lo deja inmutable. args = { version_id } */
create or replace function flow.publish_version(p jsonb) returns jsonb language plpgsql as $$
declare v flow.definition_versions; v_stage flow.definition_stages; v_step flow.definition_steps; v_n int; v_from int;
begin
  perform flow.proc_begin();
  if p->>'role' <> 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'journeys are published by the owner')); end if;
  select * into v from flow.definition_versions where id = flow.arg_uuid(p, 'version_id') and deleted_at is null for update;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.definition_versions')); end if;
  if v.status = 'published' then perform core.fail('VERSION_PUBLISHED', 409, jsonb_build_object('version_id', v.id)); end if;
  select count(*) into v_n from flow.definition_stages where version_id = v.id and deleted_at is null;
  if v_n = 0 then perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'no stages')); end if;
  -- Tramos seguidos (1..n) y cada uno con lo suyo.
  if exists (select 1 from (select position, row_number() over (order by position) rn from flow.definition_stages where version_id = v.id and deleted_at is null) x where x.position <> x.rn) then
    perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'stages must be numbered 1..n'));
  end if;
  for v_stage in select * from flow.definition_stages where version_id = v.id and deleted_at is null order by position loop
    if v_stage.kind in ('capability', 'record') and not exists (select 1 from flow.definition_steps where stage_id = v_stage.id and deleted_at is null) then
      perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'stage without steps', 'stage', v_stage.position));
    end if;
    for v_step in select * from flow.definition_steps where stage_id = v_stage.id and deleted_at is null loop
      if v_step.version_id <> v.id then perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'step of another version', 'step', v_step.key)); end if;
      if v_stage.kind = 'record' and v_step.input_type is null then perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'record step needs a type', 'step', v_step.key)); end if;
      if v_step.mode = 'from' then
        v_from := substring(v_step.default_from from '^stages\[([0-9]+)\]')::int;
        if v_from >= v_stage.position then perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'default_from must point to an earlier stage', 'step', v_step.key)); end if;
      end if;
    end loop;
  end loop;
  if v_n > 20 or (select count(*) from flow.definition_steps where version_id = v.id and deleted_at is null) > 100 then
    perform core.fail('JOURNEY_INVALID', 422, jsonb_build_object('reason', 'too big (20 stages, 100 steps)'));
  end if;
  -- La versión antes publicada de esa definición deja de ofrecerse (queda su historia).
  update flow.definition_versions set status = 'draft', deleted_at = now() where definition_id = v.definition_id and status = 'published' and id <> v.id and deleted_at is null;
  perform flow.upd(p, 'flow.definition_versions', v.id, v.revision, jsonb_build_object('status', 'published',
    'capability', (select capability from flow.definition_stages where version_id = v.id and deleted_at is null and kind = 'capability' order by position limit 1)));
  perform flow.proc_end();
  return jsonb_build_object('version_id', v.id, 'stages', v_n);
end $$;

/**
 * Empezar un tramo de una ejecución (en borrador, de quien la hace). Exige que los anteriores estén hechos (o saltados si no
 * son esenciales) y pone en sus valores lo fijo y lo que viene de tramos anteriores. args = { execution_id, position }
 * Devuelve los valores ya puestos, para que la app pregunte solo el resto.
 */
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

/** Respuestas de un tramo (borrador). Lo fijo y lo heredado no se cambia desde aquí. args = { execution_id, position, values } */
create or replace function flow.save_stage_values(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions; v_pos int := (p->'args'->>'position')::int; v_cur jsonb; v_stage_id uuid; v_vals jsonb := p->'args'->'values'; v_k text;
begin
  perform flow.proc_begin();
  v := flow.lock_execution(p);
  if jsonb_typeof(v_vals) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'values must be an object')); end if;
  select s into v_cur from jsonb_array_elements(v.stages) s where (s->>'position')::int = v_pos and s->>'status' in ('draft', 'error');
  if v_cur is null then perform core.fail('STAGE_NOT_READY', 409, jsonb_build_object('position', v_pos)); end if;
  select id into v_stage_id from flow.definition_stages where version_id = v.version_id and position = v_pos and deleted_at is null;
  for v_k in select jsonb_object_keys(v_vals) loop
    -- Lo fijo o heredado no se toca ni por la misma clave, ni por debajo («currency.x») ni por encima («supplier» sobre
    -- «supplier.name»). Por segmentos, sin LIKE (el «_» de las claves es comodín en LIKE).
    if exists (select 1 from flow.definition_steps where stage_id = v_stage_id and deleted_at is null and mode <> 'ask'
                and (key = v_k or starts_with(v_k, key || '.') or starts_with(key, v_k || '.'))) then
      perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'fixed or inherited step', 'key', v_k));
    end if;
  end loop;
  -- Las claves con puntos («supplier.name») se guardan anidadas, como las pone el servidor y como las lee `default_from`.
  for v_k in select jsonb_object_keys(v_vals) loop
    if v_k !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'bad key', 'key', v_k)); end if;
    v_cur := jsonb_set(v_cur, '{values}', flow.json_set_path(coalesce(v_cur->'values', '{}'::jsonb), v_k, v_vals->v_k));
  end loop;
  if length(v_cur::text) > 20000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'values too large')); end if;
  perform flow.upd(p, 'flow.executions', v.id, v.revision, jsonb_build_object('stages',
    (select jsonb_agg(case when (s->>'position')::int = v_pos then v_cur else s end order by (s->>'position')::int) from jsonb_array_elements(v.stages) s)));
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v.id, 'position', v_pos);
end $$;

/**
 * Cerrar un tramo. args = { execution_id, position, status: done|error|skipped|practiced, result?, receipt_id?, error? }
 * - `practiced` solo en «aprender»; `done`/`error` de un tramo `capability` solo en «ejecutar» (lo anota la app con la
 *   respuesta de la capacidad; el recibo de verdad está en el núcleo); `skipped` solo si el tramo no tiene pasos esenciales.
 * - Al cerrar el último tramo, la ejecución queda `done` (ejecutar) o `practiced` (aprender); con un error, `error` no la
 *   cierra: se puede reintentar ese tramo (vuelve a `draft` con `start_stage`).
 */
create or replace function flow.finish_stage(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions; v_pos int := (p->'args'->>'position')::int; v_status text := p->'args'->>'status'; v_cur jsonb; v_stage flow.definition_stages;
  v_last int; v_stages jsonb; v_exec_status text;
begin
  perform flow.proc_begin();
  v := flow.lock_execution(p);
  select * into v_stage from flow.definition_stages where version_id = v.version_id and position = v_pos and deleted_at is null;
  select s into v_cur from jsonb_array_elements(v.stages) s where (s->>'position')::int = v_pos and s->>'status' in ('draft', 'error');
  if v_stage.id is null or v_cur is null then perform core.fail('STAGE_NOT_READY', 409, jsonb_build_object('position', v_pos)); end if;
  if v_status is null or v_status not in ('done', 'error', 'skipped', 'practiced')
     or (v_status = 'practiced' and v.mode <> 'learn')
     or (v_status in ('done', 'error') and v.mode = 'learn' and v_stage.kind = 'capability')
     or (v_status = 'skipped' and exists (select 1 from flow.definition_steps where stage_id = v_stage.id and essential and deleted_at is null)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'status not valid here', 'mode', v.mode, 'kind', v_stage.kind, 'status', v_status));
  end if;
  v_cur := v_cur || jsonb_build_object('status', v_status, 'result', p->'args'->'result', 'receipt_id', p->'args'->'receipt_id', 'error', p->'args'->'error', 'at', now());
  v_stages := (select jsonb_agg(case when (s->>'position')::int = v_pos then v_cur else s end order by (s->>'position')::int) from jsonb_array_elements(v.stages) s);
  select max(position) into v_last from flow.definition_stages where version_id = v.version_id and deleted_at is null;
  v_exec_status := case when v_pos = v_last and v_status in ('done', 'skipped', 'practiced') then (case when v.mode = 'learn' then 'practiced' else 'done' end) else 'draft' end;
  perform flow.upd(p, 'flow.executions', v.id, v.revision, jsonb_build_object('stages', v_stages, 'status', v_exec_status,
    'finished_at', case when v_exec_status <> 'draft' then now() end,
    'result', case when v_exec_status <> 'draft' then (select jsonb_agg(jsonb_build_object('position', s->'position', 'result', s->'result')) from jsonb_array_elements(v_stages) s) else v.result end));
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v.id, 'position', v_pos, 'status', v_status, 'execution_status', v_exec_status);
end $$;

select core.allow_procedure('flow', 'flow.publish_version');
select core.allow_procedure('flow', 'flow.start_stage');
select core.allow_procedure('flow', 'flow.save_stage_values');
select core.allow_procedure('flow', 'flow.finish_stage');

-- Central: un paso por fila, ahora con su tramo y su tipo; la app es la de la capacidad del tramo (o la del `handoff`).
create or replace view flow.journey_steps_projection as
  select d.id as flow_id, d.name as flow_name, v.version, s.key as step,
         coalesce(split_part(st.capability, '.', 1), st.target_app, 'flow') as app,
         coalesce(s.anchor, st.capability, st.target_anchor) as feature_id, st.capability,
         st.position as stage, st.kind as stage_kind
    from flow.definitions d
    join flow.definition_versions v on v.definition_id = d.id and v.deleted_at is null and v.status = 'published'
    join flow.definition_stages st on st.version_id = v.id and st.deleted_at is null
    join flow.definition_steps s on s.stage_id = st.id and s.deleted_at is null
   where d.deleted_at is null;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
