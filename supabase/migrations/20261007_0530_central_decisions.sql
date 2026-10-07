-- Ikisai Central · registro de decisiones (C01 «decision_clave», aprobado por el usuario en la ronda 9).
-- Tres niveles de lectura: nombre llano, descripción llana y explicación técnica. Referencia: docs/central/API.md §2.10.
-- Toca solo el schema central.

create table central.decisions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  decided_on date not null,
  name text not null check (length(btrim(name)) between 1 and 160),
  summary text not null check (length(btrim(summary)) between 1 and 2000),
  technical text check (technical is null or length(technical) <= 8000),
  responsible_person_id uuid references central.people(id),
  status text not null default 'vigente' check (status in ('vigente','sustituida','revocada')),
  superseded_by uuid references central.decisions(id),
  scopes text[] not null default '{}' check (cardinality(scopes) <= 10),
  link_url text check (link_url is null or (length(link_url) <= 500 and link_url ~ '^https://')),
  link_label text check (link_label is null or length(btrim(link_label)) between 1 and 120),
  constraint decisions_superseded check ((status = 'sustituida') = (superseded_by is not null)),
  constraint decisions_not_self check (superseded_by is null or superseded_by <> id)
);
create index decisions_date_idx on central.decisions (decided_on desc) where deleted_at is null;
create trigger decisions_code before insert on central.decisions for each row execute function central.assign_code('DEC');

select core.register_table('central', 'central', 'decisions', array['decided_on','name','summary','technical','responsible_person_id',
  'status','superseded_by','scopes','link_url','link_label']);

-- Una decisión viva no puede estar sustituida por otra que esté en la papelera.
create or replace function central.check_decisions(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select d.id into v_id from central.decisions d join central.decisions n on n.id = d.superseded_by
   where d.deleted_at is null and n.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.decisions', 'id', v_id, 'reason', 'superseding decision deleted')); end if;

  select x.id into v_id from central.decisions x join central.people p on p.id = x.responsible_person_id
   where x.deleted_at is null and p.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('PERSON_IN_USE', 422, jsonb_build_object('id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_decisions');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
