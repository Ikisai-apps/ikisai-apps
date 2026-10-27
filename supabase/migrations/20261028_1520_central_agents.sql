-- Ikisai Central · fichas de agente (traspaso de Flow §8.3; propuesta en feedback/central/FICHA_AGENTE.md; decisión de VG
-- del 27-10: tabla propia, y el responsable puede ser una persona, por defecto, o una entidad de servicio).
-- La ficha no es una cuenta: se apoya en la cuenta de agente del núcleo (`core.profiles.kind = 'agent'`, claves en
-- `core.agent_keys`) y añade lo que el núcleo no guarda: quién responde por el agente, qué hace, en qué trabaja y quién le
-- sigue si se le sustituye. Los ámbitos (apps, proyectos y roles) se leen de `core.memberships`; aquí no se copian.
-- - Solo el owner de Central da de alta, cambia y da de baja las fichas (como los datos de la entidad).
-- - Sin responsable no se activa (check). La cuenta enlazada tiene que ser de agente y la persona responsable, una ficha
--   activa de Central (hook). Revocar las claves de un agente no toca su ficha: no hay borrado en cascada.
-- Toca solo el schema central.

create table central.agents (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  user_id uuid references auth.users(id),
  mission text check (mission is null or length(mission) <= 500),
  work_areas text check (work_areas is null or length(work_areas) <= 300),
  responsible_kind text not null default 'person' check (responsible_kind in ('person','service')),
  responsible_person_id uuid references central.people(id),
  responsible_service text check (responsible_service is null or length(btrim(responsible_service)) between 1 and 120),
  active boolean not null default false,
  successor_id uuid references central.agents(id),
  notes text check (notes is null or length(notes) <= 500),
  constraint agents_responsible_kind check ((responsible_kind = 'person' and responsible_service is null)
                                         or (responsible_kind = 'service' and responsible_person_id is null)),
  constraint agents_active_responsible check (not active or responsible_person_id is not null or responsible_service is not null),
  constraint agents_successor_not_self check (successor_id is distinct from id)
);
create unique index agents_user_idx on central.agents (user_id) where deleted_at is null and user_id is not null;
create index agents_responsible_idx on central.agents (responsible_person_id) where deleted_at is null;
create trigger agents_code before insert on central.agents for each row execute function central.assign_code('AGT');

select core.register_table('central', 'central', 'agents', array['display_name','user_id','mission','work_areas','responsible_kind',
  'responsible_person_id','responsible_service','active','successor_id','notes'], '{reader,editor,owner}', '{owner}');

-- La cuenta enlazada es de agente; la persona responsable, una ficha activa y viva de Central, que no se borra mientras responda.
create or replace function central.check_agents(p jsonb)
returns void language plpgsql as $$
declare v_change record; v_id uuid;
begin
  for v_change in
    select c.row_id, c.after
      from core.changes c
     where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
       and c.schema_name = 'central' and c.table_name = 'agents' and c.after is not null
  loop
    if (v_change.after->>'user_id') is not null
       and not exists (select 1 from core.profiles pr where pr.user_id = (v_change.after->>'user_id')::uuid and pr.kind = 'agent') then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'central.agents', 'id', v_change.row_id, 'field', 'user_id',
        'reason', 'the linked account is not an agent'));
    end if;
    if (v_change.after->>'responsible_person_id') is not null
       and not exists (select 1 from central.people pe where pe.id = (v_change.after->>'responsible_person_id')::uuid
                          and pe.deleted_at is null and pe.active and pe.merged_into is null) then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'central.agents', 'id', v_change.row_id, 'field', 'responsible_person_id',
        'reason', 'the responsible person must be an active person of central'));
    end if;
  end loop;
  -- Como en obligaciones y decisiones: no se borra la ficha de una persona que responde por un agente vivo.
  select a.id into v_id from central.agents a join central.people pe on pe.id = a.responsible_person_id
   where a.deleted_at is null and pe.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('PERSON_IN_USE', 422, jsonb_build_object('id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_agents');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
