-- Ikisai Central · personas: ficha básica, datos reservados (contacto y vinculación) y documentación con caducidad.
-- Referencia: docs/central/API.md §2.1–2.3, §4 y §5 (visto bueno de Core, ronda 1). Toca solo el schema central.
-- La app `central` ya está registrada por Core (0062_core_admin).

create schema if not exists central;
revoke all on schema central from public;
revoke all on schema central from anon, authenticated;
grant usage on schema central to service_role;

-- ---------------------------------------------------------------------------
-- Funciones de apoyo
-- ---------------------------------------------------------------------------
-- Código humano (PER_2026_001) al insertar. El prefijo llega como argumento del trigger; el año es el de alta en Madrid.
create or replace function central.assign_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then
    new.code := core.next_code(tg_argv[0], extract(year from (now() at time zone 'Europe/Madrid'))::int);
  end if;
  return new;
end $$;

-- Impide cambiar la columna de enlace con el padre (argumento del trigger) después del alta.
create or replace function central.forbid_reparent()
returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) ->> tg_argv[0]) is distinct from (to_jsonb(old) ->> tg_argv[0]) then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', tg_table_schema || '.' || tg_table_name, 'field', tg_argv[0]));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Ficha básica (C05 «equipo»). La ven todos los miembros de Central: sin contacto ni datos laborales.
-- ---------------------------------------------------------------------------
create table central.people (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  display_name text not null check (length(btrim(display_name)) between 1 and 80),
  relation text not null check (relation in ('equipo','colaborador','voluntario','practicas','otro')),
  base_role text not null default 'otro' check (base_role in ('direccion_general','direccion_operativa_comercial','cocina',
    'mantenimiento_logistica','limpieza','apoyo_tecnico_sonido','apoyo_implantacion_alojativa','refuerzo_eventual','otro')),
  coverage text not null default 'todo' check (coverage in ('todo','solo_eventos','solo_mantenimiento','solo_cocina','solo_limpieza',
    'solo_tecnico','solo_comercial')),
  availability text not null default 'segun_calendario' check (availability in ('alta','media','baja','segun_calendario','no_disponible')),
  availability_notes text check (availability_notes is null or length(availability_notes) <= 300),
  active boolean not null default true,
  committed_post boolean not null default false,
  user_id uuid references auth.users(id),
  position numeric not null default 0
);
create unique index people_user_idx on central.people (user_id) where deleted_at is null and user_id is not null;
create index people_active_idx on central.people (active, relation) where deleted_at is null;
create trigger people_code before insert on central.people for each row execute function central.assign_code('PER');

select core.register_table('central', 'central', 'people', array['display_name','relation','base_role','coverage','availability',
  'availability_notes','active','committed_post','user_id','position']);

-- ---------------------------------------------------------------------------
-- Datos reservados (1:1): contacto, vinculación y contacto de emergencia. Solo owner y editor con ámbito `people`
-- (readable_roles aquí; el filtro del ámbito lo aplica el hook `visible` de central-api).
-- ---------------------------------------------------------------------------
create table central.person_private (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  person_id uuid not null references central.people(id),
  legal_name text check (legal_name is null or length(legal_name) <= 160),
  phone text check (phone is null or length(phone) <= 32),
  email text check (email is null or (length(email) <= 320 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  engagement text check (engagement is null or engagement in ('contrato_indefinido','contrato_temporal','autonomo','colaborador_externo',
    'apoyo_puntual','voluntariado','sin_vinculo')),
  engaged_from date,
  engaged_until date,
  emergency_contact text check (emergency_contact is null or length(emergency_contact) <= 160),
  notes text check (notes is null or length(notes) <= 1000),
  constraint person_private_dates check (engaged_from is null or engaged_until is null or engaged_until >= engaged_from)
);
create unique index person_private_person_idx on central.person_private (person_id) where deleted_at is null;
create trigger person_private_forbid_reparent before update on central.person_private
  for each row execute function central.forbid_reparent('person_id');

select core.register_table('central', 'central', 'person_private', array['person_id','legal_name','phone','email','engagement',
  'engaged_from','engaged_until','emergency_contact','notes'], '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Documentación y formación con caducidad (C05 «documentacion»). Mismo acceso que person_private.
-- `caducado` no se guarda: se deriva de expires_on (API.md §3.2).
-- ---------------------------------------------------------------------------
create table central.person_records (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  person_id uuid not null references central.people(id),
  kind text not null check (kind in ('documento','formacion')),
  record_type text not null,
  title text check (title is null or length(btrim(title)) between 1 and 120),
  status text not null default 'pendiente' check (status in ('ok','pendiente','en_revision','no_aplica')),
  issued_on date,
  expires_on date,
  reviewed_on date,
  file_id uuid,
  notes text check (notes is null or length(notes) <= 500),
  position numeric not null default 0,
  constraint person_records_type check (
    (kind = 'documento' and record_type in ('contrato_o_vinculo','alta_ss_o_reta','datos_fiscales','prl_basico','certificado_delitos_sexuales','otro_documento'))
    or (kind = 'formacion' and record_type in ('manipulador_alimentos','prl_basico','primeros_auxilios','socorrismo','otra_formacion'))),
  constraint person_records_title check (record_type not in ('otro_documento','otra_formacion') or title is not null),
  constraint person_records_dates check (issued_on is null or expires_on is null or expires_on >= issued_on)
);
create index person_records_person_idx on central.person_records (person_id, position) where deleted_at is null;
create index person_records_expiry_idx on central.person_records (expires_on) where deleted_at is null and expires_on is not null;
create trigger person_records_forbid_reparent before update on central.person_records
  for each row execute function central.forbid_reparent('person_id');

select core.register_table('central', 'central', 'person_records', array['person_id','kind','record_type','title','status','issued_on',
  'expires_on','reviewed_on','file_id','notes','position'], '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Invariantes al final de cada lote (API.md §4.2): nada reservado vivo colgando de una persona borrada,
-- y una cuenta enlazada no puede ser un agente.
-- ---------------------------------------------------------------------------
create or replace function central.check_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select x.id into v_id from central.person_private x join central.people p on p.id = x.person_id
   where x.deleted_at is null and p.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.person_private', 'id', v_id)); end if;

  select x.id into v_id from central.person_records x join central.people p on p.id = x.person_id
   where x.deleted_at is null and p.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.person_records', 'id', v_id)); end if;

  select p.id into v_id from central.people p join core.profiles f on f.user_id = p.user_id
   where p.deleted_at is null and f.kind = 'agent' limit 1;
  if v_id is not null then perform core.fail('INVALID_ACCOUNT', 422, jsonb_build_object('table', 'central.people', 'id', v_id, 'reason', 'an agent is not a person')); end if;
end $$;

select core.add_validate_hook('central', 'central.check_invariants');

-- ---------------------------------------------------------------------------
-- Lecturas registradas (contrato §5.1)
-- ---------------------------------------------------------------------------
-- Catálogo completo de apps para la pantalla Accesos (GET apps del kit solo da las de la cuenta). Solo owner de Central.
create or replace function central.app_catalog(p_ctx jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object('items', coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'domain', a.domain,
           'aliasDomain', a.alias_domain, 'kind', a.kind, 'description', a.description) order by a.sort, a.id), '[]'::jsonb))
    from core.apps a;
$$;
select core.allow_read('central', 'central.app_catalog', 'function', '{owner}');

-- Archivo de un registro de documentación (API.md §8): solo si quien pide ve los datos reservados (owner, o editor
-- con ámbito `people`). La Edge firma la URL. Mientras el kit no compruebe la visibilidad en files/:id (P1).
create or replace function central.record_file(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v_member core.memberships; v_file uuid;
begin
  select * into v_member from core.memberships where app = 'central' and user_id = (p_ctx->>'actor')::uuid;
  if v_member.role is distinct from 'owner' and not (v_member.role = 'editor' and coalesce(v_member.scopes->>'people', '') = 'true') then
    perform core.fail('NOT_FOUND', 404);
  end if;
  if coalesce(p_ctx->'args'->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform core.fail('NOT_FOUND', 404); end if;
  select file_id into v_file from central.person_records where id = (p_ctx->'args'->>'id')::uuid and deleted_at is null;
  if v_file is null then perform core.fail('NOT_FOUND', 404); end if;
  return jsonb_build_object('fileId', v_file);
end $$;
select core.allow_read('central', 'central.record_file', 'function', '{editor,owner}');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
