-- Ikisai Flow · clases de actividad en `flow.units` (flow-19; D1 del roadmap de Core, MOTOR_GENERICO_ROADMAP.md §2).
-- - `class`: `operation` (la de siempre: una tarea que se hace), `objective` (tiene criterios de aceptación y unidades
--   dependientes; se cumple cuando todos los criterios están verificados, nunca por un toque), `station` (actividad continua:
--   tocar asume, volver a tocar libera; nunca se termina) y `result` (hecho verificable: guarda el vínculo tipado a lo que lo
--   prueba y quién lo verificó).
-- - `parent_id`: la unidad de la que depende (las tareas de un objetivo).
-- - `criteria` (objetivos): [{id, text, verified_at, verified_by, evidence}]; `result_link` (resultados): {app, kind, id};
--   `verified_by`/`verified_at`: quién y cuándo dio por verificado el objetivo o el resultado.
-- - Las reglas valen también dentro de los procedimientos (las comprueba un trigger): ningún camino da por hecho un objetivo
--   con criterios sin verificar, ni termina una actividad continua.

alter table flow.units add column class text not null default 'operation' check (class in ('operation', 'objective', 'station', 'result'));
update flow.units set class = 'station' where kind = 'station';
alter table flow.units add column parent_id uuid references flow.units(id);
alter table flow.units add column criteria jsonb check (criteria is null or (jsonb_typeof(criteria) = 'array' and jsonb_array_length(criteria) <= 30));
alter table flow.units add column result_link jsonb check (result_link is null or (jsonb_typeof(result_link) = 'object'
  and coalesce(result_link->>'app', '') ~ '^[a-z][a-z0-9_]{1,30}$' and coalesce(result_link->>'id', '') <> '' and length(result_link::text) <= 500));
alter table flow.units add column verified_by uuid references auth.users(id);
alter table flow.units add column verified_at timestamptz;
alter table flow.units add constraint units_class_shape check (
  (class <> 'objective' or criteria is not null) and (class <> 'result' or result_link is not null) and (class <> 'station' or kind = 'station'));
create index units_parent_idx on flow.units (parent_id) where parent_id is not null;

select core.register_table('flow', 'flow', 'units', array['project_id','column_key','kind','order_id','line_id','product_id','idx','pay_seq','label','priority','status','assigned_to','done_at','done_by','payload','source_ref','lane_key','prio','board_flag','class','parent_id','criteria','result_link','verified_by','verified_at'], '{reader,editor,owner,outsider}', '{editor,owner,outsider}', true);

create or replace function flow.guard_class() returns trigger language plpgsql as $$
begin
  -- Un puesto (kind station) es siempre actividad continua, lo cree quien lo cree.
  if tg_op = 'INSERT' and new.kind = 'station' then new.class := 'station'; end if;
  -- Clase, criterios, vínculo, verificación y dependencia: solo por procedimiento (nadie se verifica a sí mismo a mano).
  if not flow.in_proc() and (
       (tg_op = 'INSERT' and (new.class <> 'operation' or new.criteria is not null or new.result_link is not null or new.verified_by is not null
                              or new.verified_at is not null or new.parent_id is not null))
       or (tg_op = 'UPDATE' and flow.changed(to_jsonb(old), to_jsonb(new), array['class', 'criteria', 'result_link', 'verified_by', 'verified_at', 'parent_id']))) then
    perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'activity class fields'));
  end if;
  -- Una unidad solo depende de otra viva del mismo proyecto (nada de colgarla de un proyecto ajeno).
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id)
     and not exists (select 1 from flow.units u where u.id = new.parent_id and u.project_id = new.project_id and u.deleted_at is null and u.id <> new.id) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units', 'parent_id', new.parent_id));
  end if;
  if new.class = 'station' and new.status = 'done' then perform core.fail('STATION_NEVER_DONE', 422, jsonb_build_object('unit_id', new.id)); end if;
  if new.class = 'objective' and new.status = 'done' and (tg_op = 'INSERT' or old.status <> 'done')
     and (jsonb_array_length(coalesce(new.criteria, '[]'::jsonb)) = 0
          or exists (select 1 from jsonb_array_elements(new.criteria) c where c->>'verified_at' is null)) then
    perform core.fail('OBJECTIVE_NOT_MET', 409, jsonb_build_object('unit_id', new.id));
  end if;
  if new.class = 'result' and new.status = 'done' and new.verified_by is null then perform core.fail('RESULT_NOT_VERIFIED', 409, jsonb_build_object('unit_id', new.id)); end if;
  -- La clase no se cambia una vez creada (una operación no se convierte en objetivo a mitad).
  if tg_op = 'UPDATE' and new.class is distinct from old.class then perform core.fail('PROCEDURE_ONLY', 422, jsonb_build_object('table', 'flow.units', 'reason', 'class is fixed')); end if;
  return new;
end $$;
create trigger flow_class before insert or update on flow.units for each row execute function flow.guard_class();

/**
 * Crear un objetivo con sus criterios (editor u owner, en su ámbito). args = { unit_id, project_id, column_key, label, criteria: [texto], parent_id? }
 */
create or replace function flow.add_objective(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_id uuid := flow.arg_uuid(p, 'unit_id'); v_criteria jsonb; v_label text := btrim(coalesce(p->'args'->>'label', ''));
begin
  perform flow.proc_begin();
  if p->>'role' not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, null); end if;
  perform flow.check_scope(p, v_project);
  if v_label = '' or length(v_label) > 120 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'label')); end if;
  if jsonb_typeof(p->'args'->'criteria') <> 'array' or jsonb_array_length(p->'args'->'criteria') not between 1 and 30
     or exists (select 1 from jsonb_array_elements(p->'args'->'criteria') c where jsonb_typeof(c) <> 'string' or length(btrim(c #>> '{}')) not between 1 and 300) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'criteria', 'reason', '1 to 30 texts'));
  end if;
  select jsonb_agg(jsonb_build_object('id', 'c' || n, 'text', btrim(c #>> '{}'), 'verified_at', null, 'verified_by', null) order by n)
    into v_criteria from jsonb_array_elements(p->'args'->'criteria') with ordinality as t(c, n);
  perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_project, 'column_key', coalesce(p->'args'->>'column_key', 'logistics'), 'kind', 'task',
    'class', 'objective', 'label', v_label, 'status', 'pending', 'criteria', v_criteria,
    'parent_id', case when coalesce(p->'args'->>'parent_id', '') <> '' then flow.arg_uuid(p, 'parent_id') end), v_id);
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v_id, 'criteria', jsonb_array_length(v_criteria));
end $$;

/**
 * Verificar (o desverificar) un criterio de un objetivo. args = { unit_id, criterion_id, verified: bool, evidence? }
 * Con todos verificados, el objetivo queda hecho (y lo verificó quien cerró el último); al desverificar uno, vuelve a pendiente.
 */
create or replace function flow.verify_criterion(p jsonb) returns jsonb language plpgsql as $$
declare v flow.units; v_cid text := p->'args'->>'criterion_id'; v_on boolean := coalesce((p->'args'->>'verified')::boolean, true); v_criteria jsonb; v_all boolean;
begin
  perform flow.proc_begin();
  if p->>'role' not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, null); end if;
  select * into v from flow.units where id = flow.arg_uuid(p, 'unit_id') and deleted_at is null for update;
  if v.id is null or v.class <> 'objective' then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.units')); end if;
  perform flow.check_scope(p, v.project_id);
  if not exists (select 1 from jsonb_array_elements(v.criteria) c where c->>'id' = v_cid) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('criterion', v_cid)); end if;
  if length(coalesce(p->'args'->>'evidence', '')) > 500 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'evidence')); end if;
  select jsonb_agg(case when c->>'id' = v_cid then c || jsonb_build_object(
      'verified_at', case when v_on then to_jsonb(now()) else 'null'::jsonb end,
      'verified_by', case when v_on then to_jsonb((p->>'actor')::uuid) else 'null'::jsonb end,
      'evidence', case when v_on then to_jsonb(nullif(p->'args'->>'evidence', '')) else 'null'::jsonb end) else c end order by n)
    into v_criteria from jsonb_array_elements(v.criteria) with ordinality as t(c, n);
  v_all := not exists (select 1 from jsonb_array_elements(v_criteria) c where c->>'verified_at' is null);
  perform flow.upd(p, 'flow.units', v.id, v.revision, jsonb_build_object('criteria', v_criteria,
    'status', case when v_all then 'done' when v.status = 'done' then 'pending' else v.status end,
    'done_at', case when v_all then coalesce(v.done_at, now()) end, 'done_by', case when v_all then coalesce(v.done_by, (p->>'actor')::uuid) end,
    'verified_by', case when v_all then (p->>'actor')::uuid end, 'verified_at', case when v_all then now() end));
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v.id, 'met', v_all);
end $$;

/**
 * Anotar un resultado verificable (editor u owner): queda hecho y verificado por quien lo anota, con el vínculo a lo que lo
 * prueba. args = { unit_id, project_id, column_key, label, link: {app, kind, id}, parent_id? }
 */
create or replace function flow.record_result(p jsonb) returns jsonb language plpgsql as $$
declare v_project uuid := flow.arg_uuid(p, 'project_id'); v_id uuid := flow.arg_uuid(p, 'unit_id'); v_link jsonb := p->'args'->'link'; v_label text := btrim(coalesce(p->'args'->>'label', ''));
begin
  perform flow.proc_begin();
  if p->>'role' not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, null); end if;
  perform flow.check_scope(p, v_project);
  if v_label = '' or length(v_label) > 120 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'label')); end if;
  if jsonb_typeof(v_link) <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'link')); end if;
  v_link := jsonb_build_object('app', v_link->>'app', 'kind', v_link->>'kind', 'id', v_link->>'id');
  perform flow.ins(p, 'flow.units', jsonb_build_object('project_id', v_project, 'column_key', coalesce(p->'args'->>'column_key', 'logistics'), 'kind', 'task',
    'class', 'result', 'label', v_label, 'status', 'done', 'done_at', now(), 'done_by', (p->>'actor')::uuid, 'result_link', v_link,
    'verified_by', (p->>'actor')::uuid, 'verified_at', now(),
    'parent_id', case when coalesce(p->'args'->>'parent_id', '') <> '' then flow.arg_uuid(p, 'parent_id') end), v_id);
  perform flow.proc_end();
  return jsonb_build_object('unit_id', v_id);
end $$;

select core.allow_procedure('flow', 'flow.add_objective');
select core.allow_procedure('flow', 'flow.verify_criterion');
select core.allow_procedure('flow', 'flow.record_result');

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
