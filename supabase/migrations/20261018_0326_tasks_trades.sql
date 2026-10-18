-- Ikisai Tasks · fase P2, PR 1: los oficios de Central en lugar de la familia «Tipo: Acción» (coordinacion/ampliacion/
-- RECURSOS.md §13.3; docs/tasks/API.md §32). Es la réplica de R2 (0322-0324) para los oficios. Toca el schema tasks y de
-- Central solo llama a central.trade_alive (1508): nunca lee sus tablas ni sus vistas.
-- - tasks.task_trades y tasks.project_trades: uno o varios oficios por tarea o proyecto (trade_id sin clave foránea; lo
--   valida el hook con central.trade_alive). La tarea nueva hereda los del proyecto (dominio y peticiones).
-- - tasks.settings: `trade_source` = 'labels' (sin fila) o 'central'; `trade_families`, las familias que archivó la ida
--   (para desarchivar justo esas al volver). Solo los cambian los procedimientos.
-- - La correspondencia etiqueta → oficio la calcula tasks-api (TypeScript, desde la lectura central.trade_options con el
--   usuario que pide) y llega como argumento `map` [{labelId, tradeId, reason}]. Aquí cada oficio se revalida con
--   central.trade_alive.
-- - tasks.trades_preview (lectura de la propietaria con acceso completo, a través de tasks-api): qué cambiaría al pasar las
--   acciones a oficios (o al volver atrás), con las dudosas.
-- - tasks.actions_to_trades: en un lote y con historial, pone a cada tarea y proyecto el oficio de su acción más honda,
--   reescribe las vistas guardadas, archiva (nunca borra) la familia General «Tipo: Acción» y sus copias de área no
--   archivadas, y pasa `trade_source` a 'central'. task_labels y project_labels se conservan: son la copia para volver.
-- - tasks.trades_to_actions: la marcha atrás (lo cambiado en oficios vuelve a etiquetas por la correspondencia inversa).
-- - tasks.empty_trash_prepare, tasks.convert_tab_into_project y tasks.request_task (copiadas de 0324): los oficios siguen
--   a sus tareas como los espacios.
-- - tasks.validate_batch (copiada entera de 0324): claves, duplicados y oficio vivo; `_trade` en las vistas; buzón.
-- Las funciones que llaman a central.trade_alive son plpgsql: se resuelve al ejecutar (1508 va detrás en el orden de nombres).

create table tasks.project_trades (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  trade_id uuid not null
);
create index project_trades_project_idx on tasks.project_trades (project_id, trade_id) where deleted_at is null;
create index project_trades_trade_idx on tasks.project_trades (trade_id);

create table tasks.task_trades (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  task_id uuid not null references tasks.tasks(id),
  trade_id uuid not null
);
create index task_trades_task_idx on tasks.task_trades (task_id, trade_id) where deleted_at is null;
create index task_trades_trade_idx on tasks.task_trades (trade_id);
create index task_trades_project_idx on tasks.task_trades (project_id);

create trigger tasks_guard_immutable before update on tasks.project_trades for each row execute function tasks.guard_immutable('tab_id', 'project_id', 'trade_id');
create trigger tasks_guard_immutable before update on tasks.task_trades for each row execute function tasks.guard_immutable('tab_id', 'task_id', 'trade_id');

select core.register_table('tasks', 'tasks', 'project_trades', array['tab_id','project_id','trade_id']);
select core.register_table('tasks', 'tasks', 'task_trades', array['tab_id','project_id','task_id','trade_id']);
-- Los leen los mismos roles que los espacios (si otra migración ya los abrió a más roles, los oficios la siguen).
update core.synced_tables t set readable_roles = s.readable_roles
  from core.synced_tables s
 where s.app = 'tasks' and s.schema_name = 'tasks' and s.table_name = 'task_spaces'
   and t.app = 'tasks' and t.schema_name = 'tasks' and t.table_name in ('task_trades', 'project_trades');

alter table tasks.settings drop constraint settings_key_check;
alter table tasks.settings add constraint settings_key_check check (key in ('zone_source', 'trade_source', 'trade_families'));

-- ---------------------------------------------------------------------------
-- De dónde sale el oficio y qué etiqueta corresponde a qué oficio
-- ---------------------------------------------------------------------------
create or replace function tasks.trade_source()
returns text language sql stable as $$
  select coalesce((select s.value #>> '{}' from tasks.settings s where s.key = 'trade_source' and s.deleted_at is null), 'labels')
$$;

-- Las familias que archivó la ida (las que la vuelta desarchiva).
create or replace function tasks.trade_archived_families()
returns uuid[] language sql stable as $$
  select coalesce((select array_agg(e::uuid) from tasks.settings s
                     cross join lateral jsonb_array_elements_text(case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end) e
                    where s.key = 'trade_families' and s.deleted_at is null), '{}'::uuid[])
$$;

-- Las familias «Tipo: Acción» en juego (por el nombre, sin mayúsculas, espacios ni tildes, como 0321): la General y las
-- copias de área vivas de áreas vivas. Las copias que ya estaban archivadas no se tocan (salvo las que archivó la ida).
create or replace function tasks.action_families()
returns table (family_id uuid) language sql stable as $$
  select f.id from tasks.families f
    left join tasks.tabs tb on tb.id = f.tab_id
   where f.deleted_at is null and translate(lower(btrim(f.name)), 'áéíóú', 'aeiou') = 'tipo: accion'
     and (f.tab_id is null or (tb.deleted_at is null and (not f.archived or f.id = any(tasks.trade_archived_families()))))
$$;

-- La correspondencia que manda tasks-api: una lista de {labelId, tradeId|null, reason?} con uuids válidos.
create or replace function tasks.check_trade_map(p_map jsonb)
returns void language plpgsql as $$
declare v_re text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if p_map is null or jsonb_typeof(p_map) <> 'array' or exists (
       select 1 from jsonb_array_elements(p_map) e
        where jsonb_typeof(e) <> 'object' or coalesce(e->>'labelId', '') !~* v_re
           or (e->>'tradeId' is not null and e->>'tradeId' !~* v_re)) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'map: list of {labelId, tradeId} from tasks-api'));
  end if;
end $$;

-- Cada etiqueta viva de esas familias con su oficio (el de la correspondencia, si sigue vivo) o el motivo por el que no lo
-- tiene: el que dio tasks-api (`no_trade`, `several_trades`) o `trade_inactive`.
create or replace function tasks.action_label_map(p_map jsonb)
returns table (label_id uuid, name text, parent_id uuid, tab_id uuid, trade_id uuid, reason text) language plpgsql stable as $$
begin
  return query
  with m as (
    select distinct on ((e->>'labelId')::uuid) (e->>'labelId')::uuid label_id, (e->>'tradeId')::uuid trade_id, nullif(e->>'reason', '') reason
      from jsonb_array_elements(coalesce(p_map, '[]'::jsonb)) e
     order by (e->>'labelId')::uuid, (e->>'tradeId') nulls last)
  select l.id, l.name, l.parent_id, l.tab_id,
         case when m.trade_id is not null and central.trade_alive(m.trade_id) then m.trade_id end,
         case when m.trade_id is null then coalesce(m.reason, 'no_trade') when not central.trade_alive(m.trade_id) then 'trade_inactive' end
    from tasks.labels l
    join tasks.action_families() af on af.family_id = l.family_id
    left join m on m.label_id = l.id
   where l.deleted_at is null;
end $$;

-- Las acciones de cada tarea y proyecto vivos (en áreas vivas), quedándose con la más honda: con madre e hija, solo la hija.
create or replace function tasks.action_links(p_map jsonb)
returns table (kind text, owner_id uuid, tab_id uuid, project_id uuid, label_id uuid) language sql stable as $$
  with z as (select m.label_id, m.parent_id from tasks.action_label_map(p_map) m),
  links as (
    select 'task'::text kind, tl.task_id owner_id, tl.tab_id, tl.project_id, tl.label_id
      from tasks.task_labels tl join z on z.label_id = tl.label_id
      join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null
      join tasks.tabs tb on tb.id = tl.tab_id and tb.deleted_at is null
     where tl.deleted_at is null
    union
    select 'project', pl.project_id, pl.tab_id, pl.project_id, pl.label_id
      from tasks.project_labels pl join z on z.label_id = pl.label_id
      join tasks.projects pr on pr.id = pl.project_id and pr.deleted_at is null
      join tasks.tabs tb on tb.id = pl.tab_id and tb.deleted_at is null
     where pl.deleted_at is null)
  select a.* from links a
   where not exists (select 1 from links b join z on z.label_id = b.label_id
                      where b.kind = a.kind and b.owner_id = a.owner_id and z.parent_id = a.label_id)
$$;

-- Todos los usos de cada acción y si la tarea o el proyecto conserva algún oficio sin ella (como tasks.zone_uses, 0323).
create or replace function tasks.action_uses(p_map jsonb, p_remove jsonb)
returns table (label_id uuid, kind text, owner_id uuid, covered boolean) language sql stable as $$
  with m as (select * from tasks.action_label_map(p_map)),
  links as (
    select 'task'::text kind, tl.task_id owner_id, tl.label_id
      from tasks.task_labels tl join m on m.label_id = tl.label_id
      join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null
      join tasks.tabs tb on tb.id = tl.tab_id and tb.deleted_at is null
     where tl.deleted_at is null
    union
    select 'project', pl.project_id, pl.label_id
      from tasks.project_labels pl join m on m.label_id = pl.label_id
      join tasks.projects pr on pr.id = pl.project_id and pr.deleted_at is null
      join tasks.tabs tb on tb.id = pl.tab_id and tb.deleted_at is null
     where pl.deleted_at is null)
  select a.label_id, a.kind, a.owner_id,
         exists (select 1 from links b join m on m.label_id = b.label_id
                  where b.kind = a.kind and b.owner_id = a.owner_id and m.trade_id is not null
                    and b.label_id::text not in (select jsonb_array_elements_text(coalesce(p_remove, '[]'::jsonb))))
    from links a
$$;

-- El camino de vuelta: para cada oficio puesto en una tarea o proyecto vivos, su etiqueta. Primero las que ya tenía y casan
-- con ese oficio (la copia que dejó la ida); si no, la de la copia de su área, si el área la tiene; si no, la General. Sin
-- ninguna, `label_id` nulo: ese oficio se perdería al volver.
create or replace function tasks.trade_back(p_map jsonb)
returns table (kind text, owner_id uuid, tab_id uuid, project_id uuid, trade_id uuid, label_id uuid) language sql stable as $$
  with m as (select * from tasks.action_label_map(p_map) x where x.trade_id is not null),
  w as (
    select 'task'::text kind, tt.task_id owner_id, tt.tab_id, tt.project_id, tt.trade_id
      from tasks.task_trades tt
      join tasks.tasks t on t.id = tt.task_id and t.deleted_at is null
      join tasks.tabs tb on tb.id = tt.tab_id and tb.deleted_at is null
     where tt.deleted_at is null
    union
    select 'project', pt.project_id, pt.tab_id, pt.project_id, pt.trade_id
      from tasks.project_trades pt
      join tasks.projects pr on pr.id = pt.project_id and pr.deleted_at is null
      join tasks.tabs tb on tb.id = pt.tab_id and tb.deleted_at is null
     where pt.deleted_at is null),
  own as (
    select 'task'::text kind, tl.task_id owner_id, tl.label_id from tasks.task_labels tl where tl.deleted_at is null
    union
    select 'project', pl.project_id, pl.label_id from tasks.project_labels pl where pl.deleted_at is null),
  kept as (
    select w.kind, w.owner_id, w.tab_id, w.project_id, w.trade_id, m.label_id
      from w join m on m.trade_id = w.trade_id and (m.tab_id is null or m.tab_id = w.tab_id)
      join own o on o.kind = w.kind and o.owner_id = w.owner_id and o.label_id = m.label_id)
  select * from kept
  union all
  select w.kind, w.owner_id, w.tab_id, w.project_id, w.trade_id,
         (select m.label_id from m where m.trade_id = w.trade_id and (m.tab_id is null or m.tab_id = w.tab_id)
           order by (m.tab_id is null), (m.parent_id is not null), m.label_id limit 1)
    from w
   where not exists (select 1 from kept k where k.kind = w.kind and k.owner_id = w.owner_id and k.trade_id = w.trade_id)
$$;

-- Ajustes dentro de un procedimiento (con historial, como cualquier fila).
create or replace function tasks.set_setting(p_app text, p_actor uuid, p_role text, p_req text, p_cur bigint, p_key text, p_value jsonb)
returns void language plpgsql as $$
declare r record;
begin
  select * into r from tasks.settings where key = p_key and deleted_at is null;
  if r.id is null then
    perform core.apply_row_op(p_app, p_actor, p_role, p_req, p_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.settings', 'id', gen_random_uuid(),
      'fields', jsonb_build_object('key', p_key, 'value', p_value)));
  elsif r.value is distinct from p_value then
    perform core.apply_row_op(p_app, p_actor, p_role, p_req, p_cur, jsonb_build_object('op', 'update', 'table', 'tasks.settings', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('value', p_value)));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Lectura: vista previa (propietaria con acceso completo; la pide tasks-api con la correspondencia)
-- args: { "remove": [labelId…], "map": [{labelId, tradeId, reason}…] }
-- Con trade_source = 'labels': lo que haría tasks.actions_to_trades. Con 'central': lo que haría tasks.trades_to_actions.
-- ---------------------------------------------------------------------------
create or replace function tasks.trades_preview(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_scopes jsonb;
  v_role text;
  v_remove jsonb := coalesce(p->'args'->'remove', '[]'::jsonb);
  v_map jsonb := p->'args'->'map';
  v_out jsonb;
begin
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = p->>'app' and m.user_id = (p->>'actor')::uuid;
  if v_role is distinct from 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if jsonb_typeof(v_remove) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'remove: list of label ids')); end if;
  perform tasks.check_trade_map(v_map);

  if tasks.trade_source() = 'central' then
    with b as (select * from tasks.trade_back(v_map))
    select jsonb_build_object(
      'source', 'central',
      'counts', jsonb_build_object(
        'tasks', (select count(distinct tt.task_id) from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id and t.deleted_at is null where tt.deleted_at is null),
        'projects', (select count(distinct pt.project_id) from tasks.project_trades pt join tasks.projects pr on pr.id = pt.project_id and pr.deleted_at is null where pt.deleted_at is null)),
      -- Oficios puestos sin etiqueta a la que volver (no vienen de ninguna acción): al volver atrás se perderían.
      'lost', coalesce((select jsonb_agg(jsonb_build_object('tradeId', x.trade_id, 'tasks', x.tasks, 'projects', x.projects) order by x.trade_id)
                          from (select b.trade_id, count(distinct b.owner_id) filter (where b.kind = 'task') tasks, count(distinct b.owner_id) filter (where b.kind = 'project') projects
                                  from b where b.label_id is null group by b.trade_id) x), '[]'::jsonb))
      into v_out;
    return v_out;
  end if;

  with m as (select * from tasks.action_label_map(v_map)),
  k as (select * from tasks.action_links(v_map)),
  u as (select * from tasks.action_uses(v_map, v_remove)),
  fams as (select family_id from tasks.action_families()),
  per0 as (
    select m.label_id, m.name, m.parent_id, m.trade_id, m.reason,
           (m.label_id::text in (select jsonb_array_elements_text(v_remove))) marked,
           -- Con oficio: las tareas y proyectos que lo recibirán (donde es la acción más honda). Sin él: todos sus usos.
           case when m.trade_id is not null then (select count(*) from k where k.label_id = m.label_id and k.kind = 'task')
                else (select count(*) from u where u.label_id = m.label_id and u.kind = 'task') end tasks,
           case when m.trade_id is not null then (select count(*) from k where k.label_id = m.label_id and k.kind = 'project')
                else (select count(*) from u where u.label_id = m.label_id and u.kind = 'project') end projects,
           (select count(*) from u where u.label_id = m.label_id and not u.covered) without_trade,
           (select jsonb_agg(t.title order by t.title) from (select distinct t.title from u u2 join tasks.tasks t on t.id = u2.owner_id
                                                               where u2.kind = 'task' and u2.label_id = m.label_id order by t.title limit 3) t) sample
      from m),
  per as (
    select per0.*, per0.marked or (per0.trade_id is null and per0.tasks + per0.projects > 0 and per0.without_trade = 0) removed
      from per0)
  select jsonb_build_object(
    'source', 'labels',
    'families', coalesce((select jsonb_agg(f.family_id order by f.family_id) from fams f), '[]'::jsonb),
    'counts', jsonb_build_object(
      'tasks', (select count(distinct k.owner_id) from k where k.kind = 'task' and k.label_id in (select per.label_id from per where per.trade_id is not null and not per.removed)),
      'projects', (select count(distinct k.owner_id) from k where k.kind = 'project' and k.label_id in (select per.label_id from per where per.trade_id is not null and not per.removed)),
      -- Tareas y proyectos que se quedarían sin ningún oficio (sus acciones no tienen oficio o se quitan).
      'withoutTrade', (select count(distinct u.kind || u.owner_id::text) from u where not u.covered),
      'views', (select count(*) from tasks.saved_views v join tasks.tabs tb on tb.id = v.tab_id and tb.deleted_at is null
                 where v.deleted_at is null
                   and (exists (select 1 from fams f where v.filters ? f.family_id::text or v.group_by = f.family_id::text)
                        or exists (select 1 from jsonb_array_elements_text(coalesce(v.filters->'_exclude', '[]'::jsonb)) e where e in (select per.label_id::text from per))))),
    'mapped', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'parentId', per.parent_id, 'tradeId', per.trade_id,
                                                            'tasks', per.tasks, 'projects', per.projects, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name, per.label_id)
                          from per where per.trade_id is not null and not per.removed), '[]'::jsonb),
    -- Quitadas: las marcadas y las «cubiertas» (sin oficio, pero cada tarea y proyecto que las usa tiene otra acción con
    -- oficio). `withoutTrade`: cuántos se quedan sin ningún oficio.
    'removed', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'reason', case when per.marked then 'marked' else 'covered' end,
                                                             'tasks', per.tasks, 'projects', per.projects, 'withoutTrade', per.without_trade, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name, per.label_id)
                           from per where per.removed), '[]'::jsonb),
    -- Dudosas: en uso y sin un oficio vivo. Hasta que se resuelvan (o se marquen para quitar), no se aplica.
    'doubtful', coalesce((select jsonb_agg(jsonb_build_object('labelId', per.label_id, 'name', per.name, 'reason', per.reason, 'tasks', per.tasks, 'projects', per.projects,
                                                              'withoutTrade', per.without_trade, 'sample', coalesce(per.sample, '[]'::jsonb)) order by per.name, per.label_id)
                            from per where per.trade_id is null and not per.removed and per.tasks + per.projects > 0), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;

select core.allow_read('tasks', 'tasks.trades_preview', 'function', '{owner}');

-- ---------------------------------------------------------------------------
-- Procedimiento: pasar las acciones a oficios
-- args: { "remove": [labelId…], "map": [{labelId, tradeId, reason}…] } — solo desde tasks-api (actions/to-trades).
-- ---------------------------------------------------------------------------
create or replace function tasks.actions_to_trades(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_remove jsonb := coalesce(v_args->'remove', '[]'::jsonb);
  v_map jsonb := v_args->'map';
  v_fams text[];
  v_archived jsonb := '[]'::jsonb;
  v_bad jsonb;
  v_filters jsonb;
  v_trades jsonb;
  v_exclude jsonb;
  v_group text;
  v_counts jsonb := jsonb_build_object('taskTrades', 0, 'projectTrades', 0, 'views', 0, 'labels', 0, 'families', 0);
  r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if jsonb_typeof(v_remove) <> 'array' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'remove: list of label ids')); end if;
  perform tasks.check_trade_map(v_map);
  if tasks.trade_source() = 'central' then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'actions are already trades')); end if;
  -- Cada oficio de la correspondencia, revalidado aquí: existe, no está borrado y está activo.
  select jsonb_agg(distinct e->>'tradeId') into v_bad from jsonb_array_elements(v_map) e
   where e->>'tradeId' is not null and not central.trade_alive((e->>'tradeId')::uuid);
  if v_bad is not null then perform core.fail('INVALID_TRADE', 422, jsonb_build_object('tradeIds', v_bad, 'reason', 'trade not found or archived')); end if;

  create temp table if not exists tasks_trade_map on commit drop as select * from tasks.action_label_map('[]'::jsonb) limit 0;
  truncate tasks_trade_map;
  insert into tasks_trade_map select * from tasks.action_label_map(v_map);
  create temp table if not exists tasks_trade_links on commit drop as select * from tasks.action_links('[]'::jsonb) limit 0;
  truncate tasks_trade_links;
  insert into tasks_trade_links select * from tasks.action_links(v_map);
  select coalesce(array_agg(f.family_id::text), '{}') into v_fams from tasks.action_families() f;

  -- Solo se niega por una acción sin oficio que deje a alguien sin ninguno y no esté marcada para quitar.
  select jsonb_agg(jsonb_build_object('labelId', m.label_id, 'name', m.name, 'reason', m.reason) order by m.name) into v_bad
    from tasks_trade_map m
   where m.trade_id is null and m.label_id::text not in (select jsonb_array_elements_text(v_remove))
     and exists (select 1 from tasks.action_uses(v_map, v_remove) u where u.label_id = m.label_id and not u.covered);
  if v_bad is not null then perform core.fail('TRADES_DOUBTFUL', 422, jsonb_build_object('labels', v_bad)); end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. Un oficio por acción más honda de cada tarea y proyecto (sin repetir los que ya tenga). Una madre sin hijas elegidas
  --    es la más honda: pasa a su propio oficio.
  for r in select distinct k.kind, k.owner_id, k.tab_id, k.project_id, m.trade_id
             from tasks_trade_links k join tasks_trade_map m on m.label_id = k.label_id
            where m.trade_id is not null and m.label_id::text not in (select jsonb_array_elements_text(v_remove)) loop
    if r.kind = 'task' then
      continue when exists (select 1 from tasks.task_trades tt where tt.task_id = r.owner_id and tt.trade_id = r.trade_id and tt.deleted_at is null);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.project_id, 'task_id', r.owner_id, 'trade_id', r.trade_id)));
      v_counts := jsonb_set(v_counts, '{taskTrades}', to_jsonb((v_counts->>'taskTrades')::int + 1));
    else
      continue when exists (select 1 from tasks.project_trades pt where pt.project_id = r.owner_id and pt.trade_id = r.trade_id and pt.deleted_at is null);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.project_trades', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.project_id, 'trade_id', r.trade_id)));
      v_counts := jsonb_set(v_counts, '{projectTrades}', to_jsonb((v_counts->>'projectTrades')::int + 1));
    end if;
  end loop;

  -- 2. Vistas guardadas: el filtro y el «sin» por acción pasan a `_trade`; agrupar por la familia, a agrupar por oficio.
  for r in select v.* from tasks.saved_views v
            where v.deleted_at is null and exists (select 1 from tasks.tabs tb where tb.id = v.tab_id and tb.deleted_at is null)
              and (exists (select 1 from jsonb_object_keys(v.filters) k(name) where k.name = any(v_fams)) or v.group_by = any(v_fams)
                   or exists (select 1 from jsonb_array_elements_text(coalesce(v.filters->'_exclude', '[]'::jsonb)) e where e in (select m.label_id::text from tasks_trade_map m))) loop
    -- Los valores que ya eran oficios se conservan; las acciones sin oficio se caen.
    select coalesce(jsonb_agg(distinct coalesce(m.trade_id::text, e)) filter (where m.label_id is null or m.trade_id is not null), '[]'::jsonb) into v_trades
      from (select jsonb_array_elements_text(r.filters->k.name) e from jsonb_object_keys(r.filters) k(name) where k.name = any(v_fams)
            union all select jsonb_array_elements_text(coalesce(r.filters->'_trade', '[]'::jsonb))) x
      left join tasks_trade_map m on m.label_id::text = x.e;
    select coalesce(jsonb_agg(distinct coalesce(m.trade_id::text, e)) filter (where m.label_id is null or m.trade_id is not null), '[]'::jsonb) into v_exclude
      from jsonb_array_elements_text(coalesce(r.filters->'_exclude', '[]'::jsonb)) e
      left join tasks_trade_map m on m.label_id::text = e;
    v_filters := (r.filters - v_fams) - '_trade' - '_exclude';
    if jsonb_array_length(v_trades) > 0 then v_filters := v_filters || jsonb_build_object('_trade', v_trades); end if;
    if jsonb_array_length(v_exclude) > 0 then v_filters := v_filters || jsonb_build_object('_exclude', v_exclude); end if;
    v_group := case when r.group_by = any(v_fams) then '_trade' else r.group_by end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.saved_views', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('filters', v_filters, 'group_by', v_group)));
    v_counts := jsonb_set(v_counts, '{views}', to_jsonb((v_counts->>'views')::int + 1));
  end loop;

  -- 3. Las familias «Tipo: Acción» no archivadas (la General y las copias de área) y sus etiquetas se archivan (nunca se
  --    borran); cada etiqueta recuerda si ya lo estaba y la vuelta desarchiva justo esas familias.
  for r in select f.* from tasks.families f where f.id::text = any(v_fams) and not f.archived order by f.tab_id nulls first, f.id loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.families', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', true)));
    v_archived := v_archived || to_jsonb(r.id);
    v_counts := jsonb_set(v_counts, '{families}', to_jsonb((v_counts->>'families')::int + 1));
  end loop;
  for r in select l.* from tasks.labels l where l.deleted_at is null and l.family_id in (select (x #>> '{}')::uuid from jsonb_array_elements(v_archived) x) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', true, 'archived_before_family', r.archived)));
    v_counts := jsonb_set(v_counts, '{labels}', to_jsonb((v_counts->>'labels')::int + 1));
  end loop;

  -- 4. Desde ahora el oficio sale de Central.
  perform tasks.set_setting(v_app, v_actor, v_role, v_req, v_cur, 'trade_families', v_archived);
  perform tasks.set_setting(v_app, v_actor, v_role, v_req, v_cur, 'trade_source', to_jsonb('central'::text));
  return jsonb_build_object('source', 'central', 'counts', v_counts);
end $$;

-- ---------------------------------------------------------------------------
-- Procedimiento: volver de oficios a acciones (marcha atrás)
-- args: { "dropUnmapped": boolean, "map": [...] } — sin dropUnmapped, falla si algún oficio puesto no tiene etiqueta.
-- ---------------------------------------------------------------------------
create or replace function tasks.trades_to_actions(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_map jsonb := v_args->'map';
  v_fams uuid[];
  v_general uuid;
  v_bad jsonb;
  v_filters jsonb;
  v_labels jsonb;
  v_exclude jsonb;
  v_group text;
  v_key text;
  v_ids jsonb;
  v_counts jsonb := jsonb_build_object('taskLabels', 0, 'projectLabels', 0, 'removedLinks', 0, 'views', 0, 'labels', 0, 'families', 0);
  r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  perform tasks.check_trade_map(v_map);
  if tasks.trade_source() <> 'central' then perform core.fail('INVALID_OPERATION', 409, jsonb_build_object('reason', 'actions are already labels')); end if;

  create temp table if not exists tasks_trade_map on commit drop as select * from tasks.action_label_map('[]'::jsonb) limit 0;
  truncate tasks_trade_map;
  insert into tasks_trade_map select * from tasks.action_label_map(v_map);
  create temp table if not exists tasks_trade_back on commit drop as select * from tasks.trade_back('[]'::jsonb) limit 0;
  truncate tasks_trade_back;
  insert into tasks_trade_back select * from tasks.trade_back(v_map);

  select jsonb_agg(distinct b.trade_id) into v_bad from tasks_trade_back b where b.label_id is null;
  if v_bad is not null and not coalesce((v_args->>'dropUnmapped')::boolean, false) then
    perform core.fail('TRADES_UNMAPPED', 422, jsonb_build_object('tradeIds', v_bad));
  end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. Las familias que archivó la ida y sus etiquetas vuelven como estaban.
  v_fams := tasks.trade_archived_families();
  for r in select f.* from tasks.families f where f.id = any(v_fams) and f.deleted_at is null and f.archived loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.families', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', false)));
    v_counts := jsonb_set(v_counts, '{families}', to_jsonb((v_counts->>'families')::int + 1));
  end loop;
  for r in select l.* from tasks.labels l where l.family_id = any(v_fams) and l.deleted_at is null
             and (l.archived is distinct from coalesce(l.archived_before_family, false) or l.archived_before_family is not null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.labels', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('archived', coalesce(r.archived_before_family, false), 'archived_before_family', null)));
    v_counts := jsonb_set(v_counts, '{labels}', to_jsonb((v_counts->>'labels')::int + 1));
  end loop;

  -- 2. Las acciones de cada tarea y proyecto, desde sus oficios (con la madre, como guarda hoy la interfaz).
  create temp table if not exists tasks_trade_want on commit drop as
    select ''::text kind, null::uuid owner_id, null::uuid tab_id, null::uuid project_id, null::uuid label_id limit 0;
  truncate tasks_trade_want;
  insert into tasks_trade_want
    select distinct b.kind, b.owner_id, b.tab_id, b.project_id, x.id
      from tasks_trade_back b
      join tasks.labels l on l.id = b.label_id
      cross join lateral (select l.id union select l.parent_id where l.parent_id is not null) x(id);

  for r in select w.* from tasks_trade_want w
            where w.kind = 'task' and not exists (select 1 from tasks.task_labels tl where tl.task_id = w.owner_id and tl.label_id = w.label_id and tl.deleted_at is null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_labels', 'id', gen_random_uuid(),
      'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.project_id, 'task_id', r.owner_id, 'label_id', r.label_id)));
    v_counts := jsonb_set(v_counts, '{taskLabels}', to_jsonb((v_counts->>'taskLabels')::int + 1));
  end loop;
  for r in select w.* from tasks_trade_want w
            where w.kind = 'project' and not exists (select 1 from tasks.project_labels pl where pl.project_id = w.owner_id and pl.label_id = w.label_id and pl.deleted_at is null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.project_labels', 'id', gen_random_uuid(),
      'fields', jsonb_build_object('tab_id', r.tab_id, 'project_id', r.owner_id, 'label_id', r.label_id)));
    v_counts := jsonb_set(v_counts, '{projectLabels}', to_jsonb((v_counts->>'projectLabels')::int + 1));
  end loop;
  -- Acciones que se quitaron mientras se usaban los oficios (en tareas y proyectos vivos de áreas vivas).
  for r in select tl.id, tl.revision, 'tasks.task_labels' tbl from tasks.task_labels tl
             join tasks_trade_map m on m.label_id = tl.label_id
             join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null
             join tasks.tabs tb on tb.id = tl.tab_id and tb.deleted_at is null
            where tl.deleted_at is null and not exists (select 1 from tasks_trade_want w where w.kind = 'task' and w.owner_id = tl.task_id and w.label_id = tl.label_id)
           union all
           select pl.id, pl.revision, 'tasks.project_labels' from tasks.project_labels pl
             join tasks_trade_map m on m.label_id = pl.label_id
             join tasks.projects pr on pr.id = pl.project_id and pr.deleted_at is null
             join tasks.tabs tb on tb.id = pl.tab_id and tb.deleted_at is null
            where pl.deleted_at is null and not exists (select 1 from tasks_trade_want w where w.kind = 'project' and w.owner_id = pl.project_id and w.label_id = pl.label_id) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', r.tbl, 'id', r.id, 'expectedRevision', r.revision));
    v_counts := jsonb_set(v_counts, '{removedLinks}', to_jsonb((v_counts->>'removedLinks')::int + 1));
  end loop;

  -- 3. Vistas: `_trade` vuelve a ser el filtro por la familia de cada etiqueta (la copia del área, si la tiene, o la
  --    General); agrupar por oficio, agrupar por la familia del área (o, sin ella, la General).
  select f.id into v_general from tasks.families f join tasks.action_families() af on af.family_id = f.id where f.tab_id is null order by f.created_at, f.id limit 1;
  for r in select v.* from tasks.saved_views v
            where v.deleted_at is null and exists (select 1 from tasks.tabs tb where tb.id = v.tab_id and tb.deleted_at is null)
              and (v.filters ? '_trade' or v.group_by = '_trade'
                   or exists (select 1 from jsonb_array_elements_text(coalesce(v.filters->'_exclude', '[]'::jsonb)) e
                               where exists (select 1 from tasks_trade_map m where m.trade_id::text = e))) loop
    -- La etiqueta de cada oficio para el área de la vista: la de la copia del área y, si no, la General.
    select coalesce(jsonb_object_agg(g.family_id::text, g.ids), '{}'::jsonb) into v_labels
      from (select l.family_id, jsonb_agg(distinct l.id) ids
              from jsonb_array_elements_text(coalesce(r.filters->'_trade', '[]'::jsonb)) e
              cross join lateral (select m.label_id from tasks_trade_map m where m.trade_id::text = e and (m.tab_id is null or m.tab_id = r.tab_id)
                                   order by (m.tab_id is null), (m.parent_id is not null), m.label_id limit 1) c
              join tasks.labels l on l.id = c.label_id
             group by l.family_id) g;
    select coalesce(jsonb_agg(distinct x) filter (where x is not null), '[]'::jsonb) into v_exclude
      from (select case when exists (select 1 from tasks_trade_map m where m.trade_id::text = e)
                        then (select m.label_id::text from tasks_trade_map m where m.trade_id::text = e and (m.tab_id is null or m.tab_id = r.tab_id)
                               order by (m.tab_id is null), (m.parent_id is not null), m.label_id limit 1)
                        else e end x
              from jsonb_array_elements_text(coalesce(r.filters->'_exclude', '[]'::jsonb)) e) y;
    v_filters := r.filters - '_trade' - '_exclude';
    for v_key, v_ids in select * from jsonb_each(v_labels) loop
      v_filters := v_filters || jsonb_build_object(v_key, (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                                              from jsonb_array_elements_text(coalesce(v_filters->v_key, '[]'::jsonb) || v_ids) x));
    end loop;
    if jsonb_array_length(v_exclude) > 0 then v_filters := v_filters || jsonb_build_object('_exclude', v_exclude); end if;
    v_group := case when r.group_by <> '_trade' then r.group_by
                    else coalesce((select f.id::text from tasks.families f join tasks.action_families() af on af.family_id = f.id where f.tab_id = r.tab_id order by f.created_at, f.id limit 1),
                                  v_general::text, 'project') end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.saved_views', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('filters', v_filters, 'group_by', v_group)));
    v_counts := jsonb_set(v_counts, '{views}', to_jsonb((v_counts->>'views')::int + 1));
  end loop;

  -- 4. Los oficios puestos van a la papelera (con historial: se pueden recuperar).
  for r in select tt.id, tt.revision, 'tasks.task_trades' tbl from tasks.task_trades tt where tt.deleted_at is null
           union all select pt.id, pt.revision, 'tasks.project_trades' from tasks.project_trades pt where pt.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', r.tbl, 'id', r.id, 'expectedRevision', r.revision));
  end loop;

  perform tasks.set_setting(v_app, v_actor, v_role, v_req, v_cur, 'trade_families', '[]'::jsonb);
  perform tasks.set_setting(v_app, v_actor, v_role, v_req, v_cur, 'trade_source', to_jsonb('labels'::text));
  return jsonb_build_object('source', 'labels', 'counts', v_counts);
end $$;

select core.allow_procedure('tasks', 'tasks.actions_to_trades');
select core.allow_procedure('tasks', 'tasks.trades_to_actions');

-- Un valor de oficio en una vista guardada (`_trade` o `_exclude`): vale si ya estaba en la vista o si es un oficio vivo.
create or replace function tasks.view_trade_ok(p_value text, p_prev jsonb)
returns boolean language plpgsql stable as $$
begin
  if coalesce(p_prev, '[]'::jsonb) ? p_value then return true; end if;
  if p_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return central.trade_alive(p_value::uuid);
end $$;

create or replace function tasks.empty_trash_prepare(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role'; v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb; v_count int := 0; v_step text; r record;
begin
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role is distinct from 'owner' or not tasks.scope_all(v_scopes) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners with full access empty the trash'));
  end if;
  perform set_config('tasks.purge_mode', '1', true);
  -- Cada paso ve lo que borraron los anteriores: primero las tareas, después lo que cuelga de ellas y de sus contenedores.
  foreach v_step in array array['supply_movements', 'purchase_requests', 'purchase_plan_stops', 'purchase_plans', 'supply_items', 'tasks', 'task_dependencies', 'task_labels', 'project_labels', 'task_spaces', 'project_spaces', 'task_trades', 'project_trades', 'attachments', 'saved_views', 'projects', 'labels', 'families'] loop
    for r in execute case v_step
      when 'supply_movements' then
        'select m.id, m.revision from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id join tasks.tabs tb on tb.id = m.tab_id
         where m.deleted_at is null and (s.deleted_at is not null or tb.deleted_at is not null)'
      when 'purchase_requests' then
        'select r.id, r.revision from tasks.purchase_requests r join tasks.tabs tb on tb.id = r.tab_id left join tasks.projects pr on pr.id = r.project_id
         where r.deleted_at is null and (tb.deleted_at is not null or pr.deleted_at is not null)'
      when 'purchase_plan_stops' then
        'select st.id, st.revision from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id join tasks.tabs tb on tb.id = st.tab_id
         where st.deleted_at is null and (pl.deleted_at is not null or tb.deleted_at is not null)'
      when 'purchase_plans' then
        'select pl.id, pl.revision from tasks.purchase_plans pl join tasks.tabs tb on tb.id = pl.tab_id where pl.deleted_at is null and tb.deleted_at is not null'
      when 'supply_items' then
        'select s.id, s.revision from tasks.supply_items s join tasks.tabs tb on tb.id = s.tab_id where s.deleted_at is null and tb.deleted_at is not null'
      when 'tasks' then
        'select t.id, t.revision from tasks.tasks t join tasks.projects pr on pr.id = t.project_id join tasks.tabs tb on tb.id = t.tab_id
           left join tasks.tasks pa on pa.id = t.parent_id
         where t.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or pa.deleted_at is not null)'
      when 'task_dependencies' then
        'select d.id, d.revision from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id join tasks.tasks dt on dt.id = d.depends_on_id
         where d.deleted_at is null and (t.deleted_at is not null or dt.deleted_at is not null)'
      when 'task_labels' then
        'select tl.id, tl.revision from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id join tasks.labels l on l.id = tl.label_id
         where tl.deleted_at is null and (t.deleted_at is not null or l.deleted_at is not null)'
      when 'project_labels' then
        'select pl.id, pl.revision from tasks.project_labels pl join tasks.projects pr on pr.id = pl.project_id join tasks.tabs tb on tb.id = pl.tab_id join tasks.labels l on l.id = pl.label_id
         where pl.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or l.deleted_at is not null)'
      when 'task_spaces' then
        'select ts.id, ts.revision from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id
         where ts.deleted_at is null and t.deleted_at is not null'
      when 'project_spaces' then
        'select ps.id, ps.revision from tasks.project_spaces ps join tasks.projects pr on pr.id = ps.project_id join tasks.tabs tb on tb.id = ps.tab_id
         where ps.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'task_trades' then
        'select tt.id, tt.revision from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id
         where tt.deleted_at is null and t.deleted_at is not null'
      when 'project_trades' then
        'select pt.id, pt.revision from tasks.project_trades pt join tasks.projects pr on pr.id = pt.project_id join tasks.tabs tb on tb.id = pt.tab_id
         where pt.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null)'
      when 'attachments' then
        'select a.id, a.revision from tasks.attachments a join tasks.projects pr on pr.id = a.project_id join tasks.tabs tb on tb.id = a.tab_id left join tasks.tasks t on t.id = a.task_id
         where a.deleted_at is null and (pr.deleted_at is not null or tb.deleted_at is not null or t.deleted_at is not null)'
      when 'saved_views' then
        'select v.id, v.revision from tasks.saved_views v join tasks.tabs tb on tb.id = v.tab_id where v.deleted_at is null and tb.deleted_at is not null'
      when 'projects' then
        'select pr.id, pr.revision from tasks.projects pr join tasks.tabs tb on tb.id = pr.tab_id where pr.deleted_at is null and tb.deleted_at is not null'
      when 'labels' then
        'select l.id, l.revision from tasks.labels l join tasks.tabs tb on tb.id = l.tab_id where l.deleted_at is null and tb.deleted_at is not null'
      else
        'select f.id, f.revision from tasks.families f join tasks.tabs tb on tb.id = f.tab_id where f.deleted_at is null and tb.deleted_at is not null'
      end
    loop
      perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor,
        jsonb_build_object('op', 'delete', 'table', 'tasks.' || v_step, 'id', r.id, 'expectedRevision', r.revision));
      v_count := v_count + 1;
    end loop;
  end loop;
  return jsonb_build_object('trashed', v_count);
end $$;

create or replace function tasks.convert_tab_into_project(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_src uuid;
  v_dst uuid;
  v_project uuid;
  v_title text := btrim(coalesce(v_args->>'title', ''));
  v_scopes jsonb;
  v_map jsonb := '{}'::jsonb;
  v_fam uuid;
  v_lab uuid;
  v_pos numeric;
  v_label uuid;
  v_archived boolean;
  v_name text;
  v_counts jsonb := '{}'::jsonb;
  v_n int;
  r record;
begin
  begin
    v_src := (v_args->>'sourceTabId')::uuid; v_dst := (v_args->>'targetTabId')::uuid; v_project := (v_args->>'projectId')::uuid;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'sourceTabId, targetTabId and projectId must be uuids'));
  end;
  if v_src is null or v_dst is null or v_project is null or v_src = v_dst or length(v_title) < 1 or length(v_title) > 300 then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'two different areas and a title are required'));
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if v_role <> 'owner' or not tasks.scope_all(v_scopes) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'owner with full access')); end if;
  if not exists (select 1 from tasks.tabs where id = v_src and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_src)); end if;
  if not exists (select 1 from tasks.tabs where id = v_dst and deleted_at is null) then perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'tab', 'id', v_dst)); end if;

  perform set_config('tasks.convert_mode', 'on', true);

  -- 1. El proyecto de destino, al final de su área.
  select coalesce(max(position), 0) + 1024 into v_pos from tasks.projects where tab_id = v_dst;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_project,
    'fields', jsonb_build_object('tab_id', v_dst, 'title', v_title, 'note', '', 'position', v_pos)));

  -- 2. Etiquetas usadas por las tareas vivas (como etiqueta o como responsable): las del destino con el mismo nombre en la
  --    misma familia (por su clave de sistema o, si no tiene, por nombre); las que falten, se crean.
  for r in
    select distinct lb.id, lb.name, fm.name fam_name, fm.color fam_color, fm.system_key fam_key, fm.id fam_id, fm.tab_id fam_tab
      from tasks.labels lb join tasks.families fm on fm.id = lb.family_id
     where lb.tab_id = v_src and lb.deleted_at is null
       and (exists (select 1 from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id and t.deleted_at is null where tl.label_id = lb.id and tl.deleted_at is null)
            or exists (select 1 from tasks.tasks t where t.owner_label_id = lb.id and t.deleted_at is null and t.tab_id = v_src)
            or exists (select 1 from tasks.request_routes rr where rr.owner_label_id = lb.id and rr.deleted_at is null and rr.tab_id = v_src))
  loop
    v_fam := null; v_lab := null;
    select f.id, f.archived into v_fam, v_archived from tasks.families f
      where (r.fam_tab is null and f.id = r.fam_id)
         or (r.fam_tab is not null and f.tab_id = v_dst and f.deleted_at is null
             and ((r.fam_key is not null and f.system_key = r.fam_key) or (r.fam_key is null and f.system_key is null and lower(f.name) = lower(r.fam_name))))
      order by f.archived, f.position limit 1;
    v_archived := coalesce(v_archived, false) and v_fam is not null;
    if v_fam is null then
      v_fam := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.families where tab_id = v_dst;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.families', 'id', v_fam,
        'fields', jsonb_build_object('tab_id', v_dst, 'name', r.fam_name, 'color', r.fam_color, 'position', v_pos, 'system_key', r.fam_key)));
      v_counts := v_counts || jsonb_build_object('familiesCreated', coalesce((v_counts->>'familiesCreated')::int, 0) + 1);
    end if;
    select lb.id into v_lab from tasks.labels lb
      where lb.tab_id = v_dst and lb.family_id = v_fam and lb.deleted_at is null and lower(lb.name) = lower(r.name)
      order by lb.archived, lb.position limit 1;
    if v_lab is null then
      v_lab := gen_random_uuid();
      select coalesce(max(position), 0) + 1024 into v_pos from tasks.labels where family_id = v_fam;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.labels', 'id', v_lab,
        'fields', jsonb_build_object('tab_id', v_dst, 'family_id', v_fam, 'name', r.name, 'position', v_pos, 'archived', v_archived)));
      v_counts := v_counts || jsonb_build_object('labelsCreated', coalesce((v_counts->>'labelsCreated')::int, 0) + 1);
    end if;
    v_map := v_map || jsonb_build_object(r.id::text, v_lab);
  end loop;

  -- 3. Tareas vivas de todos los proyectos del origen, con los mismos ids (historial, adjuntos y enlaces de Finance siguen).
  v_n := 0;
  for r in select * from tasks.tasks where tab_id = v_src and deleted_at is null loop
    v_label := case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end;
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.tasks', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', v_label)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('tasks', v_n);

  -- 4. Sus etiquetas, dependencias y adjuntos (también los de los proyectos, que pasan al nuevo). Lo que está en la papelera
  --    se queda con el área antigua y vuelve con ella si se restaura.
  v_n := 0;
  for r in select tl.* from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = v_src and tl.deleted_at is null and t.deleted_at is null loop
    v_label := coalesce((v_map->>r.label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.label_id and g.tab_id is null));
    if v_label is not null and not exists (select 1 from tasks.task_labels x where x.task_id = r.task_id and x.label_id = v_label and x.deleted_at is null and x.id <> r.id) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'label_id', v_label)));
    else
      -- Dos etiquetas del origen con el mismo nombre en la misma familia quedan en una sola.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_labels', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  -- Espacios de las tareas (R2): pasan con su tarea, como sus etiquetas (son de toda la casa, no hay que convertirlos).
  for r in select ts.* from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id
           where ts.tab_id = v_src and ts.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_spaces', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  -- Oficios de las tareas (P2): pasan con su tarea, como sus espacios (son de toda la casa).
  for r in select tt.* from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id
           where tt.tab_id = v_src and tt.deleted_at is null and t.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_trades', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
  end loop;
  for r in select d.*, (dt.deleted_at is null) target_live from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id join tasks.tasks dt on dt.id = d.depends_on_id
           where d.tab_id = v_src and d.deleted_at is null and t.deleted_at is null loop
    if r.target_live then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
      v_n := v_n + 1;
    else
      -- Depende de una tarea en la papelera (que se queda en el área antigua): la condición ya no aplica.
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.task_dependencies', 'id', r.id, 'expectedRevision', r.revision));
    end if;
  end loop;
  v_counts := v_counts || jsonb_build_object('dependencies', v_n);
  v_n := 0;
  for r in select at.* from tasks.attachments at left join tasks.tasks t on t.id = at.task_id
           where at.tab_id = v_src and at.deleted_at is null and (at.task_id is null or t.deleted_at is null) loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.attachments', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('attachments', v_n);

  -- 5. Almacén y compras vivos del área: pasan al destino (lo que era de un proyecto del origen, al proyecto nuevo). Un
  --    suministro con el nombre de uno del destino se renombra «<nombre> · <área de origen>».
  select name into v_name from tasks.tabs where id = v_src;
  v_n := 0;
  for r in select * from tasks.supply_items where tab_id = v_src and deleted_at is null loop
    if exists (select 1 from tasks.supply_items s where s.tab_id = v_dst and s.deleted_at is null and lower(btrim(s.name)) = lower(btrim(r.name))) then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_items', 'id', r.id, 'expectedRevision', r.revision,
        'fields', jsonb_build_object('tab_id', v_dst, 'name', left(btrim(r.name) || ' · ' || v_name, 200))));
      v_counts := v_counts || jsonb_build_object('suppliesRenamed', coalesce((v_counts->>'suppliesRenamed')::int, 0) + 1);
    else
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_items', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
    end if;
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('supplies', v_n);
  for r in select * from tasks.purchase_plans where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plans', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  for r in select * from tasks.purchase_plan_stops where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_plan_stops', 'id', r.id, 'expectedRevision', r.revision, 'fields', jsonb_build_object('tab_id', v_dst)));
  end loop;
  v_n := 0;
  for r in select rq.*, (t.id is null or t.deleted_at is null) task_live, (s.id is null or s.deleted_at is null) supply_live
             from tasks.purchase_requests rq left join tasks.tasks t on t.id = rq.task_id left join tasks.supply_items s on s.id = rq.supply_item_id
            where rq.tab_id = v_src and rq.deleted_at is null loop
    -- El enlace a una tarea o a un suministro en la papelera (que se quedan en el área antigua) se suelta.
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.purchase_requests', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', case when r.project_id is null then null else v_project end,
                                   'task_id', case when r.task_live then r.task_id end, 'supply_item_id', case when r.supply_live then r.supply_item_id end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('purchaseRequests', v_n);
  for r in select m.*, (rq.id is null or rq.deleted_at is null) request_live from tasks.supply_movements m left join tasks.purchase_requests rq on rq.id = m.purchase_request_id
            where m.tab_id = v_src and m.deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.supply_movements', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'purchase_request_id', case when r.request_live then r.purchase_request_id end)));
  end loop;

  -- 6. Reglas de entrada que apuntaban al origen: ahora, al proyecto nuevo.
  v_n := 0;
  for r in select * from tasks.request_routes where tab_id = v_src and deleted_at is null loop
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'update', 'table', 'tasks.request_routes', 'id', r.id, 'expectedRevision', r.revision,
      'fields', jsonb_build_object('tab_id', v_dst, 'project_id', v_project, 'owner_label_id', case when r.owner_label_id is null then null else coalesce((v_map->>r.owner_label_id::text)::uuid, (select g.id from tasks.labels g where g.id = r.owner_label_id and g.tab_id is null)) end)));
    v_n := v_n + 1;
  end loop;
  v_counts := v_counts || jsonb_build_object('routes', v_n);

  -- 7. El área de origen, ya vacía, a la papelera (se puede restaurar; sus proyectos quedan vacíos con ella).
  select * into r from tasks.tabs where id = v_src;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'delete', 'table', 'tasks.tabs', 'id', v_src, 'expectedRevision', r.revision));

  return jsonb_build_object('projectId', v_project, 'counts', v_counts);
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
  v_how text;
  v_hint_tab uuid;
  v_hint_project uuid;
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
      'status', case when v_how is null then 'pending' else 'routed' end, 'routed_by', v_how, 'on_behalf_of', v_behalf)));
  if v_how is null then
    return jsonb_build_object('created', true, 'id', v_id, 'routed', 'pending');
  end if;

  select coalesce(max(t.position), 0) + 1024 into v_position from tasks.tasks t where t.project_id = v_project;
  perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
    jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_id, 'fields', jsonb_build_object(
      'tab_id', v_tab, 'project_id', v_project, 'title', btrim(coalesce(v_args->>'title', '')), 'note', coalesce(v_args->>'note', ''),
      'priority', coalesce(v_args->>'priority', 'normal'), 'due', nullif(v_args->>'due', ''), 'position', v_position, 'owner_label_id', v_owner,
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
  -- Y sus oficios de Central (P2), igual que el espacio.
  for l in select pt.trade_id from tasks.project_trades pt where pt.project_id = v_project and pt.deleted_at is null order by pt.trade_id loop
    v_hash := md5(v_id::text || ':trade:' || l.trade_id::text);
    perform core.apply_row_op(p->>'app', v_actor, p->>'role', p->>'requestId', (p->>'cursor')::bigint,
      jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades',
        'id', (substr(v_hash, 1, 8) || '-' || substr(v_hash, 9, 4) || '-4' || substr(v_hash, 14, 3) || '-8' || substr(v_hash, 18, 3) || '-' || substr(v_hash, 21, 12))::uuid,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_id, 'trade_id', l.trade_id)));
  end loop;
  return jsonb_build_object('created', true, 'id', v_id, 'routed', v_how);
end $$;

create or replace function tasks.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_cursor bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_import boolean := coalesce(current_setting('tasks.import_mode', true), '') <> '';
  v_purge boolean := coalesce(current_setting('tasks.purge_mode', true), '') <> '';
  -- Lo que escribe tasks.request_task (§19, §20): la referencia y el id de la tarea o petición que da de alta.
  v_ext text := coalesce(current_setting('tasks.external_request', true), '');
  v_ext_id text := coalesce(current_setting('tasks.external_request_id', true), '');
  v_tables text[];
  v_tabs uuid[];
  v_general boolean;
  v_ok boolean;
  v_tab uuid;
  v_project uuid;
  v_id uuid;
  v_role text;
  v_approver uuid;
  v_all int;
  v_good int;
  v_src uuid[];
  v_dst uuid[];
  v_before int;
  v_blockers jsonb;
  v_key text;
  v_value jsonb;
  v_prev jsonb;
  c record;
  r record;
begin
  select array_agg(distinct ch.table_name) into v_tables
    from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call';
  if v_tables is null then return; end if;

  select array_agg(distinct x.tab) into v_tabs from (
    select case when ch.table_name = 'tabs' then ch.row_id else (coalesce(ch.after, ch.before)->>'tab_id')::uuid end tab
    from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call'
    union
    select (ch.before->>'tab_id')::uuid from core.changes ch
    where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call' and ch.table_name <> 'tabs' and ch.before is not null
  ) x where x.tab is not null;
  -- Catálogo General (FB_2026_023): familias y etiquetas con tab_id nulo, válidas en todas las áreas. Si el lote toca
  -- alguna, las comprobaciones del catálogo incluyen también las General.
  v_general := exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op <> 'call'
    and ch.table_name in ('families', 'labels') and coalesce(ch.after, ch.before)->>'tab_id' is null);

  -- a) Ámbitos de escritura ---------------------------------------------------
  select m.scopes, m.role into v_scopes, v_role from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not tasks.scope_all(v_scopes) then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.op in ('insert','update','delete','restore') order by ch.seq loop
      v_tab := case when c.table_name = 'tabs' then c.row_id else (coalesce(c.after, c.before)->>'tab_id')::uuid end;
      -- Buzón (§20.4): la tarea o petición que da de alta tasks.request_task entra aunque su destino quede fuera del
      -- alcance de quien pide (lo decide una regla del usuario); solo ese insert y las etiquetas de esa tarea.
      continue when v_ext_id <> '' and c.op = 'insert'
        and (c.row_id::text = v_ext_id or (c.table_name in ('task_labels', 'task_spaces', 'task_trades') and c.after->>'task_id' = v_ext_id));
      case
        when c.table_name = 'tabs' then
          v_ok := c.op <> 'insert' and tasks.scope_full(v_scopes, c.row_id);
        when c.table_name in ('families', 'labels', 'saved_views', 'supply_items', 'supply_movements', 'purchase_plans', 'purchase_plan_stops', 'request_routes') then
          v_ok := tasks.scope_full(v_scopes, v_tab);
        when c.table_name = 'settings' then
          -- Los ajustes solo los cambian los procedimientos de la propietaria con acceso completo (más abajo).
          v_ok := false;
        when c.table_name = 'requests' then
          -- Las peticiones pendientes no tienen área: son de quien tiene acceso a toda la app.
          v_ok := false;
        when c.table_name = 'projects' then
          v_ok := case when c.op = 'insert' then tasks.scope_full(v_scopes, v_tab) else tasks.scope_project(v_scopes, v_tab, c.row_id) end;
        else
          v_ok := tasks.scope_project(v_scopes, v_tab, (c.after->>'project_id')::uuid)
            and (c.before is null or tasks.scope_project(v_scopes, (c.before->>'tab_id')::uuid, (c.before->>'project_id')::uuid));
          if v_ok and c.table_name = 'task_dependencies' and c.op in ('insert', 'restore') then
            select t.project_id into v_project from tasks.tasks t where t.id = (c.after->>'depends_on_id')::uuid;
            v_ok := v_project is null or tasks.scope_project(v_scopes, v_tab, v_project);
          end if;
      end case;
      if not coalesce(v_ok, false) then
        perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.' || c.table_name, 'id', c.row_id, 'reason', 'outside scope'));
      end if;
    end loop;
  end if;

  -- b) Estructura -------------------------------------------------------------
  if 'tabs' = any(v_tables) and exists (select 1 from tasks.tabs) and not exists (select 1 from tasks.tabs where deleted_at is null) then
    perform core.fail('LAST_ACTIVE_TAB', 422);
  end if;

  -- No se toca el contenido de un área que ya estaba en la papelera antes de este lote.
  select t.id into v_id from tasks.tabs t
    where not v_purge and t.id = any(v_tabs) and t.deleted_at is not null
      and not exists (select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tabs' and ch.row_id = t.id)
    limit 1;
  if v_id is not null then perform core.fail('TAB_DELETED', 422, jsonb_build_object('tabId', v_id)); end if;

  if v_tables && array['tabs', 'projects'] then
    for v_tab in select t.id from tasks.tabs t where t.id = any(v_tabs) and t.deleted_at is null loop
      select count(*), count(*) filter (where pr.deleted_at is null and pr.status <> 'archived' and pr.title = 'Entrada')
        into v_all, v_good from tasks.projects pr where pr.tab_id = v_tab and pr.system = 'inbox';
      if v_all <> 1 or v_good <> 1 then perform core.fail('INBOX_PROTECTED', 422, jsonb_build_object('tabId', v_tab)); end if;
    end loop;
  end if;

  if 'tasks' = any(v_tables) then
    if not v_import then
      select (ch.after->>'project_id')::uuid into v_id from core.changes ch join tasks.projects pr on pr.id = (ch.after->>'project_id')::uuid
        where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks'
          and (ch.op = 'insert' or (ch.op = 'update' and ch.before->>'project_id' is distinct from ch.after->>'project_id'))
          and (pr.deleted_at is not null or pr.status = 'archived')
        limit 1;
      if v_id is not null then perform core.fail('PROJECT_UNAVAILABLE', 422, jsonb_build_object('projectId', v_id)); end if;
    end if;

    select ch.id into v_id from tasks.tasks ch join tasks.tasks pa on pa.id = ch.parent_id
      where ch.tab_id = any(v_tabs)
        and (pa.parent_id is not null or (ch.deleted_at is null and (pa.project_id <> ch.project_id or pa.deleted_at is not null)))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PARENT', 422, jsonb_build_object('taskId', v_id)); end if;
  end if;

  -- Claves desnormalizadas coherentes con su área y su proyecto reales.
  v_id := null;
  if v_tables && array['projects', 'tasks', 'project_labels', 'task_labels', 'task_dependencies', 'attachments'] then
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.projects pr on pr.id = t.project_id where t.tab_id = any(v_tabs) and pr.tab_id <> t.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.projects pr on pr.id = pl.project_id where pl.tab_id = any(v_tabs) and pl.deleted_at is null and pr.tab_id <> pl.tab_id
      union all
      select tl.id from tasks.task_labels tl join tasks.tasks t on t.id = tl.task_id where tl.tab_id = any(v_tabs) and tl.deleted_at is null and (t.tab_id <> tl.tab_id or t.project_id <> tl.project_id)
      union all
      select d.id from tasks.task_dependencies d join tasks.tasks t on t.id = d.task_id where d.tab_id = any(v_tabs) and d.deleted_at is null and (t.tab_id <> d.tab_id or t.project_id <> d.project_id)
      union all
      select a.id from tasks.attachments a join tasks.projects pr on pr.id = a.project_id where a.tab_id = any(v_tabs) and a.deleted_at is null and pr.tab_id <> a.tab_id
      union all
      select a.id from tasks.attachments a join tasks.tasks t on t.id = a.task_id where a.tab_id = any(v_tabs) and a.deleted_at is null and t.project_id <> a.project_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  -- c) Catálogo ---------------------------------------------------------------
  if v_tables && array['families', 'labels', 'task_labels', 'project_labels', 'projects', 'tasks'] then
    select l.id into v_id from tasks.labels l join tasks.families f on f.id = l.family_id
      where (l.tab_id = any(v_tabs) or f.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and f.tab_id is not null and f.tab_id is distinct from l.tab_id limit 1;
    if v_id is not null then perform core.fail('INVALID_LABEL', 422, jsonb_build_object('labelId', v_id)); end if;

    select min(f.id::text)::uuid into v_id from tasks.families f where (f.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.system_key is not null and f.deleted_at is null
      group by f.tab_id, f.system_key having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('INVALID_FAMILY', 422, jsonb_build_object('familyId', v_id, 'reason', 'duplicate system family')); end if;

    select l.id into v_id from tasks.labels l join tasks.labels pa on pa.id = l.parent_id
      where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and pa.tab_id is not null and pa.tab_id is distinct from l.tab_id limit 1;
    if v_id is null then
      with recursive up as (
        select l.id, l.parent_id, 1 depth from tasks.labels l where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.parent_id is not null
        union all
        select up.id, pa.parent_id, up.depth + 1 from up join tasks.labels pa on pa.id = up.parent_id where pa.parent_id is not null and up.depth < 64
      ) select up.id into v_id from up where up.parent_id = up.id or up.depth >= 64 limit 1;
    end if;
    if v_id is not null then perform core.fail('INVALID_LABEL_PARENT', 422, jsonb_build_object('labelId', v_id)); end if;

    -- Etiquetas padre e hija (aceptación V1, 9): dos niveles como máximo y dentro de la misma familia. Se aplica a las
    -- etiquetas vivas que este lote crea con padre o a las que cambia el padre; los vínculos anteriores (la app antigua
    -- permitía colgar un espacio de un edificio, de otra familia) se conservan y la interfaz los muestra sin «Padre:».
    v_id := null;
    select l.id into v_id from tasks.labels l
      where l.deleted_at is null
        and l.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'labels'
                       and (ch.op in ('insert', 'restore') or ch.before->>'parent_id' is distinct from ch.after->>'parent_id'))
        and (
          exists (select 1 from tasks.labels pa where pa.id = l.parent_id and (pa.family_id <> l.family_id or pa.parent_id is not null))
          or (l.parent_id is not null and exists (select 1 from tasks.labels ch where ch.parent_id = l.id and ch.deleted_at is null))
        )
      limit 1;
    if v_id is not null then perform core.fail('INVALID_LABEL_PARENT', 422, jsonb_build_object('labelId', v_id, 'reason', 'two levels in one family')); end if;

    select l.id into v_id from tasks.labels l join tasks.families f on f.id = l.family_id
      where (l.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.archived and not l.archived and l.deleted_at is null limit 1;
    if v_id is not null then perform core.fail('FAMILY_ARCHIVED', 422, jsonb_build_object('labelId', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select tl.id from tasks.task_labels tl join tasks.labels l on l.id = tl.label_id where tl.tab_id = any(v_tabs) and tl.deleted_at is null and l.tab_id is not null and l.tab_id <> tl.tab_id
      union all
      select pl.id from tasks.project_labels pl join tasks.labels l on l.id = pl.label_id where pl.tab_id = any(v_tabs) and pl.deleted_at is null and l.tab_id is not null and l.tab_id <> pl.tab_id
      union all
      select min(tl.id::text)::uuid from tasks.task_labels tl where tl.tab_id = any(v_tabs) and tl.deleted_at is null group by tl.task_id, tl.label_id having count(*) > 1
      union all
      select min(pl.id::text)::uuid from tasks.project_labels pl where pl.tab_id = any(v_tabs) and pl.deleted_at is null group by pl.project_id, pl.label_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_LABELS', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select l.id from tasks.labels l join tasks.task_labels tl on tl.label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and tl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.project_labels pl on pl.label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and pl.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.tasks t on t.owner_label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and t.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.projects pr on pr.owner_label_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and pr.deleted_at is null
      union all
      select l.id from tasks.labels l join tasks.labels ch on ch.parent_id = l.id where (l.tab_id = any(v_tabs) or (v_general and l.tab_id is null)) and l.deleted_at is not null and ch.deleted_at is null
      union all
      select f.id from tasks.families f join tasks.labels l on l.family_id = f.id where (f.tab_id = any(v_tabs) or (v_general and f.tab_id is null)) and f.deleted_at is not null and l.deleted_at is null
    ) x limit 1;
    if v_id is not null then perform core.fail('LABEL_IN_USE', 422, jsonb_build_object('id', v_id)); end if;

    v_id := null;
    select x.id into v_id from (
      select t.id from tasks.tasks t join tasks.labels l on l.id = t.owner_label_id join tasks.families f on f.id = l.family_id
        where t.tab_id = any(v_tabs) and (l.tab_id is not null and l.tab_id <> t.tab_id or f.system_key is distinct from 'person')
      union all
      select pr.id from tasks.projects pr join tasks.labels l on l.id = pr.owner_label_id join tasks.families f on f.id = l.family_id
        where pr.tab_id = any(v_tabs) and (l.tab_id is not null and l.tab_id <> pr.tab_id or f.system_key is distinct from 'person')
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_OWNER', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  if 'saved_views' = any(v_tables) then
    for r in select v.* from tasks.saved_views v
             where v.deleted_at is null and v.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'saved_views') loop
      -- Oficios que la vista ya tenía antes del lote: un oficio que Central archive después no impide editarla.
      select coalesce(ch.before->'filters', '{}'::jsonb) into v_prev from core.changes ch
        where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'saved_views' and ch.row_id = r.id order by ch.seq limit 1;
      v_prev := coalesce(v_prev->'_trade', '[]'::jsonb) || coalesce(v_prev->'_exclude', '[]'::jsonb);
      v_ok := r.group_by in ('project', 'state', '_space', '_trade') or exists (select 1 from tasks.families f where f.id::text = r.group_by and (f.tab_id = r.tab_id or f.tab_id is null));
      for v_key, v_value in select * from jsonb_each(r.filters) loop
        exit when not v_ok;
        if jsonb_typeof(v_value) <> 'array' then
          v_ok := false;
        elsif v_key = '_state' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('pending', 'done'));
        elsif v_key = '_availability' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('ready', 'blocked'));
        elsif v_key = '_priority' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where e not in ('normal', 'high', 'critical'));
        elsif v_key = '_exclude' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.labels l where l.id::text = e and (l.tab_id = r.tab_id or l.tab_id is null))
                                                                                  and not exists (select 1 from resources.spaces s where s.id::text = e and s.deleted_at is null)
                                                                                  and not tasks.view_trade_ok(e, v_prev));
        elsif v_key = '_space' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from resources.spaces s where s.id::text = e and s.deleted_at is null));
        elsif v_key = '_trade' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not tasks.view_trade_ok(e, v_prev));
        elsif v_key = '_project' then
          v_ok := not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.projects pr where pr.id::text = e and pr.tab_id = r.tab_id));
        else
          v_ok := exists (select 1 from tasks.families f where f.id::text = v_key and (f.tab_id = r.tab_id or f.tab_id is null))
            and not exists (select 1 from jsonb_array_elements_text(v_value) e where not exists (select 1 from tasks.labels l where l.id::text = e and l.family_id::text = v_key));
        end if;
      end loop;
      if not v_ok then perform core.fail('INVALID_VIEW', 422, jsonb_build_object('viewId', r.id)); end if;
    end loop;
  end if;

  -- d) Dependencias -----------------------------------------------------------
  if v_tables && array['task_dependencies', 'tasks'] then
    v_id := null;
    select x.id into v_id from (
      select d.id from tasks.task_dependencies d join tasks.tasks dt on dt.id = d.depends_on_id where d.tab_id = any(v_tabs) and d.deleted_at is null and dt.tab_id <> d.tab_id
      union all
      select min(d.id::text)::uuid from tasks.task_dependencies d where d.tab_id = any(v_tabs) and d.deleted_at is null group by d.task_id, d.depends_on_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_DEPENDENCIES', 422, jsonb_build_object('id', v_id)); end if;

    -- Ciclos: tarea → dependencia efectiva (propia o heredada del padre) y padre → hija. Se pelan los nodos sin salida
    -- hasta que no cambia nada; si quedan aristas, hay ciclo. Solo en áreas con dependencias vivas.
    if exists (
      select 1 from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks'
        and (ch.table_name = 'task_dependencies' or (ch.table_name = 'tasks' and (ch.op in ('insert', 'restore') or ch.before->>'parent_id' is distinct from ch.after->>'parent_id')))) then
      for v_tab in select t.id from tasks.tabs t where t.id = any(v_tabs)
                   and exists (select 1 from tasks.task_dependencies d where d.tab_id = t.id and d.deleted_at is null) loop
        select array_agg(e.src), array_agg(e.dst) into v_src, v_dst from (
          select d.task_id src, d.depends_on_id dst from tasks.task_dependencies d where d.tab_id = v_tab and d.deleted_at is null
          union
          select ch.id, d.depends_on_id from tasks.task_dependencies d join tasks.tasks ch on ch.parent_id = d.task_id where d.tab_id = v_tab and d.deleted_at is null
          union
          select ch.parent_id, ch.id from tasks.tasks ch where ch.tab_id = v_tab and ch.parent_id is not null
        ) e;
        loop
          v_before := coalesce(array_length(v_src, 1), 0);
          exit when v_before = 0;
          select array_agg(e.src), array_agg(e.dst) into v_src, v_dst
            from unnest(v_src, v_dst) e(src, dst) where e.dst in (select unnest(v_src));
          exit when coalesce(array_length(v_src, 1), 0) = v_before;
        end loop;
        if coalesce(array_length(v_src, 1), 0) > 0 then
          perform core.fail('DEPENDENCY_CYCLE', 422, jsonb_build_object('tabId', v_tab, 'taskIds', (select jsonb_agg(distinct s) from unnest(v_src) s)));
        end if;
      end loop;
    end if;
  end if;

  -- e) No se completa una tarea con condiciones incumplidas --------------------
  if 'tasks' = any(v_tables) and not v_import then
    for r in
      select t.* from tasks.tasks t join tasks.projects pr on pr.id = t.project_id
      where t.done and t.deleted_at is null and pr.deleted_at is null
        and not exists (select 1 from tasks.tasks k where k.parent_id = t.id and k.deleted_at is null)
        and t.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks')
        and not coalesce((select (ch.before->>'done')::boolean from core.changes ch
                          where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks' and ch.row_id = t.id
                          order by ch.seq limit 1), false)
    loop
      -- Pasos en orden (FB_2026_041): la hija anterior de la cadena, si no está hecha, también bloquea.
      v_id := tasks.step_blocker(r.id);
      if v_id is not null or exists (select 1 from tasks.task_dependencies d
                 where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)) then
        select coalesce(jsonb_agg(distinct d.depends_on_id), '[]'::jsonb) into v_blockers
          from tasks.task_dependencies d join tasks.tasks dt on dt.id = d.depends_on_id
          where d.deleted_at is null and d.task_id in (r.id, r.parent_id) and not tasks.dependency_met(d.depends_on_id)
            and tasks.scope_project(v_scopes, dt.tab_id, dt.project_id);
        if v_id is not null then v_blockers := v_blockers || jsonb_build_array(v_id); end if;
        perform core.fail('TASK_BLOCKED', 422, jsonb_build_object('taskId', r.id, 'blockedBy', v_blockers));
      end if;
    end loop;
  end if;

  -- f) Adjuntos: el archivo existe, es de esta app, está verificado y coincide con lo declarado --------
  if 'attachments' = any(v_tables) then
    select a.id into v_id from tasks.attachments a
      where a.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'attachments' and ch.op = 'insert')
        and not exists (select 1 from core.files f where f.id = a.file_id and f.app = v_app and f.status = 'verified' and f.sha256 = a.sha256 and f.size = a.size)
      limit 1;
    if v_id is not null then perform core.fail('FILE_NOT_UPLOADED', 422, jsonb_build_object('attachmentId', v_id)); end if;
  end if;

  -- g) Compras no alimentarias (docs/tasks/API.md §18) ------------------------------------------------------------
  if v_tables && array['supply_items', 'supply_movements', 'purchase_plans', 'purchase_plan_stops', 'purchase_requests', 'projects', 'tasks'] then
    -- Claves coherentes con su área y, en las solicitudes con tarea, con su proyecto.
    v_id := null;
    select x.id into v_id from (
      select rq.id from tasks.purchase_requests rq join tasks.projects pr on pr.id = rq.project_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and pr.tab_id <> rq.tab_id
      union all
      select rq.id from tasks.purchase_requests rq join tasks.tasks t on t.id = rq.task_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and (t.tab_id <> rq.tab_id or t.project_id is distinct from rq.project_id)
      union all
      select rq.id from tasks.purchase_requests rq join tasks.supply_items s on s.id = rq.supply_item_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and s.tab_id <> rq.tab_id
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.tab_id <> rq.tab_id
      union all
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.tab_id <> st.tab_id
      union all
      select m.id from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id where m.tab_id = any(v_tabs) and m.deleted_at is null and s.tab_id <> m.tab_id
      union all
      select m.id from tasks.supply_movements m join tasks.purchase_requests rq on rq.id = m.purchase_request_id where m.tab_id = any(v_tabs) and m.deleted_at is null and rq.tab_id <> m.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;

    -- Lo vivo cuelga de algo vivo (la cascada la construye el cliente): movimientos de un suministro vivo, paradas de un
    -- plan vivo y solicitudes de una parada viva.
    v_id := null;
    select x.id into v_id from (
      select m.id from tasks.supply_movements m join tasks.supply_items s on s.id = m.supply_item_id where m.tab_id = any(v_tabs) and m.deleted_at is null and s.deleted_at is not null
      union all
      select st.id from tasks.purchase_plan_stops st join tasks.purchase_plans pl on pl.id = st.plan_id where st.tab_id = any(v_tabs) and st.deleted_at is null and pl.deleted_at is not null
      union all
      select rq.id from tasks.purchase_requests rq join tasks.purchase_plan_stops st on st.id = rq.plan_stop_id where rq.tab_id = any(v_tabs) and rq.deleted_at is null and st.deleted_at is not null
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'parent in trash')); end if;

    -- En un plan solo entran solicitudes aprobadas (o ya compradas o recibidas).
    select rq.id into v_id from tasks.purchase_requests rq
      where rq.tab_id = any(v_tabs) and rq.deleted_at is null and rq.plan_stop_id is not null and rq.status not in ('approved', 'purchased', 'received') limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'only approved requests go into a plan')); end if;

    -- Una sola entrada de stock viva por solicitud recibida.
    select min(m.purchase_request_id::text)::uuid into v_id from tasks.supply_movements m
      where m.tab_id = any(v_tabs) and m.deleted_at is null and m.purchase_request_id is not null
      group by m.purchase_request_id having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'one stock entry per request')); end if;

    -- Nombre de suministro único entre los vivos del área.
    select min(s.id::text)::uuid into v_id from tasks.supply_items s
      where s.tab_id = any(v_tabs) and s.deleted_at is null group by s.tab_id, lower(btrim(s.name)) having count(*) > 1 limit 1;
    if v_id is not null then perform core.fail('SUPPLY_NAME_TAKEN', 422, jsonb_build_object('id', v_id)); end if;

    -- Lo ya comprado o recibido no sale de su parada: es la historia del plan (y por eso un plan así no se borra, se termina).
    select ch.row_id into v_id from core.changes ch join tasks.purchase_requests rq on rq.id = ch.row_id
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op = 'update'
        and (ch.before->>'plan_stop_id') is not null and (ch.before->>'plan_stop_id') is distinct from (ch.after->>'plan_stop_id')
        and (ch.before->>'status') in ('purchased', 'received')
      limit 1;
    if v_id is not null then perform core.fail('INVALID_PURCHASE', 422, jsonb_build_object('id', v_id, 'reason', 'purchased requests stay in their plan; finish the plan instead')); end if;
  end if;

  -- Aprobar o rechazar una solicitud: solo el responsable de compras del área o, si no hay, una propietaria con el área.
  if 'purchase_requests' = any(v_tables) and not v_purge then
    for c in select ch.* from core.changes ch
             where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'purchase_requests' and ch.op in ('insert', 'update', 'restore') loop
      if (c.after->>'status') in ('approved', 'rejected') and (c.before is null or (c.before->>'status') is distinct from (c.after->>'status')) then
        v_tab := (c.after->>'tab_id')::uuid;
        select t.purchase_approver_id into v_approver from tasks.tabs t where t.id = v_tab;
        if not (v_actor is not distinct from v_approver and v_approver is not null
                or (v_approver is null and v_role = 'owner' and tasks.scope_full(v_scopes, v_tab))) then
          perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.purchase_requests', 'id', c.row_id, 'reason', 'purchase approver'));
        end if;
      end if;
    end loop;
  end if;

  -- Procedencia de una tarea pedida desde otra app (§19, §20): `external_ref`, `external_kind` y `external_url` solo se
  -- fijan en el insert de la tarea, por tasks.request_task o al clasificar su petición (que pasa a `routed` en el mismo
  -- lote, con el mismo id y los mismos datos de origen).
  if 'tasks' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'tasks' and ch.op in ('insert', 'update', 'restore')
        and ((ch.after->>'external_ref') is distinct from (ch.before->>'external_ref')
             or (ch.after->>'external_kind') is distinct from (ch.before->>'external_kind')
             or (ch.after->>'external_url') is distinct from (ch.before->>'external_url')
             or (ch.after->>'external_on_behalf') is distinct from (ch.before->>'external_on_behalf'))
        and not (ch.op = 'insert' and (
              (ch.row_id::text = v_ext_id and (ch.after->>'external_ref') = v_ext)
              or exists (select 1 from core.changes rq
                         where rq.app = v_app and rq.cursor = v_cursor and rq.schema_name = 'tasks' and rq.table_name = 'requests' and rq.row_id = ch.row_id
                           and rq.after->>'status' = 'routed' and rq.after->>'external_ref' = ch.after->>'external_ref'
                           and (rq.after->>'kind') is not distinct from (ch.after->>'external_kind')
                           and (rq.after->>'external_url') is not distinct from (ch.after->>'external_url')
                           and (rq.after->'on_behalf_of'->>'kind') is not distinct from (ch.after->>'external_on_behalf'))))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.tasks', 'id', v_id, 'field', 'external_ref', 'reason', 'set only by requests/task or by routing its request')); end if;
  end if;

  -- Proyecto por retiro (§23): `external_ref` de un proyecto solo lo fija tasks.request_project, en el insert.
  if 'projects' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'projects' and ch.op in ('insert', 'update', 'restore')
        and (ch.after->>'external_ref') is distinct from (ch.before->>'external_ref')
        and not (ch.op = 'insert' and (ch.after->>'external_ref') = coalesce(current_setting('tasks.external_project', true), ''))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.projects', 'id', v_id, 'field', 'external_ref', 'reason', 'set only by requests/project')); end if;
  end if;

  -- Peticiones (§20): solo las da de alta tasks.request_task; después solo cambia su estado. Una petición `routed` tiene
  -- su tarea viva con el mismo id; una pendiente o descartada, no.
  if 'requests' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'requests'
        and ((ch.op = 'insert' and ch.row_id::text <> v_ext_id)
             or (ch.op = 'update' and (ch.before - array['status', 'routed_by', 'revision', 'updated_at', 'updated_by', 'deleted_at'])
                                       is distinct from (ch.after - array['status', 'routed_by', 'revision', 'updated_at', 'updated_by', 'deleted_at'])))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_REQUEST', 422, jsonb_build_object('id', v_id, 'reason', 'requests are created by requests/task; only their status changes')); end if;
    select rq.id into v_id from tasks.requests rq
      where rq.deleted_at is null
        and rq.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'requests')
        and (rq.status = 'routed') is distinct from exists (select 1 from tasks.tasks t where t.id = rq.id and t.deleted_at is null)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_REQUEST', 422, jsonb_build_object('id', v_id, 'reason', 'a routed request has its live task; a pending or dismissed one has none')); end if;
  end if;

  -- Reglas de entrada (§20): destino coherente; el proyecto, del área y no archivado; el responsable, una etiqueta
  -- Persona de esa área.
  if 'request_routes' = any(v_tables) and not v_purge then
    select ch.row_id into v_id from core.changes ch
      join tasks.request_routes rr on rr.id = ch.row_id and rr.deleted_at is null
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name = 'request_routes' and ch.op in ('insert', 'update', 'restore')
        and (not exists (select 1 from tasks.tabs tb where tb.id = rr.tab_id and tb.deleted_at is null)
             or (rr.project_id is not null and not exists (select 1 from tasks.projects pr where pr.id = rr.project_id and pr.tab_id = rr.tab_id and pr.deleted_at is null and pr.status <> 'archived'))
             or (rr.owner_label_id is not null and not exists (select 1 from tasks.labels l join tasks.families f on f.id = l.family_id
                                                               where l.id = rr.owner_label_id and (l.tab_id = rr.tab_id or l.tab_id is null) and l.deleted_at is null and f.system_key = 'person')))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_ROUTE', 422, jsonb_build_object('id', v_id)); end if;
  end if;

  -- h) Espacios de Recursos (R2) ----------------------------------------------------------------------------------
  if v_tables && array['task_spaces', 'project_spaces', 'tasks', 'projects'] then
    v_id := null;
    select x.id into v_id from (
      select ts.id from tasks.task_spaces ts join tasks.tasks t on t.id = ts.task_id where ts.tab_id = any(v_tabs) and ts.deleted_at is null and (t.tab_id <> ts.tab_id or t.project_id <> ts.project_id)
      union all
      select ps.id from tasks.project_spaces ps join tasks.projects pr on pr.id = ps.project_id where ps.tab_id = any(v_tabs) and ps.deleted_at is null and pr.tab_id <> ps.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
    select x.id into v_id from (
      select min(ts.id::text)::uuid id from tasks.task_spaces ts where ts.tab_id = any(v_tabs) and ts.deleted_at is null group by ts.task_id, ts.space_id having count(*) > 1
      union all
      select min(ps.id::text)::uuid from tasks.project_spaces ps where ps.tab_id = any(v_tabs) and ps.deleted_at is null group by ps.project_id, ps.space_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_SPACES', 422, jsonb_build_object('id', v_id, 'reason', 'duplicate')); end if;
    -- El espacio existe, está vivo y activo cuando se pone (no hay clave foránea entre schemas: docs/resources/API.md §2.5).
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_spaces', 'project_spaces') and ch.op in ('insert', 'restore')
        and not exists (select 1 from resources.spaces s where s.id = (ch.after->>'space_id')::uuid and s.deleted_at is null and s.active)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_SPACE', 422, jsonb_build_object('id', v_id, 'reason', 'space not found or archived')); end if;
  end if;

  -- i) Oficios de Central (P2) ------------------------------------------------------------------------------------
  if v_tables && array['task_trades', 'project_trades', 'tasks', 'projects'] then
    v_id := null;
    select x.id into v_id from (
      select tt.id from tasks.task_trades tt join tasks.tasks t on t.id = tt.task_id where tt.tab_id = any(v_tabs) and tt.deleted_at is null and (t.tab_id <> tt.tab_id or t.project_id <> tt.project_id)
      union all
      select pt.id from tasks.project_trades pt join tasks.projects pr on pr.id = pt.project_id where pt.tab_id = any(v_tabs) and pt.deleted_at is null and pr.tab_id <> pt.tab_id
    ) x limit 1;
    if v_id is not null then perform core.fail('INCONSISTENT_KEYS', 422, jsonb_build_object('id', v_id)); end if;
    select x.id into v_id from (
      select min(tt.id::text)::uuid id from tasks.task_trades tt where tt.tab_id = any(v_tabs) and tt.deleted_at is null group by tt.task_id, tt.trade_id having count(*) > 1
      union all
      select min(pt.id::text)::uuid from tasks.project_trades pt where pt.tab_id = any(v_tabs) and pt.deleted_at is null group by pt.project_id, pt.trade_id having count(*) > 1
    ) x limit 1;
    if v_id is not null then perform core.fail('INVALID_TRADES', 422, jsonb_build_object('id', v_id, 'reason', 'duplicate')); end if;
    -- El oficio existe, está vivo y activo cuando se pone (sin clave foránea entre schemas; central.trade_alive, 1508).
    select ch.row_id into v_id from core.changes ch
      where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('task_trades', 'project_trades') and ch.op in ('insert', 'restore')
        and not central.trade_alive((ch.after->>'trade_id')::uuid)
      limit 1;
    if v_id is not null then perform core.fail('INVALID_TRADE', 422, jsonb_build_object('id', v_id, 'reason', 'trade not found or archived')); end if;
  end if;

  -- Ajustes de la app: solo dentro de «Pasar las zonas a espacios», «Pasar las acciones a oficios» o sus marchas atrás.
  if 'settings' = any(v_tables) and coalesce(current_setting('tasks.convert_mode', true), '') <> 'on' then
    perform core.fail('INVALID_SETTING', 422, jsonb_build_object('reason', 'settings change only through the app actions'));
  end if;

  -- El responsable de compras es una cuenta con acceso completo al área.
  if 'tabs' = any(v_tables) then
    select t.id into v_id from tasks.tabs t
      where t.id = any(v_tabs) and t.deleted_at is null and t.purchase_approver_id is not null
        and not exists (select 1 from core.memberships m where m.app = v_app and m.user_id = t.purchase_approver_id
                        and m.role in ('editor', 'owner') and tasks.scope_full(m.scopes, t.id))
      limit 1;
    if v_id is not null then perform core.fail('INVALID_APPROVER', 422, jsonb_build_object('tabId', v_id)); end if;
  end if;
end $$;

do $$
declare f text;
begin
  for f in select 'tasks.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tasks' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
