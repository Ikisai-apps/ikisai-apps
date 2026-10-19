-- Ikisai Tasks · O1, pasos 3 y 4 (RECURSOS.md §14.2; docs/tasks/API.md §31; decisiones del usuario del 18-10-2026).
-- Toca el schema tasks y, del núcleo, solo llama a sus registros (contrato §3.10). No escribe en core.memberships.
--
-- Paso 3 · propuestas del outsider (sugerencias del núcleo, 0092/0094/0095):
-- - Dos tipos, solo para el rol `outsider` de Tasks:
--   · 'tarea' («Tarea nueva»): el alta en tasks.tasks y lo que la hace nacer bien (las etiquetas, espacios, oficios y
--     personas propios de su proyecto, como `createTaskOps`) y, si quiere, una foto como adjunto.
--   · 'anadido' («Añadido a una tarea»): un paso (tarea hija) nuevo, con lo heredado del proyecto, o una línea más en la
--     nota (`update` de `note`).
-- - `tasks.suggestion_check` (aviso `on_submit`, 0095) lo comprueba al proponer, en la misma transacción que `core.suggest`:
--   si falla, la propuesta no se crea. El outsider solo propone en lo que tiene abierto (`tasks.effective_scopes`: vacío o
--   «*» es nada), solo con los campos de una tarea nueva, y solo lo heredado de ese proyecto. La foto tiene que ser una
--   imagen verificada de Tasks subida por quien propone.
-- - Al aprobar, el núcleo aplica el lote (o el corregido por quien aprueba, p. ej. con otro proyecto) como `core.commit` de
--   quien aprueba: pasa por todos los hooks con sus permisos y sus ámbitos. Ahí ya no se mira lo del outsider.
-- - `detail` tiene que decir la verdad sobre el destino (proyecto, área y, en un añadido, la tarea): el hook de app
--   `suggestionVisible` (0098, `_domain/tasks/suggestions.ts`) lo usa para la tarea de una línea en la nota, cuyo `update`
--   no lleva `tab_id` ni `project_id`. Un añadido toca una sola tarea (la del paso, o la de la nota).
--
-- Paso 4 · «Abrir a…» y Accesos para outsiders: sin SQL de Tasks. La propietaria cambia los ámbitos de un outsider con
-- `POST members {userId, role: 'outsider', scopes}` (C24, 0097 del núcleo).

-- ---------------------------------------------------------------------------
-- Paso 3 · comprobación al proponer
-- ---------------------------------------------------------------------------

-- ¿Viene el valor heredado de su proyecto? (etiquetas, espacios, oficios y personas propios del proyecto, vivos)
create or replace function tasks.suggestion_inherited(p_table text, p_project uuid, f jsonb)
returns boolean language sql stable as $$
  select case p_table
    when 'task_labels' then exists (select 1 from tasks.project_labels x where x.project_id = p_project and x.deleted_at is null and x.label_id::text = f->>'label_id')
    when 'task_spaces' then exists (select 1 from tasks.project_spaces x where x.project_id = p_project and x.deleted_at is null and x.space_id::text = f->>'space_id')
    when 'task_trades' then exists (select 1 from tasks.project_trades x where x.project_id = p_project and x.deleted_at is null and x.trade_id::text = f->>'trade_id')
    when 'task_people' then exists (select 1 from tasks.project_people x where x.project_id = p_project and x.deleted_at is null
                                      and x.person_id::text is not distinct from f->>'person_id' and x.house_level is not distinct from f->>'house_level')
    else false end;
$$;

create or replace function tasks.suggestion_check(p jsonb)
returns void language plpgsql as $$
declare
  s jsonb := p->'suggestion';
  v_kind text := p->>'kind';
  v_author uuid;
  v_role text;
  v_scopes jsonb;
  v_ops jsonb;
  v_op jsonb;
  f jsonb;
  v_table text;
  v_new uuid;            -- la tarea (o el paso) que nace
  v_new_tab uuid;
  v_new_project uuid;
  v_parent uuid;
  v_inserts int := 0;
  v_notes int := 0;
  v_target uuid;         -- en un añadido, la única tarea que toca (la del paso o la de la nota)
  v_target_tab uuid;
  v_target_project uuid;
  d jsonb := case when jsonb_typeof(p->'suggestion'->'detail') = 'object' then p->'suggestion'->'detail' else '{}'::jsonb end;
  pr tasks.projects;
  t tasks.tasks;
  v_task_keys text[] := array['tab_id', 'project_id', 'parent_id', 'title', 'note', 'done', 'priority', 'due', 'owner_label_id', 'cost', 'position'];
  v_child_keys text[] := array['tab_id', 'project_id', 'task_id', 'label_id', 'space_id', 'trade_id', 'person_id', 'house_level'];
  v_file_keys text[] := array['tab_id', 'project_id', 'task_id', 'name', 'mime', 'size', 'sha256', 'file_id', 'position'];
begin
  -- Solo como aviso de `core.suggest` (lleva la sugerencia). Llamado como procedimiento de un lote, no hace nada útil: falla.
  if s is null or jsonb_typeof(s) <> 'object' or p->>'app' is distinct from 'tasks' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('procedure', 'tasks.suggestion_check'));
  end if;
  v_author := (s->'author'->>'id')::uuid;
  v_ops := s->'operations';
  select m.role, tasks.effective_scopes(m.role, m.scopes) into v_role, v_scopes from core.memberships m where m.app = 'tasks' and m.user_id = v_author;
  if v_role is distinct from 'outsider' then
    perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'only outsiders suggest in tasks'));
  end if;

  -- 1. La tarea que nace (como mucho una), dentro de lo abierto.
  for v_op in select * from jsonb_array_elements(v_ops) loop
    if v_op->>'table' = 'tasks.tasks' and v_op->>'op' = 'insert' then
      v_inserts := v_inserts + 1;
      f := coalesce(v_op->'fields', '{}'::jsonb);
      if v_inserts > 1 or exists (select 1 from jsonb_object_keys(f) k where k <> all(v_task_keys)) or coalesce((f->>'done')::boolean, false)
         or f->>'owner_label_id' is not null or f->>'cost' is not null then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'only a new pending task', 'kind', v_kind));
      end if;
      v_new := (v_op->>'id')::uuid;
      v_new_tab := (f->>'tab_id')::uuid;
      v_new_project := (f->>'project_id')::uuid;
      v_parent := nullif(f->>'parent_id', '')::uuid;
      select * into pr from tasks.projects where id = v_new_project;
      if pr.id is null or pr.deleted_at is not null or pr.status = 'archived' or pr.tab_id is distinct from v_new_tab then
        perform core.fail('PROJECT_UNAVAILABLE', 422, jsonb_build_object('projectId', v_new_project));
      end if;
      if not tasks.scope_project(v_scopes, pr.tab_id, pr.id) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'outside your scopes', 'projectId', pr.id));
      end if;
      if v_kind = 'tarea' and v_parent is not null then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'a new task has no parent'));
      end if;
      if v_kind = 'anadido' then
        if v_parent is null then perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'a step needs its task')); end if;
        select * into t from tasks.tasks where id = v_parent;
        if t.id is null or t.deleted_at is not null then perform core.fail('TASK_UNAVAILABLE', 422, jsonb_build_object('taskId', v_parent)); end if;
        if t.project_id <> pr.id then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('taskId', v_parent)); end if;
      end if;
    end if;
  end loop;

  -- 2. Cada operación, según su tabla.
  for v_op in select * from jsonb_array_elements(v_ops) loop
    v_table := v_op->>'table';
    f := coalesce(v_op->'fields', '{}'::jsonb);
    if v_table = 'tasks.tasks' and v_op->>'op' = 'insert' then
      continue;
    elsif v_table = 'tasks.tasks' and v_op->>'op' = 'update' and v_kind = 'anadido' then
      -- Una línea en la nota de una tarea de lo abierto; o reabrir la madre que recibe su primer paso (como createTaskOps).
      select * into t from tasks.tasks where id = (v_op->>'id')::uuid;
      if t.id is null or t.deleted_at is not null then perform core.fail('TASK_UNAVAILABLE', 422, jsonb_build_object('taskId', v_op->>'id')); end if;
      if not tasks.scope_project(v_scopes, t.tab_id, t.project_id) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'outside your scopes', 'taskId', t.id));
      end if;
      if exists (select 1 from jsonb_object_keys(f) k where k not in ('note', 'done'))
         or (f ? 'done' and (coalesce((f->>'done')::boolean, true) or t.id is distinct from v_parent))
         or (f ? 'note' and (jsonb_typeof(f->'note') <> 'string' or length(f->>'note') > 20000)) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'only a line in the note', 'taskId', t.id));
      end if;
      -- Una sola tarea: la madre del paso, si lo hay, o la de la nota.
      if (v_parent is not null and t.id is distinct from v_parent) or (v_target is not null and t.id is distinct from v_target) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'one task at a time', 'taskId', t.id));
      end if;
      v_target := t.id; v_target_tab := t.tab_id; v_target_project := t.project_id;
      if f ? 'note' then v_notes := v_notes + 1; end if;
    elsif v_table in ('tasks.task_labels', 'tasks.task_spaces', 'tasks.task_trades', 'tasks.task_people') and v_op->>'op' = 'insert' then
      if v_new is null or (f->>'task_id')::uuid is distinct from v_new or (f->>'tab_id')::uuid is distinct from v_new_tab
         or (f->>'project_id')::uuid is distinct from v_new_project
         or exists (select 1 from jsonb_object_keys(f) k where k <> all(v_child_keys))
         or not tasks.suggestion_inherited(split_part(v_table, '.', 2), v_new_project, f) then
        perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'only what the project gives', 'table', v_table));
      end if;
    elsif v_table = 'tasks.attachments' and v_op->>'op' = 'insert' and v_kind = 'tarea' then
      -- La foto: una imagen verificada de Tasks, subida por quien propone, en la tarea que nace.
      if v_new is null or (f->>'task_id')::uuid is distinct from v_new or (f->>'tab_id')::uuid is distinct from v_new_tab
         or (f->>'project_id')::uuid is distinct from v_new_project
         or exists (select 1 from jsonb_object_keys(f) k where k <> all(v_file_keys))
         or not exists (select 1 from core.files cf where cf.id::text = f->>'file_id' and cf.app = 'tasks' and cf.status = 'verified' and cf.created_by = v_author
                          and cf.mime in ('image/webp', 'image/jpeg', 'image/png') and cf.sha256 = f->>'sha256' and cf.size::text = f->>'size') then
        perform core.fail('FILE_NOT_UPLOADED', 422, jsonb_build_object('reason', 'the photo must be an image you uploaded'));
      end if;
    else
      perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'operation not allowed', 'op', v_op->>'op', 'table', v_table, 'kind', v_kind));
    end if;
  end loop;

  if v_kind = 'tarea' and v_inserts <> 1 then
    perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'a new task', 'kind', v_kind));
  end if;
  if v_kind = 'anadido' and ((v_inserts = 1 and v_parent is null) or v_inserts + v_notes = 0) then
    perform core.fail('SUGGESTION_NOT_ALLOWED', 403, jsonb_build_object('reason', 'a step or a line in the note', 'kind', v_kind));
  end if;

  -- 3. `detail` dice la verdad sobre el destino (lo usa `suggestionVisible` para saber de qué proyecto es).
  if v_kind = 'anadido' then
    if v_parent is not null then v_target := v_parent; v_target_tab := v_new_tab; v_target_project := v_new_project; end if;
    if lower(d->>'taskId') is distinct from v_target::text or lower(d->>'projectId') is distinct from v_target_project::text
       or lower(d->>'tabId') is distinct from v_target_tab::text then
      perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('reason', 'detail must name the task, its project and its area', 'taskId', v_target));
    end if;
  elsif (d ? 'projectId' and lower(d->>'projectId') is distinct from v_new_project::text) or (d ? 'tabId' and lower(d->>'tabId') is distinct from v_new_tab::text) then
    perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('reason', 'detail must name the project of the task', 'projectId', v_new_project));
  end if;
end $$;

select core.allow_procedure('tasks', 'tasks.suggestion_check');
select core.register_suggestion_kind('tasks', 'tarea', 'Tarea nueva',
  array['tasks.tasks', 'tasks.task_labels', 'tasks.task_spaces', 'tasks.task_trades', 'tasks.task_people', 'tasks.attachments'], '{insert}', '{}', '{outsider}');
select core.register_suggestion_kind('tasks', 'anadido', 'Añadido a una tarea',
  array['tasks.tasks', 'tasks.task_labels', 'tasks.task_spaces', 'tasks.task_trades', 'tasks.task_people'], '{insert,update}', '{}', '{outsider}');
select core.set_suggestion_on_submit('tasks', 'tarea', 'tasks.suggestion_check');
select core.set_suggestion_on_submit('tasks', 'anadido', 'tasks.suggestion_check');
