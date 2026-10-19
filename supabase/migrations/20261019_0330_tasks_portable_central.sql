-- Ikisai Tasks · R2/P2 «2c»: la copia portable con espacios, oficios, personas y comentarios (docs/tasks/API.md §3.2, §6 y
-- §30). Toca el schema tasks; de Recursos y de Central solo lee `resources.spaces` y llama a `central.trade_alive` y
-- `central.person_alive` (1508), como el hook.
--
-- - tasks.import_rows admite también `project_spaces`, `task_spaces`, `project_trades`, `task_trades`, `project_people`,
--   `task_people` y `task_comments`, en orden canónico. Las filas siguen pasando por core.apply_row_op y por todos los
--   hooks (ámbitos, claves, duplicados, catálogo).
-- - Los espacios, oficios y personas son de Recursos y de Central: no se reasignan. Lo que ya no existe o no está vivo no
--   hace fallar la importación entera: esas filas se descartan (los responsables persona se vacían y los filtros de las
--   vistas guardadas se limpian) y el resultado lo dice en `dropped {spaces, trades, people}` (ids distintos).
-- - Comentarios: cada fila puede traer `meta {author_id, author_name, created_at}`. En modo importación el trigger
--   tasks.comment_author los respeta: el autor se conserva si su cuenta existe (si no, queda quien importa con el nombre
--   original) y la hora de creación es la de la copia.
-- - tasks.validate_comments (copiada entera de 0328): en modo importación un comentario puede nacer en una tarea que la
--   copia trae en la papelera, y su foto puede ser un archivo verificado de Tasks que subió otra persona (la importación
--   reutiliza el que ya tenga la misma huella).

-- ---------------------------------------------------------------------------
-- Autor de un comentario: en una importación, el de la copia
-- ---------------------------------------------------------------------------
create or replace function tasks.comment_author()
returns trigger language plpgsql as $$
declare
  v_actor uuid := new.updated_by;
  v_meta jsonb;
  v_author uuid;
  v_at timestamptz;
begin
  if tg_op = 'INSERT' then
    if v_actor is null then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a comment needs an author')); end if;
    new.author_id := v_actor;
    new.author_name := left(coalesce((select p.display_name from core.profiles p where p.user_id = v_actor), ''), 200);
    if coalesce(current_setting('tasks.import_mode', true), '') <> '' and coalesce(current_setting('tasks.import_comment', true), '') <> '' then
      v_meta := current_setting('tasks.import_comment', true)::jsonb;
      begin v_author := (v_meta->>'author_id')::uuid; exception when others then v_author := null; end;
      if v_author is not null and exists (select 1 from auth.users u where u.id = v_author) then new.author_id := v_author; end if;
      if coalesce(btrim(v_meta->>'author_name'), '') <> '' then new.author_name := left(v_meta->>'author_name', 200); end if;
      begin v_at := (v_meta->>'created_at')::timestamptz; exception when others then v_at := null; end;
      if v_at is not null and v_at <= now() then new.created_at := v_at; end if;
    end if;
  else
    new.author_id := old.author_id;
    new.author_name := old.author_name;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Comentarios (copiada entera de 0328, con las excepciones del modo importación)
-- ---------------------------------------------------------------------------
create or replace function tasks.validate_comments(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_role text;
  v_scopes jsonb;
  v_ok boolean;
  v_id uuid;
  c record;
begin
  select m.role, tasks.effective_scopes(m.role, m.scopes) into v_role, v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;

  -- a) El outsider: marcar hecha y comentar, en lo que tiene abierto; nada más ------------------------------------
  if v_role = 'outsider' then
    for c in select ch.* from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.op <> 'call' order by ch.seq loop
      if c.schema_name = 'tasks' and c.table_name = 'tasks' and c.op = 'update' then
        v_ok := c.before->>'deleted_at' is null
          and tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid)
          and not exists (select 1 from jsonb_each(c.after) a
                           where a.key not in ('revision', 'updated_at', 'updated_by', 'done', 'done_at')
                             and (c.before->a.key) is distinct from a.value);
      elsif c.schema_name = 'tasks' and c.table_name = 'task_comments' and c.op in ('insert', 'update', 'delete', 'restore') then
        v_ok := tasks.scope_project(v_scopes, (coalesce(c.after, c.before)->>'tab_id')::uuid, (coalesce(c.after, c.before)->>'project_id')::uuid)
          and (c.before is null or tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid));
      else
        v_ok := false;
      end if;
      if not coalesce(v_ok, false) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', c.schema_name || '.' || c.table_name, 'id', c.row_id, 'reason', 'outsider'));
      end if;
    end loop;
  end if;

  -- b) Comentarios, para todos ---------------------------------------------------------------------------------
  for c in select ch.* from core.changes ch
           where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'task_comments'
             and ch.op in ('insert', 'update', 'delete', 'restore') order by ch.seq loop
    if c.op = 'insert' then
      -- Una copia puede traer comentarios de tareas que están en su papelera: se importan con ellas.
      if not exists (select 1 from tasks.tasks t where t.id = (c.after->>'task_id')::uuid and (t.deleted_at is null or v_import)) then
        perform core.fail('TASK_UNAVAILABLE', 422, jsonb_build_object('commentId', c.row_id, 'taskId', c.after->>'task_id'));
      end if;
    elsif c.before->>'author_id' is distinct from v_actor::text then
      -- De otra persona: mover con su tarea (sin tocar el texto ni la foto), o la propietaria borra o restaura.
      if c.op = 'update' then
        v_ok := (c.before->>'body') is not distinct from (c.after->>'body') and (c.before->>'file_id') is not distinct from (c.after->>'file_id');
      else
        v_ok := v_role = 'owner';
      end if;
      if not v_ok then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.task_comments', 'id', c.row_id, 'reason', 'only the author'));
      end if;
    end if;
    if c.after->>'file_id' is not null and (c.before is null or (c.before->>'file_id') is distinct from (c.after->>'file_id')) then
      -- Al importar, la foto puede ser el archivo verificado con la misma huella que subió otra persona.
      if not exists (select 1 from core.files f where f.id = (c.after->>'file_id')::uuid and f.app = v_app and f.status = 'verified'
                       and (f.created_by = v_actor or v_import) and f.mime in ('image/webp', 'image/jpeg', 'image/png')) then
        perform core.fail('FILE_NOT_UPLOADED', 422, jsonb_build_object('commentId', c.row_id));
      end if;
    end if;
  end loop;

  -- c) Los comentarios vivos siguen a su tarea (los del lote y los de las tareas del lote) --------------------------
  select cm.id into v_id from tasks.task_comments cm join tasks.tasks t on t.id = cm.task_id
   where cm.deleted_at is null and (cm.tab_id <> t.tab_id or cm.project_id <> t.project_id)
     and (cm.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'task_comments')
          or cm.task_id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks'))
   limit 1;
  if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
end $$;

-- ---------------------------------------------------------------------------
-- ¿Sigue vivo? Espacio de Recursos (vivo y activo), oficio y persona de Central. Un texto que no es uuid, no.
-- ---------------------------------------------------------------------------
create or replace function tasks.import_ref_alive(p_kind text, p_value text)
returns boolean language plpgsql stable as $$
begin
  if p_kind = 'person' and p_value ~ '^level:(direccion|staff|outsider)$' then return true; end if;
  if p_value is null or p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if p_kind = 'space' then
    return exists (select 1 from resources.spaces s where s.id = p_value::uuid and s.deleted_at is null and s.active);
  elsif p_kind = 'view_space' then
    return exists (select 1 from resources.spaces s where s.id = p_value::uuid and s.deleted_at is null);
  elsif p_kind = 'trade' then
    return central.trade_alive(p_value::uuid);
  elsif p_kind = 'person' then
    return central.person_alive(p_value::uuid);
  end if;
  return false;
end $$;

-- ---------------------------------------------------------------------------
-- Importar una copia portable (§3.2): las tablas de siempre, las de espacios, oficios y personas, y los comentarios
-- ---------------------------------------------------------------------------
create or replace function tasks.import_rows(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_rows jsonb := coalesce(v_args->'rows', '{}'::jsonb);
  v_order text[] := array['tasks.tabs','tasks.families','tasks.labels','tasks.projects','tasks.tasks','tasks.project_labels','tasks.task_labels',
    'tasks.project_spaces','tasks.task_spaces','tasks.project_trades','tasks.task_trades','tasks.project_people','tasks.task_people',
    'tasks.task_dependencies','tasks.saved_views','tasks.attachments','tasks.task_comments'];
  v_table text; v_row jsonb; v_fields jsonb; v_total int := 0; v_count int; v_inserted jsonb := '{}'::jsonb; v_key text;
  v_spaces text[] := '{}'; v_trades text[] := '{}'; v_people text[] := '{}';
  v_filters jsonb; v_values jsonb; v_kept jsonb; v_value text; v_kind text;
begin
  if jsonb_typeof(v_rows) <> 'object' then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'rows must be an object')); end if;
  for v_key in select jsonb_object_keys(v_rows) loop
    if not (v_key = any(v_order)) then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'unknown table', 'table', v_key)); end if;
    if jsonb_typeof(v_rows->v_key) <> 'array' then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'rows must be arrays', 'table', v_key)); end if;
    v_total := v_total + jsonb_array_length(v_rows->v_key);
  end loop;
  if v_total = 0 or v_total > 20000 then perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'between 1 and 20000 rows', 'rows', v_total)); end if;

  perform set_config('tasks.import_mode', coalesce(v_args->>'mode', 'portable'), true);
  foreach v_table in array v_order loop
    v_count := 0;
    for v_row in select * from jsonb_array_elements(coalesce(v_rows->v_table, '[]'::jsonb)) loop
      if v_row->>'id' is null or jsonb_typeof(coalesce(v_row->'fields', '{}'::jsonb)) <> 'object' then
        perform core.fail('INVALID_IMPORT', 422, jsonb_build_object('reason', 'row needs id and fields', 'table', v_table));
      end if;
      v_fields := coalesce(v_row->'fields', '{}'::jsonb);

      -- Lo que es de Recursos o de Central y ya no está vivo se descarta (no se reasigna nunca).
      if v_table in ('tasks.project_spaces', 'tasks.task_spaces') and not tasks.import_ref_alive('space', v_fields->>'space_id') then
        v_spaces := v_spaces || (v_fields->>'space_id');
        continue;
      elsif v_table in ('tasks.project_trades', 'tasks.task_trades') and not tasks.import_ref_alive('trade', v_fields->>'trade_id') then
        v_trades := v_trades || (v_fields->>'trade_id');
        continue;
      elsif v_table in ('tasks.project_people', 'tasks.task_people') and v_fields->>'person_id' is not null
            and not tasks.import_ref_alive('person', v_fields->>'person_id') then
        v_people := v_people || (v_fields->>'person_id');
        continue;
      elsif v_table in ('tasks.projects', 'tasks.tasks') and v_fields->>'owner_person_id' is not null
            and not tasks.import_ref_alive('person', v_fields->>'owner_person_id') then
        v_people := v_people || (v_fields->>'owner_person_id');
        v_fields := v_fields || jsonb_build_object('owner_person_id', null);
      elsif v_table = 'tasks.saved_views' and jsonb_typeof(v_fields->'filters') = 'object' then
        v_filters := v_fields->'filters';
        for v_key, v_kind in select * from (values ('_space', 'view_space'), ('_trade', 'trade'), ('_person', 'person'), ('_exclude', 'exclude')) k(key, kind) loop
          v_values := v_filters->v_key;
          continue when jsonb_typeof(v_values) is distinct from 'array';
          v_kept := '[]'::jsonb;
          for v_value in select jsonb_array_elements_text(v_values) loop
            if v_kind = 'exclude' then
              -- «Sin…»: etiquetas (ya importadas, o del catálogo General) y espacios, oficios o personas vivos.
              if exists (select 1 from tasks.labels l where l.id::text = v_value) or tasks.import_ref_alive('view_space', v_value)
                 or tasks.import_ref_alive('trade', v_value) or tasks.import_ref_alive('person', v_value) then
                v_kept := v_kept || to_jsonb(v_value);
              end if;
            elsif tasks.import_ref_alive(v_kind, v_value) then
              v_kept := v_kept || to_jsonb(v_value);
            elsif v_kind = 'view_space' then v_spaces := v_spaces || v_value;
            elsif v_kind = 'trade' then v_trades := v_trades || v_value;
            else v_people := v_people || v_value;
            end if;
          end loop;
          v_filters := jsonb_set(v_filters, array[v_key], v_kept);
        end loop;
        v_fields := v_fields || jsonb_build_object('filters', v_filters);
      end if;

      if v_table = 'tasks.task_comments' then
        perform set_config('tasks.import_comment', coalesce((v_row->'meta')::text, ''), true);
      end if;
      perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
        jsonb_build_object('op', 'insert', 'table', v_table, 'id', v_row->>'id', 'fields', v_fields));
      if v_table = 'tasks.task_comments' then perform set_config('tasks.import_comment', '', true); end if;
      if coalesce((v_row->>'deleted')::boolean, false) then
        perform core.apply_row_op(p->>'app', (p->>'actor')::uuid, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
          jsonb_build_object('op', 'delete', 'table', v_table, 'id', v_row->>'id', 'expectedRevision', 1));
      end if;
      v_count := v_count + 1;
    end loop;
    if v_count > 0 then v_inserted := v_inserted || jsonb_build_object(v_table, v_count); end if;
  end loop;
  return jsonb_build_object('inserted', v_inserted, 'rows', v_total, 'dropped', jsonb_build_object(
    'spaces', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(v_spaces) x),
    'trades', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(v_trades) x),
    'people', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb) from unnest(v_people) x)));
end $$;
