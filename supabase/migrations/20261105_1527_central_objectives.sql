-- Ikisai Central · OKR de Dirección (X5 del triaje del 05-11; decisión de VG: los OKR entran en la revisión semanal).
-- Un objetivo por trimestre con su título y sus resultados clave, que son indicadores del panel (`kpi`). El objetivo y los
-- umbrales de cada indicador siguen en `central.kpi_targets`; aquí solo se agrupan y se nombran. La revisión semanal
-- enseña cómo va cada objetivo. Los preparan el owner y el editor con el ámbito `direccion` (rol del inicio del lote);
-- leen todos los miembros. Toca solo el schema central.

create table central.objectives (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  quarter text not null check (quarter ~ '^\d{4}T[1-4]$'),
  title text not null check (length(btrim(title)) between 1 and 160),
  kpis text[] not null default '{}' check (cardinality(kpis) <= 10),
  notes text check (notes is null or length(notes) <= 500),
  position numeric not null default 0
);
create index objectives_quarter_idx on central.objectives (quarter) where deleted_at is null;
create trigger objectives_code before insert on central.objectives for each row execute function central.assign_code('OKR');

select core.register_table('central', 'central', 'objectives', array['quarter','title','kpis','notes','position']);

create or replace function central.check_objectives(p jsonb)
returns void language plpgsql as $$
declare v_role text; v_scopes jsonb;
begin
  if not exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
                  and c.schema_name = 'central' and c.table_name = 'objectives') then
    return;
  end if;
  if nullif(p->>'role', '') is not null then
    v_role := p->>'role'; v_scopes := p->'scopes';
  else
    select m.role, m.scopes into v_role, v_scopes from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid;
  end if;
  if v_role is distinct from 'owner' and not (v_role = 'editor' and coalesce(v_scopes->>'direccion', '') = 'true') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.objectives', 'reason', 'owner or editor with direccion scope'));
  end if;
end $$;

select core.add_validate_hook('central', 'central.check_objectives');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
