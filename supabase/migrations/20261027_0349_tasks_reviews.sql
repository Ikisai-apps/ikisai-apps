-- Ikisai Tasks · «Revisión de apertura», 2: crear una revisión desde su plantilla (encargo de VG por Core, 27-10-2026;
-- docs/tasks/API.md §46.2). Toca solo el schema tasks y, del núcleo, solo usa register_table, apply_row_op, add_validate_hook,
-- allow_procedure, current_role y fail.
-- - tasks.reviews: una revisión (su proyecto, su plantilla, el evento `event_ref` y su estado: open, ready u opened; lo de
--   abrir lo rellena 0351).
-- - tasks.review_items: un ítem de una revisión, con su tarea (la hija de su zona) y una copia de lo de la plantilla (zona,
--   tipo, esperado, crítico, instrucciones): cambiar la plantilla no toca las revisiones creadas. El resultado (estado,
--   valor, evidencia, primer fallo, correctiva y volver a comprobar) lo escribe 0350.
-- - Las dos tablas solo las escriben los procedimientos de la revisión (marca `tasks.review_write`, hook
--   tasks.validate_reviews): ni la app ni un agente fijan un estado o un resultado a mano.
-- - tasks.review_create(args {reviewId, templateId, tabId, title?, eventRef?, due?}): en un lote, el proyecto (al final del
--   área), una tarea madre por zona (en el orden de la plantilla, con el oficio si todos sus ítems lo comparten), una hija
--   por ítem (instrucciones en la nota, oficio en task_trades) y la revisión con sus ítems. Ids derivados de `reviewId`:
--   repetir devuelve la que ya hay. Editor u owner con el área entera; la plantilla, viva, activa y de la casa o del área.

create table tasks.reviews (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  template_id uuid not null references tasks.review_templates(id),
  title text not null check (length(btrim(title)) between 1 and 200),
  event_ref text check (event_ref is null or event_ref ~ '^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$'),
  status text not null default 'open' check (status in ('open', 'ready', 'opened')),
  opened_at timestamptz,
  opened_by uuid references auth.users(id),
  open_override boolean not null default false,
  open_note text check (open_note is null or length(open_note) <= 2000),
  pending_at_open jsonb check (pending_at_open is null or jsonb_typeof(pending_at_open) = 'array')
);
create index reviews_project_idx on tasks.reviews (project_id) where deleted_at is null;
create index reviews_event_idx on tasks.reviews (event_ref) where deleted_at is null;

create table tasks.review_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid not null references tasks.tabs(id),
  project_id uuid not null references tasks.projects(id),
  review_id uuid not null references tasks.reviews(id),
  task_id uuid not null references tasks.tasks(id),
  template_item_id uuid references tasks.review_template_items(id),
  zone text not null,
  title text not null,
  answer text not null check (answer in ('check', 'quantity', 'photo', 'reading', 'note')),
  expected jsonb not null default '{}'::jsonb,
  critical boolean not null default false,
  instructions text not null default '',
  position numeric not null default 0,
  state text not null default 'pending' check (state in ('pending', 'ok', 'failed', 'verified')),
  value numeric,
  text text check (text is null or length(text) <= 2000),
  file_id uuid,
  checked_by uuid references auth.users(id),
  checked_at timestamptz,
  first_failure jsonb,
  corrective_task_id uuid references tasks.tasks(id),
  recheck_task_id uuid references tasks.tasks(id)
);
create index review_items_review_idx on tasks.review_items (review_id, position) where deleted_at is null;
create unique index review_items_task_idx on tasks.review_items (task_id) where deleted_at is null;
create trigger tasks_guard_immutable before update on tasks.reviews for each row execute function tasks.guard_immutable('tab_id', 'project_id', 'template_id');
create trigger tasks_guard_immutable before update on tasks.review_items for each row execute function tasks.guard_immutable('tab_id', 'project_id', 'review_id', 'task_id');

select core.register_table('tasks', 'tasks', 'reviews', array['tab_id','project_id','template_id','title','event_ref','status','opened_at','opened_by','open_override','open_note','pending_at_open']);
select core.register_table('tasks', 'tasks', 'review_items', array['tab_id','project_id','review_id','task_id','template_item_id','zone','title','answer','expected','critical','instructions','position',
  'state','value','text','file_id','checked_by','checked_at','first_failure','corrective_task_id','recheck_task_id']);
select core.register_file_field('tasks', 'tasks', 'review_items', 'file_id', 'operational');

-- El nombre de cada zona, para las tareas madre.
create or replace function tasks.review_zone_label(p_zone text)
returns text language sql immutable as $$
  select case p_zone
    when 'habitaciones' then 'Habitaciones' when 'camas' then 'Camas' when 'aseos' then 'Aseos' when 'duchas_acs' then 'Duchas y agua caliente'
    when 'puertas' then 'Puertas' when 'electricidad' then 'Electricidad' when 'cocina' then 'Cocina' when 'maquinaria' then 'Maquinaria'
    when 'accesos' then 'Accesos' when 'barandillas' then 'Barandillas' when 'comunes' then 'Zonas comunes' when 'limpieza' then 'Limpieza'
    when 'extintores' then 'Extintores' when 'agua' then 'Agua' else p_zone end
$$;

-- Un uuid derivado (md5) de un texto: los ids de lo que crea una revisión.
create or replace function tasks.review_uuid(p_seed text)
returns uuid language sql immutable as $$
  select (substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-4' || substr(h, 14, 3) || '-8' || substr(h, 18, 3) || '-' || substr(h, 21, 12))::uuid
  from (select md5('ikisai-tasks-review:' || p_seed) h) x
$$;

-- Solo los procedimientos de la revisión escriben reviews y review_items (marca `tasks.review_write` = id de la revisión).
create or replace function tasks.validate_reviews(p jsonb)
returns void language plpgsql as $$
declare
  v_write text := coalesce(current_setting('tasks.review_write', true), '');
  c record;
begin
  for c in select ch.table_name, ch.row_id, ch.before, ch.after from core.changes ch
            where ch.app = p->>'app' and ch.cursor = (p->>'cursor')::bigint and ch.schema_name = 'tasks' and ch.table_name in ('reviews', 'review_items')
              and ch.op in ('insert', 'update', 'delete', 'restore') loop
    if v_write = '' or v_write <> (case when c.table_name = 'reviews' then c.row_id::text else coalesce(c.after, c.before)->>'review_id' end) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.' || c.table_name, 'id', c.row_id, 'reason', 'written only by the review procedures'));
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_reviews');

create or replace function tasks.review_create(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_args jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := p->>'app';
  v_actor uuid := (p->>'actor')::uuid;
  v_role text := p->>'role';
  v_req text := p->>'requestId';
  v_cur bigint := (p->>'cursor')::bigint;
  v_scopes jsonb;
  v_review uuid; v_tab uuid; v_tpl tasks.review_templates;
  v_title text; v_event text := nullif(btrim(coalesce(v_args->>'eventRef', '')), ''); v_due date;
  v_project uuid; v_pos numeric; v_zone_task uuid; v_task uuid; v_trade uuid; v_zpos numeric := 0; v_ipos numeric;
  z record; i record;
  v_items int := 0;
begin
  if coalesce(v_role, '') not in ('editor', 'owner') then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'editor or owner')); end if;
  begin
    v_review := (v_args->>'reviewId')::uuid; v_tab := (v_args->>'tabId')::uuid;
    select * into v_tpl from tasks.review_templates where id = (v_args->>'templateId')::uuid;
    v_due := nullif(v_args->>'due', '')::date;
  exception when others then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reviewId, templateId and tabId are uuids; due is a date'));
  end;
  if v_review is null or v_tab is null then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'reviewId and tabId required')); end if;
  -- Repetir devuelve la que ya hay.
  if exists (select 1 from tasks.reviews r where r.id = v_review) then
    return (select jsonb_build_object('reviewId', r.id, 'projectId', r.project_id, 'created', false) from tasks.reviews r where r.id = v_review);
  end if;
  select m.scopes into v_scopes from core.memberships m where m.app = v_app and m.user_id = v_actor;
  if not exists (select 1 from tasks.tabs t where t.id = v_tab and t.deleted_at is null) or not tasks.scope_full(v_scopes, v_tab) then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'a review needs the whole area'));
  end if;
  if v_tpl.id is null or v_tpl.deleted_at is not null or not v_tpl.active or (v_tpl.tab_id is not null and v_tpl.tab_id <> v_tab) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('kind', 'review_template', 'id', v_args->>'templateId'));
  end if;
  if not exists (select 1 from tasks.review_template_items it where it.template_id = v_tpl.id and it.deleted_at is null) then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'the template has no items'));
  end if;
  if v_event is not null and v_event !~ '^[a-z][a-z0-9_-]{1,30}:[A-Za-z0-9_.:/-]{1,150}$' then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'eventRef is <app>:<reference>'));
  end if;
  v_title := left(coalesce(nullif(btrim(v_args->>'title'), ''), v_tpl.name), 200);

  perform set_config('tasks.review_write', v_review::text, true);
  v_project := tasks.review_uuid(v_review || ':project');
  select coalesce(max(position), 0) + 1024 into v_pos from tasks.projects where tab_id = v_tab;
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.projects', 'id', v_project,
    'fields', jsonb_build_object('tab_id', v_tab, 'title', v_title, 'note', v_tpl.note, 'position', v_pos, 'due', v_due)));
  perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.reviews', 'id', v_review,
    'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'template_id', v_tpl.id, 'title', v_title, 'event_ref', v_event)));

  -- Una madre por zona, en el orden de la plantilla; una hija por ítem.
  for z in select it.zone, min(it.position) pos, (case when count(distinct it.trade_id) = 1 and bool_and(it.trade_id is not null) then min(it.trade_id::text)::uuid end) trade
             from tasks.review_template_items it where it.template_id = v_tpl.id and it.deleted_at is null group by it.zone order by min(it.position) loop
    v_zpos := v_zpos + 1024;
    v_zone_task := tasks.review_uuid(v_review || ':zone:' || z.zone);
    perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_zone_task,
      'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'title', tasks.review_zone_label(z.zone), 'position', v_zpos, 'due', v_due)));
    if z.trade is not null then
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades', 'id', tasks.review_uuid(v_review || ':zone-trade:' || z.zone),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_zone_task, 'trade_id', z.trade)));
    end if;
    v_ipos := 0;
    for i in select * from tasks.review_template_items it where it.template_id = v_tpl.id and it.deleted_at is null and it.zone = z.zone order by it.position, it.id loop
      v_ipos := v_ipos + 1024;
      v_task := tasks.review_uuid(v_review || ':item:' || i.id);
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.tasks', 'id', v_task,
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'parent_id', v_zone_task, 'title', i.title, 'note', i.instructions,
          'priority', case when i.critical then 'high' else 'normal' end, 'position', v_ipos, 'due', v_due)));
      if i.trade_id is not null then
        perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.task_trades', 'id', tasks.review_uuid(v_review || ':trade:' || i.id),
          'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'task_id', v_task, 'trade_id', i.trade_id)));
      end if;
      perform core.apply_row_op(v_app, v_actor, v_role, v_req, v_cur, jsonb_build_object('op', 'insert', 'table', 'tasks.review_items', 'id', tasks.review_uuid(v_review || ':ri:' || i.id),
        'fields', jsonb_build_object('tab_id', v_tab, 'project_id', v_project, 'review_id', v_review, 'task_id', v_task, 'template_item_id', i.id,
          'zone', i.zone, 'title', i.title, 'answer', i.answer, 'expected', i.expected, 'critical', i.critical, 'instructions', i.instructions, 'position', v_zpos * 1000 + v_ipos)));
      v_items := v_items + 1;
    end loop;
  end loop;
  return jsonb_build_object('reviewId', v_review, 'projectId', v_project, 'created', true, 'items', v_items);
end $$;
select core.allow_procedure('tasks', 'tasks.review_create');

do $$
declare f text;
begin
  foreach f in array array['tasks.review_zone_label(text)', 'tasks.review_uuid(text)', 'tasks.validate_reviews(jsonb)', 'tasks.review_create(jsonb)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
