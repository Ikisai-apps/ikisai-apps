-- Ikisai Tasks · autoauditoría del 27-10-2026 (la misma pasada que a las otras apps): los procedimientos de Tasks se
-- defienden solos, aunque la Edge ya no deje llamarlos desde `commands`. Toca solo el schema tasks.
-- - tasks.import_rows: solo la propietaria con acceso a toda la app. El modo importación salta guardas (autor de los
--   comentarios, tareas bloqueadas, proyectos archivados).
-- - tasks.request_task: editor u owner. Una referencia de una fuente de sistema (booking, feedback, core, invoices), o
--   `projectRef` u `onBehalfOf`, solo con la identidad de servicio de esa fuente. Así nadie se adelanta a una referencia
--   de Booking ni mete trabajo en un proyecto de otra área por `projectRef`.
-- - tasks.request_project: solo la identidad de servicio de su fuente. El proyecto existente se busca por su referencia,
--   no por un id cualquiera.
-- - Ayudantes: tasks.system_source(prefijo) da el servicio de una fuente de sistema; tasks.actor_is_service(actor, servicio).
-- Copias de 0330 (import_rows), 0353 (request_task) y 0313 (request_project) con lo de arriba.

create or replace function tasks.system_source(p_prefix text)
returns text language sql immutable as $$
  select case p_prefix when 'booking' then 'booking' when 'feedback' then 'feedback' when 'core' then 'core' when 'invoices' then 'drive' end
$$;

create or replace function tasks.actor_is_service(p_actor uuid, p_service text)
returns boolean language sql stable as $$
  select p_service is not null and exists (select 1 from core.profiles pf where pf.user_id = p_actor and pf.kind = 'service' and pf.service_name = p_service)
$$;

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
  v_scopes jsonb;
begin
  -- 0355: solo la propietaria con acceso a toda la app (como `admin()` de la Edge): el modo importación salta guardas.
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if not found or coalesce(p->>'role', '') <> 'owner' or not tasks.scope_all(v_scopes) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access'));
  end if;
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

create or replace function tasks.request_task(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_actor uuid := (p->>'actor')::uuid;
  v_ref text := v_args->>'externalRef';
  v_kind text := v_args->>'kind';
  v_url text := nullif(v_args->>'externalUrl', '');
  -- §22: en nombre de quién se pide (metadato, nunca el actor): {kind: internal|organizer|guest, report_code}.
  v_behalf jsonb := case when jsonb_typeof(v_args->'onBehalfOf') = 'object' then v_args->'onBehalfOf' end;
  v_scopes jsonb;
  v_id uuid;
  v_tab uuid;
  v_project uuid;
  v_owner uuid;
  v_owner_person uuid;
  v_owner_level text;
  v_how text;
  v_hint_tab uuid;
  v_hint_project uuid;
  v_space uuid;
  v_position numeric;
  v_hash text;
  rr record;
  l record;
begin
  -- 0355: editor u owner; y una referencia de una fuente de sistema, o lo que solo manda un worker (projectRef y
  -- onBehalfOf), solo con la identidad de servicio de esa fuente (como tasks.refresh_request_task).
  if coalesce(p->>'role', '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  if tasks.system_source(split_part(coalesce(v_ref, ''), ':', 1)) is not null or coalesce(v_args->>'projectRef', '') <> '' or v_behalf is not null then
    if not tasks.actor_is_service(v_actor, tasks.system_source(split_part(coalesce(v_ref, ''), ':', 1))) then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'system sources, projectRef and onBehalfOf: only that source''s service identity'));
    end if;
  end if;
  begin v_id := (v_args->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null or v_ref is null or v_ref !~ '^[a-z][a-z0-9_-]{1,30}:.+$' or length(v_ref) > 182
     or v_kind is null or v_kind !~ '^[a-z][a-z0-9_-]{1,30}\.[a-z0-9][a-z0-9_.-]{0,60}$' or split_part(v_kind, '.', 1) <> split_part(v_ref, ':', 1) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id, externalRef and kind (of the same source) required'));
  end if;
  -- Ya existe (tarea o petición, por id o por referencia viva): no se toca nada; la ruta devuelve lo que hay.
  if exists (select 1 from tasks.tasks t where t.id = v_id) or exists (select 1 from tasks.requests rq where rq.id = v_id)
     or exists (select 1 from tasks.tasks t where t.external_ref = v_ref and t.deleted_at is null)
     or exists (select 1 from tasks.requests rq where rq.external_ref = v_ref and rq.deleted_at is null) then
    return jsonb_build_object('created', false, 'id', v_id);
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = p->>'app' and m.user_id = v_actor;
  begin v_hint_tab := nullif(v_args->>'tabId', '')::uuid; exception when others then v_hint_tab := null; end;
  begin v_hint_project := nullif(v_args->>'projectId', '')::uuid; exception when others then v_hint_project := null; end;
  -- 0336: el espacio del que se avisa (hallazgo 8 de La Muela). Solo si es un espacio vivo y activo de Recursos; si no, sin espacio
  -- (la petición no se rechaza por eso).
  begin v_space := nullif(v_args->>'spaceId', '')::uuid; exception when others then v_space := null; end;
  if v_space is not null and not exists (select 1 from resources.spaces s where s.id = v_space and s.deleted_at is null and s.active) then v_space := null; end if;

  -- 0. Un extra de un retiro (§23) va al proyecto de su reserva; si aún no existe, no se da de alta nada.
  if coalesce(v_args->>'projectRef', '') <> '' then
    select pr.tab_id, pr.id into v_tab, v_project from tasks.projects pr
      join tasks.tabs tb on tb.id = pr.tab_id and tb.deleted_at is null
      where pr.external_ref = v_args->>'projectRef' and pr.deleted_at is null;
    if v_project is null then return jsonb_build_object('created', false, 'id', v_id, 'routed', 'no_project'); end if;
    v_how := 'hint';
  end if;
  -- 1. La regla del usuario para este tipo, si su destino sigue vivo.
  select r.* into rr from tasks.request_routes r join tasks.tabs tb on tb.id = r.tab_id and tb.deleted_at is null
    where r.kind = v_kind and r.deleted_at is null;
  if v_how is null and rr.id is not null then
    if rr.project_id is not null then
      select pr.id into v_project from tasks.projects pr where pr.id = rr.project_id and pr.tab_id = rr.tab_id and pr.deleted_at is null and pr.status <> 'archived';
    else
      select pr.id into v_project from tasks.projects pr where pr.tab_id = rr.tab_id and pr.system = 'inbox' and pr.deleted_at is null;
    end if;
    if v_project is not null then
      v_tab := rr.tab_id; v_how := 'rule';
      select lb.id into v_owner from tasks.labels lb join tasks.families f on f.id = lb.family_id
        where lb.id = rr.owner_label_id and lb.tab_id = rr.tab_id and lb.deleted_at is null and f.system_key = 'person';
      -- O la persona de Central (si sigue viva) o el grupo por nivel de casa de la regla (P2, PR 3).
      if rr.owner_person_id is not null and central.person_alive(rr.owner_person_id) then v_owner_person := rr.owner_person_id; end if;
      v_owner_level := rr.owner_house_level;
    end if;
  end if;
  -- 2. La sugerencia de quien pide, si la ve (con una sugerencia nadie mete trabajo donde no alcanza).
  if v_how is null and v_hint_project is not null then
    select pr.tab_id, pr.id into v_tab, v_project from tasks.projects pr
      join tasks.tabs tb on tb.id = pr.tab_id and tb.deleted_at is null
      where pr.id = v_hint_project and pr.deleted_at is null and pr.status <> 'archived' and (v_hint_tab is null or pr.tab_id = v_hint_tab)
        and tasks.scope_project(v_scopes, pr.tab_id, pr.id);
    if v_project is not null then v_how := 'hint'; end if;
  elsif v_how is null and v_hint_tab is not null and tasks.scope_full(v_scopes, v_hint_tab) then
    select pr.tab_id, pr.id into v_tab, v_project from tasks.projects pr join tasks.tabs tb on tb.id = pr.tab_id and tb.deleted_at is null
      where pr.tab_id = v_hint_tab and pr.system = 'inbox' and pr.deleted_at is null;
    if v_project is not null then v_how := 'hint'; end if;
  end if;

  perform set_config('tasks.external_request', v_ref, true);
  perform set_config('tasks.external_request_id', v_id::text, true);
  -- 3. La petición queda siempre registrada: enrutada, o pendiente en «Por clasificar».
  perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'insert', 'table', 'tasks.requests', 'id', v_id, 'fields', jsonb_build_object(
      'source', split_part(v_ref, ':', 1), 'kind', v_kind, 'kind_label', nullif(btrim(coalesce(v_args->>'kindLabel', '')), ''),
      'external_ref', v_ref, 'external_url', v_url, 'title', btrim(coalesce(v_args->>'title', '')), 'note', coalesce(v_args->>'note', ''),
      'due', nullif(v_args->>'due', ''), 'priority', coalesce(v_args->>'priority', 'normal'),
      'suggested_tab_id', v_hint_tab, 'suggested_project_id', v_hint_project, 'requested_by', v_actor,
      'status', case when v_how is null then 'pending' else 'routed' end, 'routed_by', v_how, 'on_behalf_of', v_behalf, 'space_id', v_space)));
  if v_how is null then
    return jsonb_build_object('created', true, 'id', v_id, 'routed', 'pending');
  end if;

  select coalesce(max(t.position), 0) + 1024 into v_position from tasks.tasks t where t.project_id = v_project;
  perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_id, 'fields', jsonb_build_object(
      'tab_id', v_tab, 'project_id', v_project, 'title', btrim(coalesce(v_args->>'title', '')), 'note', coalesce(v_args->>'note', ''),
      'priority', coalesce(v_args->>'priority', 'normal'), 'due', nullif(v_args->>'due', ''), 'position', v_position, 'owner_label_id', v_owner,
      'owner_person_id', v_owner_person, 'owner_house_level', v_owner_level,
      'external_ref', v_ref, 'external_kind', v_kind, 'external_url', v_url, 'external_on_behalf', v_behalf->>'kind')));
  -- Las etiquetas del proyecto, como al crear una tarea en la app; ids derivados del de la tarea.
  for l in select pl.label_id from tasks.project_labels pl where pl.project_id = v_project and pl.deleted_at is null order by pl.label_id loop
    v_hash := md5(v_id::text || ':' || l.label_id::text);
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_labels',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'label_id', l.label_id)));
  end loop;
  -- Y los espacios del proyecto (R2, decisión del usuario: la tarea nueva hereda el espacio de su proyecto).
  for l in select ps.space_id from tasks.project_spaces ps where ps.project_id = v_project and ps.deleted_at is null order by ps.space_id loop
    v_hash := md5(v_id::text || ':space:' || l.space_id::text);
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_spaces',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'space_id', l.space_id)));
  end loop;
  -- Y el espacio de la petición (0336), si el proyecto no lo traía ya; mismo id derivado que el del proyecto.
  if v_space is not null and not exists (select 1 from tasks.project_spaces ps where ps.project_id = v_project and ps.space_id = v_space and ps.deleted_at is null) then
    v_hash := md5(v_id::text || ':space:' || v_space::text);
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_spaces',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'space_id', v_space)));
  end if;
  -- Y sus oficios de Central (P2), igual que el espacio; más el de la regla (0353), si la petición entró por ella y el
  -- oficio sigue vivo. Sin repetir: el mismo oficio una sola vez.
  for l in select x.trade_id from (
             select pt.trade_id from tasks.project_trades pt where pt.project_id = v_project and pt.deleted_at is null
             union
             select rr.trade_id where v_how = 'rule' and rr.trade_id is not null and central.trade_alive(rr.trade_id)
           ) x order by x.trade_id loop
    v_hash := md5(v_id::text || ':trade:' || l.trade_id::text);
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'trade_id', l.trade_id)));
  end loop;
  -- Y sus personas de Central (P2, PR 3), igual que el oficio; una persona que Central archivó no se hereda.
  for l in select pp.person_id, pp.house_level from tasks.project_people pp
            where pp.project_id = v_project and pp.deleted_at is null and (pp.person_id is null or central.person_alive(pp.person_id))
            order by tasks.person_value(pp.person_id, pp.house_level) loop
    v_hash := md5(v_id::text || ':person:' || tasks.person_value(l.person_id, l.house_level));
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_people',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'person_id', l.person_id, 'house_level', l.house_level)));
  end loop;
  return jsonb_build_object('created', true, 'id', v_id, 'routed', v_how);
end $$;

create or replace function tasks.request_project(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_actor uuid := (p->>'actor')::uuid;
  v_ref text := v_args->>'externalRef';
  v_kind text := v_args->>'kind';
  v_name text := btrim(coalesce(v_args->>'name', ''));
  v_state text := coalesce(v_args->>'state', 'confirmed');
  v_id uuid;
  v_tab uuid;
  v_position numeric;
  v_fields jsonb := '{}'::jsonb;
  pr record;
begin
  begin v_id := (v_args->>'id')::uuid; exception when others then v_id := null; end;
  if v_id is null or v_ref is null or v_ref !~ '^[a-z][a-z0-9_-]{1,30}:.+$' or length(v_ref) > 182
     or v_kind is null or split_part(v_kind, '.', 1) <> split_part(v_ref, ':', 1)
     or length(v_name) < 1 or length(v_name) > 300 or v_state not in ('confirmed', 'cancelled') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'id, externalRef, kind, name and state required'));
  end if;
  -- 0355: solo la identidad de servicio de la fuente (Booking, para los retiros), y la referencia es la suya.
  if not tasks.actor_is_service(v_actor, tasks.system_source(split_part(v_ref, ':', 1))) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only the service identity of its source'));
  end if;
  perform set_config('tasks.external_project', v_ref, true);
  -- 0355: por id solo si es el de esa misma referencia (no se renombra ni archiva otro proyecto con un id ajeno).
  select * into pr from tasks.projects t where (t.id = v_id and t.external_ref = v_ref) or (t.external_ref = v_ref and t.deleted_at is null)
    order by t.deleted_at nulls first limit 1;
  if pr.id is not null then
    -- En la papelera: alguien lo borró a propósito; otra app no lo resucita.
    if pr.deleted_at is not null then return jsonb_build_object('id', pr.id, 'status', 'deleted'); end if;
    if v_state = 'cancelled' then
      if pr.status = 'archived' then return jsonb_build_object('id', pr.id, 'status', 'unchanged'); end if;
      v_fields := jsonb_build_object('status', 'archived');
    else
      if pr.title is distinct from v_name then v_fields := v_fields || jsonb_build_object('title', v_name); end if;
      if pr.status = 'archived' then v_fields := v_fields || jsonb_build_object('status', 'active'); end if;
    end if;
    if v_fields = '{}'::jsonb then return jsonb_build_object('id', pr.id, 'status', 'unchanged'); end if;
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'update', 'table', 'tasks.projects', 'id', pr.id, 'expectedRevision', pr.revision, 'fields', v_fields));
    return jsonb_build_object('id', pr.id, 'status', case
      when v_fields->>'status' = 'archived' then 'archived'
      when v_fields->>'status' = 'active' then 'restored'
      else 'renamed' end);
  end if;
  -- Sin proyecto todavía: una cancelación no crea nada.
  if v_state = 'cancelled' then return jsonb_build_object('id', null, 'status', 'unchanged'); end if;
  -- El área la fija la regla del usuario para este tipo (su proyecto, si lo tiene, no cuenta: el proyecto es el retiro).
  select r.tab_id into v_tab from tasks.request_routes r join tasks.tabs tb on tb.id = r.tab_id and tb.deleted_at is null
    where r.kind = v_kind and r.deleted_at is null;
  if v_tab is null then return jsonb_build_object('id', null, 'status', 'no_route'); end if;
  select coalesce(max(t.position), 0) + 1024 into v_position from tasks.projects t where t.tab_id = v_tab;
  perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_id, 'fields', jsonb_build_object(
      'tab_id', v_tab, 'title', v_name, 'note', coalesce(v_args->>'note', ''), 'position', v_position, 'external_ref', v_ref)));
  return jsonb_build_object('id', v_id, 'status', 'created');
end $$;

do $$
declare f text;
begin
  foreach f in array array['tasks.system_source(text)', 'tasks.actor_is_service(uuid, text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
