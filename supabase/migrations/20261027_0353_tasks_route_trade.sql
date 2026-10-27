-- Ikisai Tasks · reglas de entrada con oficio (encargo de Core del 27-10-2026, para la limpieza de cama de Booking, §48;
-- docs/tasks/API.md §48). Toca solo el schema tasks y, del núcleo, solo usa register_table, add_validate_hook y fail.
-- - tasks.request_routes.trade_id: el oficio de Central de la regla (opcional). Lo que entra por la regla lo lleva en sus
--   oficios (task_trades), además de los del proyecto, sin repetir. Así la limpieza de una cama cae en quien limpia sin
--   que nadie la clasifique.
-- - Hook tasks.validate_route_trade: el oficio de una regla, vivo en Central.
-- - tasks.request_task: copia de 0336 con el oficio de la regla.
-- - Siembra, solo si aún no hay regla para `booking.bed_cleaning`: hacia el proyecto vivo «Limpieza» (si hay uno y solo
--   uno) con el oficio vivo «Limpieza» de Central (si hay uno y solo uno). Si falta alguno, no siembra: la regla se pone
--   en «Gestionar entradas». Por nombre, sin ids fijos (repo público).

alter table tasks.request_routes add column if not exists trade_id uuid;
select core.register_table('tasks', 'tasks', 'request_routes', array['kind','kind_label','tab_id','project_id','owner_label_id','position','owner_person_id','owner_house_level','trade_id'], '{reader,editor,owner}', '{owner}');

create or replace function tasks.validate_route_trade(p jsonb)
returns void language plpgsql as $$
declare c record;
begin
  for c in select ch.row_id, ch.after from core.changes ch
            where ch.app = p->>'app' and ch.cursor = (p->>'cursor')::bigint and ch.schema_name = 'tasks' and ch.table_name = 'request_routes'
              and ch.op in ('insert', 'update', 'restore') and ch.after->>'trade_id' is not null loop
    if not central.trade_alive((c.after->>'trade_id')::uuid) then
      perform core.fail('INVALID_TRADE', 422, jsonb_build_object('table', 'tasks.request_routes', 'id', c.row_id, 'field', 'trade_id'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_route_trade');

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
  -- (la peticiÃ³n no se rechaza por eso).
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
  -- Y el espacio de la peticiÃ³n (0336), si el proyecto no lo traÃ­a ya; mismo id derivado que el del proyecto.
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

do $$
declare v_project tasks.projects; v_trade uuid; n int;
begin
  if exists (select 1 from tasks.request_routes where kind = 'booking.bed_cleaning' and deleted_at is null) then return; end if;
  select count(*) into n from tasks.projects pr join tasks.tabs tb on tb.id = pr.tab_id and tb.deleted_at is null
   where pr.deleted_at is null and pr.status <> 'archived' and pr.system is null and lower(btrim(pr.title)) = 'limpieza';
  if n <> 1 then return; end if;
  select pr.* into v_project from tasks.projects pr join tasks.tabs tb on tb.id = pr.tab_id and tb.deleted_at is null
   where pr.deleted_at is null and pr.status <> 'archived' and pr.system is null and lower(btrim(pr.title)) = 'limpieza';
  select count(*) into n from central.trades t where t.deleted_at is null and lower(btrim(t.name)) = 'limpieza' and central.trade_alive(t.id);
  if n <> 1 then return; end if;
  select t.id into v_trade from central.trades t where t.deleted_at is null and lower(btrim(t.name)) = 'limpieza' and central.trade_alive(t.id);
  insert into tasks.request_routes (id, kind, kind_label, tab_id, project_id, position, trade_id)
  values (md5('ikisai-tasks-route:booking.bed_cleaning')::uuid, 'booking.bed_cleaning', 'Limpieza · Salida de huésped', v_project.tab_id, v_project.id,
          coalesce((select max(position) from tasks.request_routes), 0) + 1024, v_trade)
  on conflict (id) do nothing;
end $$;

revoke all on function tasks.validate_route_trade(jsonb) from public, anon, authenticated;
grant execute on function tasks.validate_route_trade(jsonb) to service_role;
