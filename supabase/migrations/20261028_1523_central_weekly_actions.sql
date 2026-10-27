-- Ikisai Central · acciones de la revisión semanal (decisión de VG del 27-10, vg-41; análisis en
-- feedback/central/CAMAS_DESDE_CENTRAL.md): cada punto de la revisión (un indicador en crítico o en atención) puede terminar
-- en una decisión (`central.decisions`) o en una tarea de Tasks (kind `central.weekly_action`, pedida por la Edge como las
-- de las obligaciones). Se crean mientras la revisión está abierta; la siguiente enseña cómo van.
-- Permiso como la revisión (1521): el owner o un editor con el ámbito `direccion`, con el rol del inicio del lote.
-- Toca solo el schema central.

create table central.weekly_actions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  review_id uuid not null references central.weekly_reviews(id),
  kpi text not null check (kpi ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  label text not null check (length(btrim(label)) between 1 and 80),
  kind text not null check (kind in ('decision','task')),
  decision_id uuid references central.decisions(id),
  task_target_id uuid,
  task_external_ref text unique check (task_external_ref is null or length(task_external_ref) between 3 and 120),
  task_label text check (task_label is null or length(task_label) <= 500),
  task_revision bigint,
  constraint weekly_actions_kind check ((kind = 'decision' and decision_id is not null and task_target_id is null)
                                     or (kind = 'task' and task_target_id is not null and decision_id is null))
);
create index weekly_actions_review_idx on central.weekly_actions (review_id) where deleted_at is null;
create trigger weekly_actions_reparent before update on central.weekly_actions for each row execute function central.forbid_reparent('review_id');

select core.register_table('central', 'central', 'weekly_actions', array['review_id','kpi','label','kind','decision_id','task_target_id','task_external_ref','task_label','task_revision']);

create or replace function central.check_weekly_actions(p jsonb)
returns void language plpgsql as $$
declare v_role text; v_scopes jsonb; v_id uuid;
begin
  if not exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
                  and c.schema_name = 'central' and c.table_name = 'weekly_actions') then
    return;
  end if;
  if nullif(p->>'role', '') is not null then
    v_role := p->>'role'; v_scopes := p->'scopes';
  else
    select m.role, m.scopes into v_role, v_scopes from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid;
  end if;
  if v_role is distinct from 'owner' and not (v_role = 'editor' and coalesce(v_scopes->>'direccion', '') = 'true') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.weekly_actions', 'reason', 'owner or editor with direccion scope'));
  end if;
  -- Solo en una revisión abierta y viva.
  select c.row_id into v_id from core.changes c join central.weekly_reviews r on r.id = (c.after->>'review_id')::uuid
   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint and c.schema_name = 'central' and c.table_name = 'weekly_actions'
     and c.op = 'insert' and (r.status = 'cerrada' or r.deleted_at is not null)
   limit 1;
  if v_id is not null then perform core.fail('REVIEW_CLOSED', 422, jsonb_build_object('table', 'central.weekly_actions', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_weekly_actions');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
