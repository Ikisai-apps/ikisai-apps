-- Invoices · relectura automática de lo que llegó por Drive cuando mejora el lector (9-10-2026, petición de Core).
-- Toca solo el schema invoices.
--
-- Cada archivo guarda la versión del lector con que se leyó (`drive_imports.reader_version`) y el estado, la última versión
-- que ha corrido (`drive_state.reader_version`). El tick vuelve a leer, con el presupuesto de 5 por tick que sobre, los
-- borradores de Drive que siguen en «Pendiente de datos» leídos con una versión anterior (o antes de existir la versión),
-- y la sonda despierta al planificador mientras queden. Así cada mejora del lector se aplica sola a lo pendiente.

alter table invoices.drive_imports add column reader_version int check (reader_version is null or reader_version >= 0);
alter table invoices.drive_state add column reader_version int check (reader_version is null or reader_version >= 0);

-- drive_record (de 0224) con la versión del lector.
create or replace function invoices.drive_record(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args';
begin
  if coalesce(a->>'drive_file_id', '') = '' or coalesce(a->>'name', '') = '' or a->>'status' not in ('importada', 'duplicada', 'error') then
    perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'drive_file_id, name y status son obligatorios'));
  end if;
  insert into invoices.drive_imports (drive_file_id, name, sha256, status, reason, invoice_id, duplicate_of, moved_to, reader_version)
  values (a->>'drive_file_id', left(a->>'name', 300), a->>'sha256', a->>'status', left(a->>'reason', 300),
          nullif(a->>'invoice_id', '')::uuid, nullif(a->>'duplicate_of', '')::uuid, a->>'moved_to', (a->>'reader_version')::int)
  on conflict (drive_file_id) do update set
    status = excluded.status, reason = coalesce(excluded.reason, invoices.drive_imports.reason),
    sha256 = coalesce(excluded.sha256, invoices.drive_imports.sha256),
    invoice_id = coalesce(excluded.invoice_id, invoices.drive_imports.invoice_id),
    duplicate_of = coalesce(excluded.duplicate_of, invoices.drive_imports.duplicate_of),
    moved_to = coalesce(excluded.moved_to, invoices.drive_imports.moved_to),
    reader_version = coalesce(excluded.reader_version, invoices.drive_imports.reader_version),
    updated_at = now(), revision = invoices.drive_imports.revision + 1;
  return jsonb_build_object('ok', true);
end $$;

-- drive_finish (de 0224) con la última versión del lector que ha corrido.
create or replace function invoices.drive_finish(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v_outcome text := coalesce(a->>'outcome', 'ok');
begin
  if v_outcome not in ('ok', 'not_configured', 'blocked', 'error') then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('field', 'outcome')); end if;
  insert into invoices.drive_runs (started_at, finished_at, listed, imported, read, duplicates, errors, api_calls, outcome, detail)
  values (coalesce((a->>'started_at')::timestamptz, now()), now(), coalesce((a->>'listed')::int, 0), coalesce((a->>'imported')::int, 0), coalesce((a->>'read')::int, 0),
          coalesce((a->>'duplicates')::int, 0), coalesce((a->>'errors')::int, 0), coalesce((a->>'api_calls')::int, 0), v_outcome, left(a->>'detail', 300));
  insert into invoices.drive_state (id, folders, last_run_at, more, requested_at, health, health_detail, reader_version)
  values (1, coalesce(a->'folders', '{}'::jsonb), now(), coalesce((a->>'more')::boolean, false), null, v_outcome, left(a->>'detail', 300), (a->>'reader_version')::int)
  on conflict (id) do update set
    folders = case when a ? 'folders' then a->'folders' else invoices.drive_state.folders end,
    last_run_at = now(), more = coalesce((a->>'more')::boolean, false), requested_at = null,
    health = v_outcome, health_detail = left(a->>'detail', 300),
    reader_version = coalesce((a->>'reader_version')::int, invoices.drive_state.reader_version),
    updated_at = now(), revision = invoices.drive_state.revision + 1;
  delete from invoices.drive_runs where id in (select id from invoices.drive_runs order by started_at desc offset 500);
  return jsonb_build_object('ok', true);
end $$;

-- drive_stale: borradores de Drive en «Pendiente de datos» leídos con una versión anterior a `version` (o sin versión).
create or replace function invoices.drive_stale(p jsonb)
returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(x.id), '[]'::jsonb) from (
    select i.id from invoices.invoices i
      left join invoices.drive_imports d on d.drive_file_id = i.drive_file_id
     where i.deleted_at is null and i.status = 'pendiente_datos' and i.drive_file_id is not null
       and (d.reader_version is null or d.reader_version < coalesce((p->'args'->>'version')::int, 0))
     order by i.created_at
     limit least(greatest(coalesce((p->'args'->>'limit')::int, 5), 0), 20)) x;
$$;
select core.allow_read('invoices', 'invoices.drive_stale', 'action', '{}');

-- Sonda (de 0224): también hay trabajo si quedan borradores leídos con una versión anterior a la última que ha corrido.
create or replace function invoices.drive_has_work()
returns boolean language sql stable as $$
  select coalesce((select s.last_run_at is null or s.last_run_at <= now() - interval '14 minutes' or s.more or s.requested_at is not null
                     or exists (select 1 from invoices.invoices i left join invoices.drive_imports d on d.drive_file_id = i.drive_file_id
                                 where i.deleted_at is null and i.status = 'pendiente_datos' and i.drive_file_id is not null
                                   and (d.reader_version is null or d.reader_version < coalesce(s.reader_version, 0)))
                     from invoices.drive_state s where s.id = 1), true);
$$;

revoke all on function invoices.drive_record(jsonb), invoices.drive_finish(jsonb), invoices.drive_stale(jsonb), invoices.drive_has_work() from public, anon, authenticated;
