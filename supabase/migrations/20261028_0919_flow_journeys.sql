-- Ikisai Flow · recorridos (VG 27-10, visión V0.2; diseño aprobado por Core). El primero: «Registrar compra».
-- - Un recorrido es una definición con versiones; cada versión invoca UNA capacidad del catálogo del núcleo (0097) y sus
--   pasos son preguntas sobre los campos de entrada de esa capacidad (clave = ruta en el `input`: «supplier.name»), con su
--   explicación, si es esencial y el anclaje de pantalla (data-feedback-id) que señala la guía.
-- - Ejecuciones: modo «aprender» (borrador, explicaciones, revisión final; Registrar NO escribe fuera: queda practicada) y
--   modo «ejecutar» (solo lo esencial; al final la app invoca la capacidad por flow-api con el token de la persona, que deja
--   recibo en el núcleo, y anota el resultado). Los valores van en la propia ejecución (sin tabla de pasos aparte).
-- - Central: `flow.journey_steps_projection` (en qué recorridos participa cada función de cada app).

create table flow.definitions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  key text not null check (key ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text not null check (length(name) between 1 and 80),
  description text check (description is null or length(description) <= 300)
);
create unique index definitions_key_uidx on flow.definitions (key) where deleted_at is null;
select core.register_table('flow', 'flow', 'definitions', array['key','name','description'], '{reader,editor,owner}', '{owner}', true);

create table flow.definition_versions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  definition_id uuid not null references flow.definitions(id),
  version integer not null check (version >= 1),
  status text not null default 'draft' check (status in ('draft','published')),
  capability text not null check (capability ~ '^[a-z]+\.[a-z0-9_]+$')
);
create unique index definition_versions_uidx on flow.definition_versions (definition_id, version) where deleted_at is null;
select core.register_table('flow', 'flow', 'definition_versions', array['definition_id','version','status','capability'], '{reader,editor,owner}', '{owner}', true);

create table flow.definition_steps (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  version_id uuid not null references flow.definition_versions(id),
  position integer not null default 0,
  key text not null check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){0,3}$'),
  title text not null check (length(title) between 1 and 160),
  explain text check (explain is null or length(explain) <= 600),
  essential boolean not null default true,
  anchor text check (anchor is null or anchor ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$')
);
create unique index definition_steps_uidx on flow.definition_steps (version_id, key) where deleted_at is null;
select core.register_table('flow', 'flow', 'definition_steps', array['version_id','position','key','title','explain','essential','anchor'], '{reader,editor,owner}', '{owner}', true);

create table flow.executions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  version_id uuid not null references flow.definition_versions(id),
  mode text not null check (mode in ('learn','run')),
  status text not null default 'draft' check (status in ('draft','practiced','done','discarded','error')),
  actor uuid references auth.users(id),
  values jsonb not null default '{}'::jsonb,
  result jsonb,
  finished_at timestamptz
);
create index executions_actor_idx on flow.executions (actor);
-- Las ejecuciones no se sincronizan a todo el personal (llevan lo que alguien escribió): solo el owner las lee; la app no las necesita.
select core.register_table('flow', 'flow', 'executions', array['version_id','mode','status','actor','values','result','finished_at'], '{owner}', '{editor,owner}', true);
create trigger flow_guard before insert or update on flow.executions for each row execute function flow.guard_marks();

-- Empezar. args = { execution_id, version_id, mode }
create or replace function flow.start_execution(p jsonb) returns jsonb language plpgsql as $$
declare v_id uuid := flow.arg_uuid(p, 'execution_id'); v_version uuid := flow.arg_uuid(p, 'version_id'); v_mode text := p->'args'->>'mode';
begin
  perform flow.proc_begin();
  if v_mode is null or v_mode not in ('learn','run') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'mode must be learn or run')); end if;
  if not exists (select 1 from flow.definition_versions where id = v_version and status = 'published' and deleted_at is null) then
    perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.definition_versions'));
  end if;
  perform flow.ins(p, 'flow.executions', jsonb_build_object('version_id', v_version, 'mode', v_mode, 'status', 'draft', 'actor', (p->>'actor')::uuid), v_id);
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v_id);
end $$;

/** La ejecución, de quien la hace y aún en borrador. */
create or replace function flow.lock_execution(p jsonb) returns flow.executions language plpgsql as $$
declare v flow.executions;
begin
  select * into v from flow.executions where id = flow.arg_uuid(p, 'execution_id') and deleted_at is null for update;
  if v.id is null or v.actor is distinct from (p->>'actor')::uuid then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'flow.executions')); end if;
  if v.status <> 'draft' then perform core.fail('EXECUTION_FINISHED', 409, jsonb_build_object('execution_id', v.id, 'status', v.status)); end if;
  return v;
end $$;

-- Guardar respuestas (borrador). args = { execution_id, values: { <clave>: valor } }
create or replace function flow.save_execution_values(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions;
begin
  perform flow.proc_begin();
  v := flow.lock_execution(p);
  if jsonb_typeof(p->'args'->'values') <> 'object' then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'values must be an object')); end if;
  if length((v.values || (p->'args'->'values'))::text) > 20000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'values too large')); end if;
  perform flow.upd(p, 'flow.executions', v.id, v.revision, jsonb_build_object('values', v.values || (p->'args'->'values')));
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v.id);
end $$;

-- Terminar. args = { execution_id, status: practiced|done|discarded|error, result? }. «practiced» solo en aprender; «done» y
-- «error» solo en ejecutar (lo anota la app con la respuesta de la capacidad; el recibo de verdad está en el núcleo).
create or replace function flow.finish_execution(p jsonb) returns jsonb language plpgsql as $$
declare v flow.executions; v_status text := p->'args'->>'status';
begin
  perform flow.proc_begin();
  v := flow.lock_execution(p);
  if v_status is null or v_status not in ('practiced','done','discarded','error')
     or (v_status = 'practiced' and v.mode <> 'learn') or (v_status in ('done','error') and v.mode <> 'run') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'status not valid for this mode', 'mode', v.mode, 'status', v_status));
  end if;
  perform flow.upd(p, 'flow.executions', v.id, v.revision, jsonb_build_object('status', v_status, 'result', p->'args'->'result', 'finished_at', now()));
  perform flow.proc_end();
  return jsonb_build_object('execution_id', v.id, 'status', v_status);
end $$;

select core.allow_procedure('flow', 'flow.start_execution');
select core.allow_procedure('flow', 'flow.save_execution_values');
select core.allow_procedure('flow', 'flow.finish_execution');

-- Central («Uso y cobertura»): un paso por fila de los recorridos publicados. feature_id = anclaje, o la capacidad.
create view flow.journey_steps_projection as
  select d.id as flow_id, d.name as flow_name, v.version, s.key as step, split_part(v.capability, '.', 1) as app,
         coalesce(s.anchor, v.capability) as feature_id, v.capability
    from flow.definitions d
    join flow.definition_versions v on v.definition_id = d.id and v.deleted_at is null and v.status = 'published'
    join flow.definition_steps s on s.version_id = v.id and s.deleted_at is null
   where d.deleted_at is null;
select core.allow_read('central', 'flow.journey_steps_projection', 'view', '{owner}');

-- El primero: «Registrar compra» (la capacidad register_purchase_quick de Finance; docs/invoices/API.md §18).
insert into flow.definitions (id, key, name, description) values
  ('0f10a000-0000-4000-8000-00000000d001', 'registrar_compra', 'Registrar compra', 'Una compra pagada (ticket o factura) a Finance, pendiente de revisión.');
insert into flow.definition_versions (id, definition_id, version, status, capability) values
  ('0f10a000-0000-4000-8000-00000000d101', '0f10a000-0000-4000-8000-00000000d001', 1, 'published', 'invoices' || '.register_purchase_quick'); -- id del catálogo (app.operación), no un objeto de base de datos
insert into flow.definition_steps (version_id, position, key, title, explain, essential, anchor) values
  ('0f10a000-0000-4000-8000-00000000d101', 1, 'supplier.name', '¿A quién le has comprado?', 'El proveedor, como sale en el ticket. Si Finance no lo conoce, lo crea.', true, null),
  ('0f10a000-0000-4000-8000-00000000d101', 2, 'date', '¿Qué día fue la compra?', 'La fecha del ticket o de la factura, no la de hoy si es distinta.', true, null),
  ('0f10a000-0000-4000-8000-00000000d101', 3, 'total', '¿Cuánto pagaste, con IVA?', 'El total del ticket, en euros, con dos decimales.', true, null),
  ('0f10a000-0000-4000-8000-00000000d101', 4, 'description', '¿Qué compraste?', 'Una frase corta: «Hielo para la barra».', true, null),
  ('0f10a000-0000-4000-8000-00000000d101', 5, 'target', '¿Para qué es?', 'Para un evento de Booking o gasto general. Así la oficina lo imputa bien.', true, null),
  ('0f10a000-0000-4000-8000-00000000d101', 6, 'vat_rate', '¿Qué IVA lleva?', 'Si no lo sabes, déjalo: la oficina lo completa al revisar.', false, null),
  ('0f10a000-0000-4000-8000-00000000d101', 7, 'invoice_number', '¿Número del ticket o de la factura?', 'Si lo lleva. Ayuda a no registrarla dos veces.', false, null),
  ('0f10a000-0000-4000-8000-00000000d101', 8, 'notes', '¿Algo más que deba saber la oficina?', 'Por ejemplo: «Pagado con la caja de la barra».', false, null);

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
