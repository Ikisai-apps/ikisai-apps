-- Invoices · registro de extracciones automáticas (decisión del usuario, ronda 15). Toca solo el schema invoices.
--
-- Cada extracción pedida a `imports/extract` deja una fila por documento: quién la pidió (updated_by), con qué modelo y
-- cuánto costó. Sirve para dos cosas: el límite de los agentes (una extracción por documento de una factura pendiente
-- sin aprobación; repetirla exige propuesta aprobada) y saber lo que se gasta. Las filas las escribe la Edge; un agente
-- solo puede proponer la inserción de una fila `pendiente` como petición de repetir, que aprueba un owner humano.
-- La app no la copia al móvil (no está en su lista de tablas).

create table invoices.extractions (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  file_id uuid not null references core.files(id),
  invoice_id uuid references invoices.invoices(id),
  outcome text not null default 'pendiente' check (outcome in ('pendiente', 'ok', 'invalida')),
  model text,
  input_tokens int check (input_tokens >= 0),
  output_tokens int check (output_tokens >= 0),
  latency_ms int check (latency_ms >= 0)
);
create index extractions_file_idx on invoices.extractions (file_id) where deleted_at is null;

select core.register_table('invoices', 'invoices', 'extractions',
  array['file_id', 'invoice_id', 'outcome', 'model', 'input_tokens', 'output_tokens', 'latency_ms'], '{editor,owner}', '{editor,owner}');

-- Para la Edge: por cada documento pedido, cuántas extracciones hechas tiene y de qué factura es (si ya está adjunto).
create or replace function invoices.extraction_status(p jsonb)
returns jsonb language sql stable as $$
  with refs as (
    select distinct x::uuid as file_id
    from jsonb_array_elements_text(coalesce(p->'args'->'file_ids', '[]'::jsonb)) x
    where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
      'file_id', r.file_id,
      'done', (select count(*) from invoices.extractions e where e.file_id = r.file_id and e.deleted_at is null and e.outcome <> 'pendiente'),
      'invoice_id', inv.id, 'code', inv.code, 'status', inv.status)), '[]'::jsonb))
  from refs r
  left join lateral (
    select i.id, i.code, i.status from invoices.invoice_files f join invoices.invoices i on i.id = f.invoice_id
    where f.file_id = r.file_id and f.deleted_at is null and i.deleted_at is null order by f.created_at desc limit 1
  ) inv on true;
$$;
revoke all on function invoices.extraction_status(jsonb) from public, anon, authenticated;
select core.allow_read('invoices', 'invoices.extraction_status', 'function', '{editor,owner}');
