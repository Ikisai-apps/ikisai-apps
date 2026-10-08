-- Invoices · facturas recibidas que llegan por Google Drive (fase 4, propuesta aprobada por Core el 8-10-2026).
-- Toca solo el schema invoices.
--
-- La Edge (`POST /api/v1/worker/drive/tick`) revisa la carpeta «Entrada» de la unidad compartida, importa cada PDF como
-- factura recibida con la cuenta de servicio `drive` («Drive (sistema)», editor en Finance) y lo mueve a «Importadas»,
-- «Duplicadas» o «Con errores». Nunca se borra nada en Drive. Aquí: el origen en la factura, el estado del worker y su
-- registro (tablas internas sin roles, como las de VERI*FACTU), las acciones de sistema y la sonda del planificador.

-- 1. Origen Drive en la factura (no en `source`: import_v1 exige `manual` en la existente y escribe `import_v1`).
alter table invoices.invoices add column drive_file_id text check (drive_file_id is null or length(drive_file_id) between 1 and 200),
  add column drive_url text check (drive_url is null or (drive_url ~ '^https://' and length(drive_url) <= 500));
create unique index invoices_drive_file_idx on invoices.invoices (drive_file_id) where drive_file_id is not null;

select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url'], '{reader,editor,owner}', '{editor,owner}', true);

-- 2. Estado del worker (una fila), archivos vistos y ejecuciones. Solo los escriben las acciones de sistema.
create table invoices.drive_state (
  id int primary key default 1 check (id = 1),
  folders jsonb not null default '{}'::jsonb,
  last_run_at timestamptz,
  more boolean not null default false,
  requested_at timestamptz,
  health text not null default 'unknown' check (health in ('unknown', 'ok', 'not_configured', 'blocked', 'error')),
  health_detail text check (health_detail is null or length(health_detail) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);

create table invoices.drive_imports (
  id uuid primary key default gen_random_uuid(),
  drive_file_id text not null unique check (length(drive_file_id) between 1 and 200),
  name text not null check (length(name) between 1 and 300),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('importada', 'duplicada', 'error')),
  reason text check (reason is null or length(reason) <= 300),
  invoice_id uuid,
  duplicate_of uuid,
  moved_to text check (moved_to is null or moved_to in ('Importadas', 'Duplicadas', 'Con errores')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);
create index drive_imports_created_idx on invoices.drive_imports (created_at desc);

create table invoices.drive_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  listed int not null default 0 check (listed >= 0),
  imported int not null default 0 check (imported >= 0),
  read int not null default 0 check (read >= 0),
  duplicates int not null default 0 check (duplicates >= 0),
  errors int not null default 0 check (errors >= 0),
  -- Llamadas a la Drive API en la ejecución (vigilar el volumen: solo se usa la Drive API, gratuita dentro de su cuota).
  api_calls int not null default 0 check (api_calls >= 0),
  outcome text check (outcome is null or outcome in ('ok', 'not_configured', 'blocked', 'error')),
  detail text check (detail is null or length(detail) <= 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  revision bigint not null default 1
);
create index drive_runs_started_idx on invoices.drive_runs (started_at desc);

select core.register_table('invoices', 'invoices', 'drive_state', array[]::text[], '{}', '{}', true);
select core.register_table('invoices', 'invoices', 'drive_imports', array[]::text[], '{}', '{}', true);
select core.register_table('invoices', 'invoices', 'drive_runs', array[]::text[], '{}', '{}', true);

-- 3. Acciones de sistema (solo el worker, actor nulo: roles vacíos).
-- drive_seen: qué archivos de Drive ya tienen registro (el tick no repite una importación si murió antes de moverlo).
create or replace function invoices.drive_seen(p jsonb)
returns jsonb language sql as $$
  select jsonb_build_object(
    'state', (select jsonb_build_object('folders', s.folders, 'last_run_at', s.last_run_at, 'requested_at', s.requested_at) from invoices.drive_state s where s.id = 1),
    'seen', coalesce((select jsonb_agg(jsonb_build_object('drive_file_id', d.drive_file_id, 'status', d.status, 'invoice_id', d.invoice_id, 'moved_to', d.moved_to))
      from invoices.drive_imports d
      where d.drive_file_id in (select jsonb_array_elements_text(coalesce(p->'args'->'drive_file_ids', '[]'::jsonb)))), '[]'::jsonb));
$$;

-- drive_record: lo que pasó con un archivo (importada, duplicada o error) y adónde se movió.
create or replace function invoices.drive_record(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args';
begin
  if coalesce(a->>'drive_file_id', '') = '' or coalesce(a->>'name', '') = '' or a->>'status' not in ('importada', 'duplicada', 'error') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'drive_file_id, name y status son obligatorios'));
  end if;
  insert into invoices.drive_imports (drive_file_id, name, sha256, status, reason, invoice_id, duplicate_of, moved_to)
  values (a->>'drive_file_id', left(a->>'name', 300), a->>'sha256', a->>'status', left(a->>'reason', 300),
          nullif(a->>'invoice_id', '')::uuid, nullif(a->>'duplicate_of', '')::uuid, a->>'moved_to')
  on conflict (drive_file_id) do update set
    status = excluded.status, reason = coalesce(excluded.reason, invoices.drive_imports.reason),
    sha256 = coalesce(excluded.sha256, invoices.drive_imports.sha256),
    invoice_id = coalesce(excluded.invoice_id, invoices.drive_imports.invoice_id),
    duplicate_of = coalesce(excluded.duplicate_of, invoices.drive_imports.duplicate_of),
    moved_to = coalesce(excluded.moved_to, invoices.drive_imports.moved_to),
    updated_at = now(), revision = invoices.drive_imports.revision + 1;
  return jsonb_build_object('ok', true);
end $$;

-- drive_finish: cierra la ejecución, guarda carpetas y salud, y si quedaron archivos para el siguiente tick.
create or replace function invoices.drive_finish(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_outcome text := coalesce(a->>'outcome', 'ok');
begin
  if v_outcome not in ('ok', 'not_configured', 'blocked', 'error') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'outcome')); end if;
  insert into invoices.drive_runs (started_at, finished_at, listed, imported, read, duplicates, errors, api_calls, outcome, detail)
  values (coalesce((a->>'started_at')::timestamptz, now()), now(), coalesce((a->>'listed')::int, 0), coalesce((a->>'imported')::int, 0), coalesce((a->>'read')::int, 0),
          coalesce((a->>'duplicates')::int, 0), coalesce((a->>'errors')::int, 0), coalesce((a->>'api_calls')::int, 0), v_outcome, left(a->>'detail', 300));
  insert into invoices.drive_state (id, folders, last_run_at, more, requested_at, health, health_detail)
  values (1, coalesce(a->'folders', '{}'::jsonb), now(), coalesce((a->>'more')::boolean, false), null, v_outcome, left(a->>'detail', 300))
  on conflict (id) do update set
    folders = case when a ? 'folders' then a->'folders' else invoices.drive_state.folders end,
    last_run_at = now(), more = coalesce((a->>'more')::boolean, false), requested_at = null,
    health = v_outcome, health_detail = left(a->>'detail', 300), updated_at = now(), revision = invoices.drive_state.revision + 1;
  -- El registro de ejecuciones guarda las 500 últimas.
  delete from invoices.drive_runs where id in (select id from invoices.drive_runs order by started_at desc offset 500);
  return jsonb_build_object('ok', true);
end $$;

select core.allow_read('invoices', 'invoices.drive_seen', 'action', '{}');
select core.allow_read('invoices', 'invoices.drive_record', 'action', '{}');
select core.allow_read('invoices', 'invoices.drive_finish', 'action', '{}');

-- 4. Para el owner (Ajustes): estado, últimas ejecuciones y últimos archivos con problema.
create or replace function invoices.drive_status(p jsonb)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'state', (select jsonb_build_object('last_run_at', s.last_run_at, 'health', s.health, 'health_detail', s.health_detail, 'more', s.more, 'requested_at', s.requested_at)
      from invoices.drive_state s where s.id = 1),
    'runs', coalesce((select jsonb_agg(jsonb_build_object('started_at', r.started_at, 'listed', r.listed, 'imported', r.imported, 'read', r.read,
        'duplicates', r.duplicates, 'errors', r.errors, 'api_calls', r.api_calls, 'outcome', r.outcome, 'detail', r.detail) order by r.started_at desc)
      from (select * from invoices.drive_runs order by started_at desc limit 10) r), '[]'::jsonb),
    'files', coalesce((select jsonb_agg(jsonb_build_object('name', d.name, 'status', d.status, 'reason', d.reason, 'invoice_id', d.invoice_id,
        'duplicate_of', d.duplicate_of, 'moved_to', d.moved_to, 'at', d.updated_at) order by d.updated_at desc)
      from (select * from invoices.drive_imports order by updated_at desc limit 20) d), '[]'::jsonb));
$$;
select core.allow_read('invoices', 'invoices.drive_status', 'function', '{owner}');

-- 5. Sonda del planificador: sin llamar a Drive (no se puede desde SQL), decide por tiempo, por lo que quedó a medias o
-- porque un owner pulsó «Buscar ahora».
create or replace function invoices.drive_has_work()
returns boolean language sql stable as $$
  select coalesce((select s.last_run_at is null or s.last_run_at <= now() - interval '14 minutes' or s.more or s.requested_at is not null
                     from invoices.drive_state s where s.id = 1), true);
$$;
select core.schedule_tick('invoices', 'drive/tick', '*/15 * * * *', 'invoices.drive_has_work');

revoke all on function invoices.drive_seen(jsonb), invoices.drive_record(jsonb), invoices.drive_finish(jsonb), invoices.drive_status(jsonb), invoices.drive_has_work()
  from public, anon, authenticated;
