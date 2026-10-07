-- Ikisai Central · equipos de personas (aprobado por el usuario el 7-10-2026 para la audiencia de la medición de uso,
-- coordinacion/ampliacion/USO.md §2.3). Una persona puede estar en varios equipos. Referencia: docs/central/API.md §2.11.
-- Toca solo el schema central. Sin datos reales: la semilla la ofrece la interfaz.

create table central.teams (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 60),
  color text check (color is null or color ~ '^#[0-9a-fA-F]{6}$'),
  position numeric not null default 0
);
create unique index teams_name_idx on central.teams (lower(btrim(name))) where deleted_at is null;

select core.register_table('central', 'central', 'teams', array['name','color','position']);

create table central.person_teams (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  person_id uuid not null references central.people(id),
  team_id uuid not null references central.teams(id)
);
create unique index person_teams_pair_idx on central.person_teams (person_id, team_id) where deleted_at is null;
create index person_teams_team_idx on central.person_teams (team_id) where deleted_at is null;
create trigger person_teams_forbid_reparent_person before update on central.person_teams
  for each row execute function central.forbid_reparent('person_id');
create trigger person_teams_forbid_reparent_team before update on central.person_teams
  for each row execute function central.forbid_reparent('team_id');

select core.register_table('central', 'central', 'person_teams', array['person_id','team_id']);

-- Invariantes y permiso de escritura, al final de cada lote. Escriben el owner y el editor con ámbito `people`
-- (lo comprueba también la Edge); todos los miembros de Central leen.
create or replace function central.check_teams(p jsonb)
returns void language plpgsql as $$
declare v_id uuid; v_member core.memberships;
begin
  if exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
              and c.schema_name = 'central' and c.table_name in ('teams', 'person_teams')) then
    select * into v_member from core.memberships where app = 'central' and user_id = (p->>'actor')::uuid;
    if v_member.role is distinct from 'owner' and not (v_member.role = 'editor' and coalesce(v_member.scopes->>'people', '') = 'true') then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.teams', 'reason', 'owner or editor with people scope'));
    end if;
  end if;

  select x.id into v_id from central.person_teams x
    join central.people p on p.id = x.person_id
    join central.teams t on t.id = x.team_id
   where x.deleted_at is null and (p.deleted_at is not null or t.deleted_at is not null) limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.person_teams', 'id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_teams');

-- ---------------------------------------------------------------------------
-- Proyección para el núcleo (audiencia por equipo de la medición de uso): solo personas activas con cuenta enlazada.
-- Ningún dato personal más allá del id de la cuenta.
-- ---------------------------------------------------------------------------
create view central.common_team_projection as
select t.id as team_id, t.name, p.user_id
  from central.person_teams x
  join central.teams t on t.id = x.team_id and t.deleted_at is null
  join central.people p on p.id = x.person_id and p.deleted_at is null and p.active and p.user_id is not null
 where x.deleted_at is null;

revoke all on central.common_team_projection from public, anon, authenticated;
grant select on central.common_team_projection to service_role;
select core.allow_read('central', 'central.common_team_projection', 'view');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
