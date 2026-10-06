-- Invoices · fase 3 de la extracción sin API de pago: plantillas por proveedor aprendidas de confirmaciones y texto de
-- los documentos (API.md §6.9, aprobado por Core en la ronda 33). Toca solo el schema invoices.

-- ---------------------------------------------------------------------------
-- Plantillas por proveedor (sincronizadas: «Leer PDF» funciona en el dispositivo y sin red)
-- ---------------------------------------------------------------------------
create table invoices.supplier_templates (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  supplier_id uuid not null references invoices.suppliers(id),
  version int not null check (version >= 1),
  status text not null default 'aprendiendo' check (status in ('aprendiendo', 'activa', 'retirada')),
  layout_tokens text[] not null default '{}',
  layout_hash text not null check (layout_hash ~ '^[0-9a-f]{64}$'),
  page_size jsonb,
  fields jsonb not null default '{}'::jsonb check (jsonb_typeof(fields) = 'object'),
  confirmations int not null default 0 check (confirmations >= 0),
  uses int not null default 0 check (uses >= 0),
  full_hits int not null default 0 check (full_hits >= 0),
  last_confirmed_invoice_id uuid references invoices.invoices(id)
);
create unique index supplier_templates_version_uq on invoices.supplier_templates (supplier_id, version);
create index supplier_templates_supplier_idx on invoices.supplier_templates (supplier_id) where deleted_at is null;

select core.register_table('invoices', 'invoices', 'supplier_templates',
  array['supplier_id', 'version', 'status', 'layout_tokens', 'layout_hash', 'page_size', 'fields', 'confirmations', 'uses', 'full_hits', 'last_confirmed_invoice_id'],
  '{reader,editor,owner}', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Texto de los documentos: una fila por documento, solo la escribe la Edge (ruta documents/:fileId/text), no se
-- copia al dispositivo y desaparece con su documento. Es texto de facturas: no se copia a ningún otro sitio.
-- ---------------------------------------------------------------------------
create table invoices.document_texts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  file_id uuid not null references core.files(id) on delete cascade,
  source text not null check (source in ('pdf_text', 'ocr')),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  char_count int not null default 0 check (char_count >= 0),
  sha256 text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$')
);
create unique index document_texts_file_uq on invoices.document_texts (file_id) where deleted_at is null;

select core.register_table('invoices', 'invoices', 'document_texts', array['file_id', 'source', 'items', 'char_count', 'sha256'], '{editor,owner}', '{editor,owner}');

-- Lectura bajo demanda del texto de un documento.
create or replace function invoices.document_text(p jsonb)
returns jsonb language sql stable as $$
  select coalesce((select jsonb_build_object('file_id', d.file_id, 'source', d.source, 'items', d.items, 'char_count', d.char_count, 'sha256', d.sha256, 'revision', d.revision, 'id', d.id)
    from invoices.document_texts d where d.deleted_at is null and d.file_id::text = p->'args'->>'file_id' limit 1), 'null'::jsonb);
$$;
select core.allow_read('invoices', 'invoices.document_text', 'function', '{editor,owner}');

-- ---------------------------------------------------------------------------
-- Hook: aprender solo de lo confirmado y limpiar el texto de los documentos borrados
-- ---------------------------------------------------------------------------
create or replace function invoices.check_templates(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p);
  ch record; v_supplier uuid; v_retire boolean; d record;
begin
  for ch in select * from core.changes c where c.app = v_app and c.cursor = v_cursor and c.schema_name = 'invoices' and c.table_name = 'supplier_templates' and c.op <> 'call' loop
    v_supplier := coalesce(ch.after->>'supplier_id', ch.before->>'supplier_id')::uuid;
    -- Retirar una plantilla (solo el owner) no necesita confirmación: cambia el estado y nada más.
    v_retire := ch.op = 'update' and ch.after->>'status' = 'retirada' and ch.before->>'status' <> 'retirada'
      and (ch.after - array['status', 'revision', 'updated_at', 'updated_by']) = (ch.before - array['status', 'revision', 'updated_at', 'updated_by']);
    if v_retire then
      if v_ctx->>'role' is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners retire a template')); end if;
      continue;
    end if;
    -- Cualquier otra escritura: en el mismo lote, una factura de ese proveedor pasa a validada.
    if not exists (select 1 from core.changes c where c.app = v_app and c.cursor = v_cursor and c.schema_name = 'invoices' and c.table_name = 'invoices' and c.op = 'update'
                   and c.after->>'status' = 'validada' and c.before->>'status' is distinct from 'validada' and (c.after->>'supplier_id')::uuid = v_supplier) then
      perform core.fail('TEMPLATE_REQUIRES_CONFIRMATION', 422, jsonb_build_object('supplier_id', v_supplier, 'template_id', ch.row_id));
    end if;
  end loop;
  -- Documento borrado → su texto también.
  for d in select t.* from core.changes c join invoices.document_texts t on t.file_id = (coalesce(c.after, c.before)->>'file_id')::uuid and t.deleted_at is null
           where c.app = v_app and c.cursor = v_cursor and c.schema_name = 'invoices' and c.table_name = 'invoice_files' and c.op = 'delete'
             and not exists (select 1 from invoices.invoice_files f where f.file_id = t.file_id and f.deleted_at is null) loop
    perform invoices.row_op(v_ctx, jsonb_build_object('op', 'delete', 'table', 'invoices.document_texts', 'id', d.id, 'expectedRevision', d.revision));
  end loop;
end $$;
select core.add_validate_hook('invoices', 'invoices.check_templates');

revoke all on function invoices.document_text(jsonb), invoices.check_templates(jsonb) from public, anon, authenticated;
