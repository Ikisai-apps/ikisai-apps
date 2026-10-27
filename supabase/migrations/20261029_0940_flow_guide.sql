-- Ikisai Flow · Guiado (flow-23; contrato de UI-kit aprobado por Core, análisis en ANALISIS_GUIADO_flow-23.md).
-- Dos capacidades del catálogo para que el Guiado del kit, dentro de otra app, sepa qué pasos de una ejecución le tocan:
-- - `flow.guide_read {execution_id, app}`: los pasos de esa app (anclaje con su prefijo) y los propios de Flow (`app = null`:
--   decisión, nota, espera), con `done`. Solo quien hace la ejecución. La ruta y la confirmación de cada anclaje las añade
--   flow-api con la lectura por id de campo del núcleo (`core_field_lookup`, 0109).
-- - `flow.guide_confirm {requestId, execution_id, step_id, how, pending}`: recibo de que la app confirmó el paso (guardado,
--   evento, a mano). Nunca valores de campo. Idempotente por requestId (recibo del núcleo).
-- `done` (decisión de Core, 27-10): hay confirmación de la app (`save` o `event`, sin `pending`); en los pasos propios de
-- Flow, que el tramo tenga ese valor o esté cerrado.

create table flow.guide_receipts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  execution_id uuid not null references flow.executions(id),
  step_id uuid not null references flow.definition_steps(id),
  how text not null check (how in ('save', 'event', 'manual', 'none')),
  pending boolean not null default false
);
create index guide_receipts_execution_idx on flow.guide_receipts (execution_id, step_id);
-- Como las ejecuciones: no se sincroniza al personal; solo el owner lo lee. Se escribe solo por procedimiento.
select core.register_table('flow', 'flow', 'guide_receipts', array['execution_id','step_id','how','pending'], '{owner}', '{editor,owner}', true);
create trigger flow_guard before insert or update on flow.guide_receipts for each row execute function flow.guard_marks();

/** La app de un paso: el primer segmento de su anclaje (la app dueña de esa pantalla); sin anclaje, null (paso propio de Flow). */
create or replace function flow.step_app(p_anchor text) returns text language sql immutable as $$
  select nullif(split_part(coalesce(p_anchor, ''), '.', 1), '')
$$;

-- args = { execution_id, app }. Solo quien hace la ejecución (si no, como si no existiera).
create or replace function flow.guide_steps_read(p jsonb) returns jsonb language plpgsql stable as $$
declare v flow.executions; v_app text := nullif(p->'args'->>'app', ''); v_def text;
begin
  begin v := (select e from flow.executions e where e.id = (p->'args'->>'execution_id')::uuid and e.deleted_at is null);
  exception when others then v := null; end;
  if v.id is null or v.actor is distinct from (p->>'actor')::uuid then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.executions')); end if;
  select d.name into v_def from flow.definition_versions dv join flow.definitions d on d.id = dv.definition_id where dv.id = v.version_id;
  return jsonb_build_object('id', v.id, 'title', v_def, 'mode', v.mode, 'status', v.status,
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object('id', s.id, 'key', s.key, 'title', s.title, 'explain', s.explain, 'anchor', s.anchor,
               'app', flow.step_app(s.anchor), 'essential', s.essential, 'stage', st.position,
               'done', exists (select 1 from flow.guide_receipts r where r.execution_id = v.id and r.step_id = s.id and r.deleted_at is null
                                and r.how in ('save', 'event') and not r.pending)
                       or (flow.step_app(s.anchor) is null and (
                             exists (select 1 from jsonb_array_elements(v.stages) x where (x->>'position')::int = st.position and x->>'status' in ('done', 'practiced'))
                             or exists (select 1 from jsonb_array_elements(v.stages) x where (x->>'position')::int = st.position
                                          and jsonb_typeof((x->'values') #> string_to_array(s.key, '.')) not in ('null')))))
             order by st.position, s.position)
        from flow.definition_steps s join flow.definition_stages st on st.id = s.stage_id and st.deleted_at is null
       where s.version_id = v.version_id and s.deleted_at is null
         and (flow.step_app(s.anchor) is null or flow.step_app(s.anchor) = v_app)), '[]'::jsonb));
end $$;
select core.allow_read('flow', 'flow.guide_steps_read', 'function', '{reader,editor,owner,outsider}');

-- args = { execution_id, step_id, how, pending }. Recibo, nunca valores.
create or replace function flow.guide_confirm(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions; v_step uuid := flow.arg_uuid(p, 'step_id'); v_how text := p->'args'->>'how'; v_id uuid;
begin
  perform flow.proc_begin();
  select * into v from flow.executions where id = flow.arg_uuid(p, 'execution_id') and deleted_at is null;
  if v.id is null or v.actor is distinct from (p->>'actor')::uuid then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.executions')); end if;
  if v.mode = 'learn' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'a rehearsal confirms nothing outside Flow')); end if;
  if v_how is null or v_how not in ('save', 'event', 'manual', 'none') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'how')); end if;
  if not exists (select 1 from flow.definition_steps where id = v_step and version_id = v.version_id and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.definition_steps'));
  end if;
  v_id := flow.ins(p, 'flow.guide_receipts', jsonb_build_object('execution_id', v.id, 'step_id', v_step, 'how', v_how,
    'pending', coalesce((p->'args'->>'pending')::boolean, false)));
  perform flow.proc_end();
  return jsonb_build_object('ok', true, 'receipt_id', v_id);
end $$;
select core.allow_procedure('flow', 'flow.guide_confirm');
select core.allow_outsider_procedure('flow', 'flow.guide_confirm');

select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.guide_read', 'app', 'flow', 'kind', 'read', 'title', 'Pasos del Guiado de una ejecución',
  'description', 'Los pasos de un recorrido en curso que tocan a una app (y los propios de Flow), con su anclaje, ruta, confirmación y si ya están hechos. Solo quien hace la ejecución.',
  'route', 'POST guide-read', 'roles', jsonb_build_array('reader', 'editor', 'owner', 'outsider'), 'risk', 'low', 'idempotent', true,
  'input', '{"type":"object","required":["execution_id","app"],"properties":{"execution_id":{"type":"string","format":"uuid"},"app":{"type":"string"}}}'::jsonb,
  'output', '{"type":"object","properties":{"id":{"type":"string"},"title":{"type":"string"},"mode":{"type":"string"},"steps":{"type":"array"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.recorridos'), 'since', '0940'));
select core.register_capability(jsonb_build_object(
  'id', 'flow' || '.guide_confirm', 'app', 'flow', 'kind', 'execute', 'title', 'Confirmar un paso del Guiado',
  'description', 'Recibo de que la app confirmó un paso de un recorrido en curso (guardado, evento o a mano). Sin valores. Idempotente por requestId.',
  'route', 'POST guide-confirm', 'roles', jsonb_build_array('reader', 'editor', 'owner', 'outsider'), 'risk', 'low', 'idempotent', true, 'reversible', false,
  'input', '{"type":"object","required":["requestId","execution_id","step_id","how"],"properties":{"requestId":{"type":"string"},"execution_id":{"type":"string","format":"uuid"},"step_id":{"type":"string","format":"uuid"},"how":{"enum":["save","event","manual","none"]},"pending":{"type":"boolean"}}}'::jsonb,
  'output', '{"type":"object","properties":{"ok":{"type":"boolean"},"replayed":{"type":"boolean"}}}'::jsonb,
  'anchors', jsonb_build_array('flow.recorridos'), 'since', '0940'));

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
