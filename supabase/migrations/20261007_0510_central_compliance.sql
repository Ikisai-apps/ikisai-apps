-- Ikisai Central · cumplimiento (C09): obligaciones con vencimiento, documentos clave y trabajo pedido a Tasks.
-- Referencia: docs/central/API.md §2.4–2.6, §3 y §4 (visto bueno de Core, ronda 1). Toca solo el schema central.
-- `vencido` y `caducado` no se guardan: se derivan de la fecha (API.md §3.2).

-- ---------------------------------------------------------------------------
-- Obligaciones (C09 «requisitos_legales»)
-- ---------------------------------------------------------------------------
create table central.requirements (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  name text not null check (length(btrim(name)) between 1 and 160),
  requirement_type text not null check (requirement_type in ('concesion','licencia_autorizacion','seguro','laboral_ss','prl','proteccion_datos',
    'garantia','entrega_recepcion','revision_tecnica','documentacion_contractual','cumplimiento_operativo','subvencion_ayuda_publica',
    'licitacion_concesion','reversion','otro')),
  description text check (description is null or length(description) <= 2000),
  source text check (source is null or length(source) <= 300),
  authority text check (authority is null or length(authority) <= 160),
  responsible_person_id uuid references central.people(id),
  status text not null default 'pendiente' check (status in ('pendiente','en_revision','cumplido','bloqueado','no_aplica','cerrado')),
  reference_date date,
  expires_on date,
  frequency text not null default 'unica' check (frequency in ('unica','mensual','trimestral','semestral','anual','bienal','trienal','quinquenal','otra')),
  frequency_months int check (frequency_months is null or frequency_months between 1 and 120),
  notice_days int not null default 30 check (notice_days between 0 and 365),
  risk text not null default 'medio' check (risk in ('bajo','medio','alto','critico')),
  impact text check (impact is null or impact in ('legal','administrativo','economico','operativo','reputacional','mixto')),
  blocks_operation boolean not null default false,
  generates_cost boolean not null default false,
  next_action text check (next_action is null or length(next_action) <= 300),
  next_action_on date,
  notes text check (notes is null or length(notes) <= 1000),
  position numeric not null default 0,
  constraint requirements_frequency check ((frequency = 'otra') = (frequency_months is not null))
);
create index requirements_expiry_idx on central.requirements (expires_on) where deleted_at is null;
create index requirements_status_idx on central.requirements (status) where deleted_at is null;
create trigger requirements_code before insert on central.requirements for each row execute function central.assign_code('LEG');

select core.register_table('central', 'central', 'requirements', array['name','requirement_type','description','source','authority',
  'responsible_person_id','status','reference_date','expires_on','frequency','frequency_months','notice_days','risk','impact',
  'blocks_operation','generates_cost','next_action','next_action_on','notes','position']);

-- ---------------------------------------------------------------------------
-- Documentos clave de la entidad (C09 «documentos_clave»), no de personas.
-- ---------------------------------------------------------------------------
create table central.key_documents (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  requirement_id uuid references central.requirements(id),
  document_type text not null check (document_type in ('contrato','anexo','poliza','certificado','licencia','autorizacion','acta','inventario',
    'protocolo','justificante_pago','factura','resolucion','memoria_justificativa','requerimiento','otro')),
  name text not null check (length(btrim(name)) between 1 and 160),
  description text check (description is null or length(description) <= 1000),
  status text not null default 'vigente' check (status in ('vigente','pendiente','en_revision','sustituido')),
  document_date date,
  reviewed_on date,
  expires_on date,
  version text check (version is null or length(version) <= 40),
  signed boolean not null default false,
  file_id uuid,
  external_url text check (external_url is null or (length(external_url) <= 500 and external_url ~ '^https://')),
  responsible_person_id uuid references central.people(id),
  notes text check (notes is null or length(notes) <= 1000),
  constraint key_documents_dates check (document_date is null or expires_on is null or expires_on >= document_date)
);
create index key_documents_requirement_idx on central.key_documents (requirement_id) where deleted_at is null;
create index key_documents_expiry_idx on central.key_documents (expires_on) where deleted_at is null and expires_on is not null;
create trigger key_documents_code before insert on central.key_documents for each row execute function central.assign_code('DOC');

select core.register_table('central', 'central', 'key_documents', array['requirement_id','document_type','name','description','status',
  'document_date','reviewed_on','expires_on','version','signed','file_id','external_url','responsible_person_id','notes']);

-- ---------------------------------------------------------------------------
-- Trabajo pedido a Tasks por una obligación (contrato §8: enlace tipado; el estado se lee de Tasks, no se copia).
-- Las filas las inserta la ruta `requirements/:id/task` de central-api; `beforeCommit` rechaza el insert desde el cliente.
-- ---------------------------------------------------------------------------
create table central.requirement_tasks (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  requirement_id uuid not null references central.requirements(id),
  target_app text not null default 'tasks' check (target_app = 'tasks'),
  target_kind text not null default 'task' check (target_kind = 'task'),
  target_id uuid not null,
  external_ref text not null check (length(external_ref) between 1 and 150),
  target_label text check (target_label is null or length(target_label) <= 500),
  target_revision bigint,
  due_on date
);
create unique index requirement_tasks_target_idx on central.requirement_tasks (target_id) where deleted_at is null;
create index requirement_tasks_requirement_idx on central.requirement_tasks (requirement_id) where deleted_at is null;
create trigger requirement_tasks_forbid_reparent before update on central.requirement_tasks
  for each row execute function central.forbid_reparent('requirement_id');

select core.register_table('central', 'central', 'requirement_tasks', array['requirement_id','target_app','target_kind','target_id',
  'external_ref','target_label','target_revision','due_on']);

-- ---------------------------------------------------------------------------
-- Invariantes del bloque (API.md §4.2): nada vivo colgando de una obligación borrada, y una persona responsable de
-- algo vivo no puede ir a la papelera (la interfaz propone marcarla inactiva).
-- ---------------------------------------------------------------------------
create or replace function central.check_compliance_invariants(p jsonb)
returns void language plpgsql as $$
declare v_id uuid;
begin
  select d.id into v_id from central.key_documents d join central.requirements r on r.id = d.requirement_id
   where d.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.key_documents', 'id', v_id)); end if;

  select t.id into v_id from central.requirement_tasks t join central.requirements r on r.id = t.requirement_id
   where t.deleted_at is null and r.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('ORPHAN_CHILD', 422, jsonb_build_object('table', 'central.requirement_tasks', 'id', v_id)); end if;

  select x.id into v_id from (
    select r.id, r.responsible_person_id as person from central.requirements r where r.deleted_at is null
    union all
    select d.id, d.responsible_person_id from central.key_documents d where d.deleted_at is null) x
    join central.people p on p.id = x.person
   where p.deleted_at is not null limit 1;
  if v_id is not null then perform core.fail('PERSON_IN_USE', 422, jsonb_build_object('id', v_id)); end if;
end $$;

select core.add_validate_hook('central', 'central.check_compliance_invariants');

-- Datos mínimos de una obligación para pedir su tarea a Tasks (ruta `requirements/:id/task`).
create or replace function central.requirement_brief(p_ctx jsonb)
returns jsonb language plpgsql stable as $$
declare v central.requirements;
begin
  if coalesce(p_ctx->'args'->>'id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform core.fail('NOT_FOUND', 404); end if;
  select * into v from central.requirements where id = (p_ctx->'args'->>'id')::uuid and deleted_at is null;
  if v.id is null then perform core.fail('NOT_FOUND', 404); end if;
  return jsonb_build_object('id', v.id, 'code', v.code, 'name', v.name, 'expiresOn', v.expires_on, 'risk', v.risk, 'status', v.status);
end $$;
select core.allow_read('central', 'central.requirement_brief', 'function', '{editor,owner}');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
