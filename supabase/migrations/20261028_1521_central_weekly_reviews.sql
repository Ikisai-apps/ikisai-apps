-- Ikisai Central · revisión semanal de Dirección (C01; análisis en feedback/central/REVISION_SEMANAL.md; decisiones de VG
-- del 27-10): una revisión por semana ISO con sus notas y asistentes, y al cerrarla, la foto de los indicadores en crítico
-- o en atención (valor, objetivo, estado y nota; la leen editor y owner, porque puede llevar importes). La preparan el owner de Central y los editores con el ámbito
-- `direccion` (`core.memberships.scopes.direccion = true`); leen todos los miembros. Los OKR, después.
-- El permiso se mira con el rol y los ámbitos con los que empezó el lote (núcleo 0105), no con la membresía al final.
-- Toca solo el schema central.

create table central.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  week text not null check (week ~ '^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$'),
  held_on date,
  attendee_ids uuid[] not null default '{}' check (cardinality(attendee_ids) <= 40),
  summary text check (summary is null or length(summary) <= 1000),
  status text not null default 'abierta' check (status in ('abierta','cerrada'))
);
create unique index weekly_reviews_week_idx on central.weekly_reviews (week) where deleted_at is null;
create trigger weekly_reviews_code before insert on central.weekly_reviews for each row execute function central.assign_code('RSM');

select core.register_table('central', 'central', 'weekly_reviews', array['week','held_on','attendee_ids','summary','status']);

-- La foto de un indicador al cerrar la revisión: lo que el panel enseñaba (sin datos de personas) y la nota.
create table central.weekly_review_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  review_id uuid not null references central.weekly_reviews(id),
  app text not null check (app ~ '^[a-z][a-z0-9_]*$'),
  kpi text not null check (kpi ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  label text not null check (length(btrim(label)) between 1 and 80),
  period text not null check (length(period) between 1 and 10),
  value numeric,
  unit text not null check (unit ~ '^[a-z]{1,12}$'),
  target numeric,
  state text not null check (state in ('critico','atencion')),
  note text check (note is null or length(note) <= 300)
);
create unique index weekly_review_items_kpi_idx on central.weekly_review_items (review_id, kpi, period) where deleted_at is null;
create trigger weekly_review_items_reparent before update on central.weekly_review_items for each row execute function central.forbid_reparent('review_id');

-- Leen editor y owner: la foto puede llevar importes (`eur`), que un lector de Central no ve en el panel (ronda 8).
select core.register_table('central', 'central', 'weekly_review_items', array['review_id','app','kpi','label','period','value','unit','target','state','note'],
  '{editor,owner}');

-- Permiso (owner o editor con ámbito `direccion`, al empezar el lote) e invariantes: la foto cuelga de una revisión viva, y
-- una revisión cerrada ya no cambia de foto.
create or replace function central.check_weekly_reviews(p jsonb)
returns void language plpgsql as $$
declare v_role text; v_scopes jsonb; v_id uuid;
begin
  if not exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
                  and c.schema_name = 'central' and c.table_name in ('weekly_reviews', 'weekly_review_items')) then
    return;
  end if;
  if nullif(p->>'role', '') is not null then
    v_role := p->>'role'; v_scopes := p->'scopes';
  else
    select m.role, m.scopes into v_role, v_scopes from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid;
  end if;
  if v_role is distinct from 'owner' and not (v_role = 'editor' and coalesce(v_scopes->>'direccion', '') = 'true') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.weekly_reviews', 'reason', 'owner or editor with direccion scope'));
  end if;
  select i.id into v_id from central.weekly_review_items i join central.weekly_reviews r on r.id = i.review_id
   where i.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.weekly_review_items', 'id', v_id)); end if;
  -- La foto de una revisión que ya estaba cerrada antes de este lote no se toca.
  select c.row_id into v_id from core.changes c join central.weekly_reviews r on r.id = coalesce((c.after->>'review_id')::uuid, (c.before->>'review_id')::uuid)
   where c.app = 'central' and c.cursor = (p->>'cursor')::bigint and c.schema_name = 'central' and c.table_name = 'weekly_review_items'
     and r.status = 'cerrada'
     and not exists (select 1 from core.changes c2 where c2.app = 'central' and c2.cursor = c.cursor and c2.table_name = 'weekly_reviews'
                       and c2.row_id = r.id and (c2.before->>'status') is distinct from 'cerrada')
   limit 1;
  if v_id is not null then perform core.fail('REVIEW_CLOSED', 422, jsonb_build_object('table', 'central.weekly_review_items', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_weekly_reviews');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
