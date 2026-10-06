-- Ikisai Invoices · modelo completo (docs/invoices/API.md §2, §4.2). Toca solo el schema invoices.
-- Lee core.files (FK de documentos), core.memberships (rol en triggers) y usa los helpers permitidos de core.
-- Las escrituras derivadas (recalculo, estados automáticos, renombrado de archivos) no se hacen en triggers:
-- las aplica el hook invoices.check_invariants (migración 0201) con core.apply_row_op para que queden en core.changes.

-- ---------------------------------------------------------------------------
-- Listas cerradas y utilidades puras (misma regla que supabase/functions/_domain/invoices)
-- ---------------------------------------------------------------------------
create or replace function invoices.expense_category_values()
returns text[] language sql immutable as $$
  select array['compras','suministros','mantenimiento','inversiones','canon_concesion','seguros','personal','fiscalidad','otros'];
$$;

-- slug: minúsculas · sin acentos (tabla fija) · [^a-z0-9]+ → _ · sin _ en los extremos · ≤ 40 caracteres.
create or replace function invoices.slugify(p_text text, p_max int default 40)
returns text language plpgsql immutable as $$
declare v text;
begin
  v := lower(coalesce(p_text, ''));
  v := replace(v, 'ß', 'ss'); v := replace(v, 'æ', 'ae'); v := replace(v, 'œ', 'oe');
  v := translate(v, 'áàäâãåéèëêíìïîóòöôõøúùüûñçýÿ', 'aaaaaaeeeeiiiioooooouuuuncyy');
  v := regexp_replace(v, '[^a-z0-9]+', '_', 'g');
  v := regexp_replace(v, '^_+|_+$', '', 'g');
  if length(v) > p_max then v := regexp_replace(left(v, p_max), '_+$', ''); end if;
  return v;
end $$;

create or replace function invoices.extension_for(p_mime text)
returns text language sql immutable as $$
  select case p_mime when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' else 'bin' end;
$$;

-- Base del nombre canónico: 2026_10_05_(makro)_alimentos_retiro_yoga
create or replace function invoices.normalized_base(p_date date, p_supplier_slug text, p_object text)
returns text language sql immutable as $$
  select to_char(p_date, 'YYYY_MM_DD') || '_(' || coalesce(nullif(invoices.slugify(p_supplier_slug), ''), 'sin_proveedor') || ')_' || coalesce(nullif(invoices.slugify(p_object), ''), 'sin_objeto');
$$;

-- ---------------------------------------------------------------------------
-- Proveedores: alias, slug y sugerencia de inversión
-- ---------------------------------------------------------------------------
alter table invoices.suppliers
  add column aliases text[] not null default '{}',
  add column slug text,
  add column default_is_investment boolean not null default false;
update invoices.suppliers set slug = coalesce(nullif(invoices.slugify(name), ''), 'proveedor') where slug is null;
alter table invoices.suppliers alter column slug set not null;
alter table invoices.suppliers add constraint suppliers_slug_check check (slug ~ '^[a-z0-9_]{1,40}$');
alter table invoices.suppliers add constraint suppliers_aliases_check check (cardinality(aliases) <= 20);
create index suppliers_slug_idx on invoices.suppliers (slug) where deleted_at is null;
create unique index suppliers_tax_id_uq on invoices.suppliers (upper(tax_id)) where deleted_at is null and tax_id is not null;

-- El slug se deriva del nombre si el cliente no lo manda.
create or replace function invoices.supplier_defaults()
returns trigger language plpgsql as $$
begin
  if new.slug is null or new.slug = '' then new.slug := coalesce(nullif(invoices.slugify(new.name), ''), 'proveedor'); end if;
  return new;
end $$;
create trigger invoices_supplier_defaults before insert or update on invoices.suppliers for each row execute function invoices.supplier_defaults();

select core.register_table('invoices', 'invoices', 'suppliers', array['name','tax_id','default_category','default_is_investment','aliases','slug','notes']);

-- ---------------------------------------------------------------------------
-- Facturas
-- ---------------------------------------------------------------------------
create table invoices.invoices (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  supplier_id uuid not null references invoices.suppliers(id),
  invoice_date date not null,
  object text not null check (length(btrim(object)) between 1 and 120),
  invoice_number text check (invoice_number is null or length(invoice_number) <= 64),
  currency char(3) not null default 'EUR' check (currency = 'EUR'),
  due_date date,
  expense_category text check (expense_category is null or expense_category = any (invoices.expense_category_values())),
  is_investment boolean not null default false,
  deductibility text not null default 'pendiente_revision' check (deductibility in ('si','no','parcial','pendiente_revision')),
  status text not null default 'pendiente_datos' check (status in ('pendiente_datos','pendiente_revision','validada','archivada','anulada')),
  review_reason text check (review_reason is null or length(review_reason) <= 200),
  annulled_reason text check (annulled_reason is null or length(annulled_reason) <= 500),
  payment_status text not null default 'pendiente' check (payment_status in ('pendiente','pagada')),
  payment_method text check (payment_method is null or payment_method in ('transferencia','tarjeta','efectivo','bizum','domiciliacion','otro')),
  paid_at date,
  source_total numeric(12,2),
  calculated_base numeric(12,2) not null default 0,
  calculated_vat numeric(12,2) not null default 0,
  calculated_other numeric(12,2) not null default 0,
  calculated_withholding numeric(12,2) not null default 0,
  calculated_total numeric(12,2) not null default 0,
  totals_delta numeric(12,2),
  source text not null default 'manual' check (source in ('manual','import_v1')),
  import_sha256 text check (import_sha256 is null or import_sha256 ~ '^[0-9a-f]{64}$'),
  import_meta jsonb,
  fiscal_year int generated always as (extract(year from invoice_date)::int) stored,
  fiscal_quarter int generated always as (extract(quarter from invoice_date)::int) stored,
  fiscal_period text generated always as (extract(year from invoice_date)::int::text || 'T' || extract(quarter from invoice_date)::int::text) stored,
  notes text,
  constraint invoices_annulled_requires_reason check (status <> 'anulada' or annulled_reason is not null),
  constraint invoices_paid_requires_date check (payment_status <> 'pagada' or paid_at is not null)
);
create unique index invoices_supplier_number_uq on invoices.invoices (supplier_id, lower(invoice_number)) where deleted_at is null and status <> 'anulada' and invoice_number is not null;
create index invoices_date_idx on invoices.invoices (invoice_date desc);
create index invoices_period_idx on invoices.invoices (fiscal_year, fiscal_quarter);
create index invoices_status_idx on invoices.invoices (status);
create index invoices_import_sha_idx on invoices.invoices (import_sha256) where import_sha256 is not null;

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
create table invoices.invoice_files (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  invoice_id uuid not null references invoices.invoices(id),
  file_id uuid not null references core.files(id),
  original_filename text not null check (length(original_filename) between 1 and 255),
  normalized_filename text not null,
  mime_type text not null check (mime_type in ('application/pdf','image/webp','image/jpeg','image/png')),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_order int not null default 1 check (page_order >= 1),
  kind text not null default 'original' check (kind in ('original','attachment')),
  unique (invoice_id, file_id)
);
create unique index invoice_files_name_uq on invoices.invoice_files (normalized_filename) where deleted_at is null;
create index invoice_files_invoice_idx on invoices.invoice_files (invoice_id);
create index invoice_files_sha_idx on invoices.invoice_files (sha256) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Líneas e impuestos
-- ---------------------------------------------------------------------------
create table invoices.invoice_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  invoice_id uuid not null references invoices.invoices(id),
  position int not null check (position >= 0),
  description text not null check (length(btrim(description)) between 1 and 500),
  quantity numeric(12,3),
  unit text check (unit is null or length(unit) <= 16),
  unit_price numeric(12,4),
  discount_amount numeric(12,2) not null default 0,
  net_amount numeric(12,2) not null,
  vat_rate numeric(5,2) check (vat_rate is null or vat_rate between 0 and 100),
  vat_amount numeric(12,2),
  gross_amount numeric(12,2),
  item_type text check (item_type is null or item_type in ('food_ingredient','equipment','material','service','other')),
  match_name text check (match_name is null or length(match_name) <= 200),
  expense_category text check (expense_category is null or expense_category = any (invoices.expense_category_values())),
  is_investment boolean,
  confidence numeric(3,2) check (confidence is null or confidence between 0 and 1),
  notes text
);
create index invoice_lines_invoice_idx on invoices.invoice_lines (invoice_id, position);

create table invoices.tax_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  invoice_id uuid not null references invoices.invoices(id),
  position int not null check (position >= 0),
  tax_type text not null check (tax_type in ('iva','irpf','otra_retencion','otro')),
  rate numeric(5,2) check (rate is null or rate between 0 and 100),
  taxable_base numeric(12,2),
  amount numeric(12,2) not null check (amount >= 0),
  notes text
);
create index tax_lines_invoice_idx on invoices.tax_lines (invoice_id, position);

-- ---------------------------------------------------------------------------
-- Asignaciones (por línea)
-- ---------------------------------------------------------------------------
create table invoices.allocations (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  invoice_line_id uuid not null references invoices.invoice_lines(id),
  invoice_id uuid not null references invoices.invoices(id),
  target_app text not null check (target_app in ('tasks','booking','food','general')),
  target_kind text not null,
  target_id text check (target_id is null or length(target_id) <= 120),
  target_code text check (target_code is null or length(target_code) <= 64),
  target_label text not null check (length(btrim(target_label)) between 1 and 300),
  target_revision bigint,
  allocated_quantity numeric(12,3) check (allocated_quantity is null or allocated_quantity > 0),
  allocated_amount numeric(12,2) not null check (allocated_amount > 0),
  notes text,
  constraint allocations_target_check check (
    (target_app = 'general' and target_kind in ('unassigned','operating_expense','investment') and target_id is null)
    or (target_app = 'tasks' and target_kind in ('area','project','task') and target_id is not null)
    or (target_app = 'booking' and target_kind in ('reservation','event') and target_id is not null)
    or (target_app = 'food' and target_kind in ('ingredient','equipment') and target_id is not null))
);
create index allocations_line_idx on invoices.allocations (invoice_line_id);
create index allocations_invoice_idx on invoices.allocations (invoice_id);
create index allocations_target_idx on invoices.allocations (target_app, target_kind, target_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- Entregas a gestoría
-- ---------------------------------------------------------------------------
create table invoices.exports (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text unique,
  period_kind text not null check (period_kind in ('quarter','year','custom')),
  fiscal_year int not null,
  fiscal_quarter int check (fiscal_quarter is null or fiscal_quarter between 1 and 4),
  from_date date not null,
  to_date date not null,
  folder_name text not null,
  invoice_count int not null,
  totals jsonb not null,
  manifest jsonb not null,
  manifest_sha256 text not null,
  status text not null default 'generada' check (status in ('generada','entregada')),
  delivered_at timestamptz,
  delivered_to text check (delivered_to is null or length(delivered_to) <= 300),
  zip_file_id uuid references core.files(id),
  notes text,
  constraint exports_range_check check (from_date <= to_date)
);
create index exports_period_idx on invoices.exports (fiscal_year, fiscal_quarter);

create table invoices.export_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  export_id uuid not null references invoices.exports(id),
  invoice_id uuid not null references invoices.invoices(id),
  invoice_code text not null,
  invoice_revision bigint not null,
  files jsonb not null default '[]'::jsonb,
  unique (export_id, invoice_id)
);
create index export_items_invoice_idx on invoices.export_items (invoice_id);

-- ---------------------------------------------------------------------------
-- Nombre canónico (lectura; la escritura la hace el trigger de inserción y el hook de invariantes)
-- ---------------------------------------------------------------------------
-- Índice de colisión de una factura: posición (1..n) entre las facturas con misma fecha, proveedor y objeto, por antigüedad.
create or replace function invoices.collision_index(p_invoice_id uuid)
returns int language sql stable as $$
  -- Agrupa por fecha, slug del proveedor y slug del objeto: dos proveedores con el mismo slug también colisionan en el nombre.
  with me as (select i.id, i.invoice_date, s.slug, invoices.slugify(i.object) obj, i.created_at from invoices.invoices i join invoices.suppliers s on s.id = i.supplier_id where i.id = p_invoice_id)
  select 1 + count(*)::int from invoices.invoices o join invoices.suppliers os on os.id = o.supplier_id, me
  where o.id <> me.id and o.deleted_at is null and o.invoice_date = me.invoice_date and os.slug = me.slug
    and invoices.slugify(o.object) = me.obj and (o.created_at, o.id) < (me.created_at, me.id);
$$;

-- Nombre que debería tener un archivo dado su estado actual (y, para un archivo aún no insertado, sus datos).
create or replace function invoices.expected_filename(p_invoice_id uuid, p_file_id uuid, p_kind text, p_page_order int, p_mime text)
returns text language plpgsql stable as $$
declare v_inv invoices.invoices; v_slug text; v_base text; v_collision int; v_count int; v_rank int; v_suffix text := '';
begin
  select * into v_inv from invoices.invoices where id = p_invoice_id;
  if v_inv.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.invoices', 'id', p_invoice_id)); end if;
  select slug into v_slug from invoices.suppliers where id = v_inv.supplier_id;
  v_base := invoices.normalized_base(v_inv.invoice_date, v_slug, v_inv.object);
  v_collision := invoices.collision_index(p_invoice_id);
  if v_collision > 1 then v_suffix := '_' || lpad(v_collision::text, 2, '0'); end if;
  if p_kind = 'original' then
    select count(*) into v_count from invoices.invoice_files f where f.invoice_id = p_invoice_id and f.deleted_at is null and f.kind = 'original' and (p_file_id is null or f.id <> p_file_id);
    v_count := v_count + 1; -- este archivo
    if v_count > 1 then v_suffix := v_suffix || '_p' || lpad(p_page_order::text, 2, '0'); end if;
  else
    select count(*) into v_rank from invoices.invoice_files f where f.invoice_id = p_invoice_id and f.deleted_at is null and f.kind = 'attachment'
      and (p_file_id is null or f.id <> p_file_id) and (f.page_order, f.id) < (p_page_order, coalesce(p_file_id, '00000000-0000-0000-0000-000000000000'::uuid));
    v_suffix := v_suffix || '_a' || lpad((v_rank + 1)::text, 2, '0');
  end if;
  return v_base || v_suffix || '.' || invoices.extension_for(p_mime);
end $$;

-- ---------------------------------------------------------------------------
-- Triggers de asignación en inserción y de bloqueo
-- ---------------------------------------------------------------------------
create or replace function invoices.assign_invoice_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then new.code := core.next_code('FVR', extract(year from new.invoice_date)::int); end if;
  return new;
end $$;
create trigger invoices_assign_code before insert on invoices.invoices for each row execute function invoices.assign_invoice_code();

create or replace function invoices.assign_export_code()
returns trigger language plpgsql as $$
begin
  if new.code is null then new.code := core.next_code('GST', new.fiscal_year); end if;
  return new;
end $$;
create trigger invoices_assign_export_code before insert on invoices.exports for each row execute function invoices.assign_export_code();

-- Fila sin columnas de auditoría ni generadas, para comparar OLD y NEW en triggers.
create or replace function invoices.comparable(p_row jsonb)
returns jsonb language sql immutable as $$
  select p_row - 'revision' - 'updated_at' - 'updated_by' - 'fiscal_year' - 'fiscal_quarter' - 'fiscal_period';
$$;

create or replace function invoices.actor_role()
returns text language sql stable as $$
  select coalesce(nullif(current_setting('core' || '.role', true), ''),
    (select m.role from core.memberships m where m.app = 'invoices' and m.user_id = nullif(current_setting('core' || '.actor', true), '')::uuid));
$$;

-- Facturas: nunca se borran; anulada solo notas; archivada solo pago y notas; archivar/desarchivar solo owner;
-- validada y anulada solo se alcanzan por procedimiento (marcado con invoices.procedure); fuera de pendiente_* no se rebaja a pendiente_datos.
create or replace function invoices.guard_invoice()
returns trigger language plpgsql as $$
declare v_proc text := coalesce(current_setting('invoices.procedure', true), ''); v_role text; v_changed text[];
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform core.fail('INVOICE_NOT_DELETABLE', 422, jsonb_build_object('id', new.id));
  end if;
  -- Las columnas generadas (fiscal_*) son null en NEW dentro de un trigger before: se excluyen de la comparación.
  if old.status = 'anulada' then
    select array_agg(n.key) into v_changed from jsonb_each(invoices.comparable(to_jsonb(new)) - 'notes') n join jsonb_each(to_jsonb(old)) o on o.key = n.key where n.value is distinct from o.value;
    if v_changed is not null then perform core.fail('INVOICE_ANNULLED', 409, jsonb_build_object('id', new.id, 'fields', to_jsonb(v_changed))); end if;
  end if;
  if old.status = 'archivada' and new.status = 'archivada' then
    select array_agg(n.key) into v_changed
      from jsonb_each(invoices.comparable(to_jsonb(new)) - 'payment_status' - 'payment_method' - 'paid_at' - 'notes') n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key where n.value is distinct from o.value;
    if v_changed is not null then perform core.fail('INVOICE_ARCHIVED', 409, jsonb_build_object('id', new.id, 'fields', to_jsonb(v_changed))); end if;
  end if;
  if new.status <> old.status then
    if new.status in ('validada', 'anulada') and v_proc not in ('validate', 'annul') and not (old.status = 'archivada' and new.status = 'validada') then
      perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status, 'reason', 'use the procedure'));
    end if;
    if (new.status = 'archivada' or old.status = 'archivada') and v_proc <> 'archive_period' then
      v_role := invoices.actor_role();
      if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners archive invoices')); end if;
      if (old.status, new.status) not in (('validada', 'archivada'), ('archivada', 'validada')) then
        perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status));
      end if;
    end if;
    if old.status = 'anulada' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status)); end if;
    if old.status = 'validada' and new.status = 'pendiente_datos' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status)); end if;
  end if;
  return new;
end $$;
create trigger invoices_guard_invoice before update on invoices.invoices for each row execute function invoices.guard_invoice();

-- Hijas (líneas, impuestos, documentos): factura padre viva; anulada o archivada no admiten cambios (salvo adjuntos);
-- borrado lógico solo con factura pendiente_*; invoice_id inmutable.
create or replace function invoices.guard_child()
returns trigger language plpgsql as $$
declare v_inv invoices.invoices; v_kind text := null;
begin
  if tg_op = 'UPDATE' and new.invoice_id <> old.invoice_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'invoice_id')); end if;
  select * into v_inv from invoices.invoices where id = new.invoice_id;
  if v_inv.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.invoices', 'id', new.invoice_id)); end if;
  if tg_table_name = 'invoice_files' then v_kind := (to_jsonb(new)->>'kind'); end if;
  if v_inv.status in ('anulada', 'archivada') and not (tg_table_name = 'invoice_files' and v_kind = 'attachment') then
    perform core.fail('INVOICE_LOCKED', 409, jsonb_build_object('invoice_id', v_inv.id, 'status', v_inv.status));
  end if;
  if tg_op = 'UPDATE' and new.deleted_at is not null and old.deleted_at is null and v_inv.status not in ('pendiente_datos', 'pendiente_revision') then
    if tg_table_name = 'invoice_files' and v_kind <> 'attachment' then perform core.fail('INVOICE_FILE_LOCKED', 422, jsonb_build_object('invoice_id', v_inv.id)); end if;
    if tg_table_name = 'invoice_lines' then perform core.fail('INVOICE_LINE_LOCKED', 422, jsonb_build_object('invoice_id', v_inv.id)); end if;
    if tg_table_name = 'tax_lines' then perform core.fail('INVOICE_LINE_LOCKED', 422, jsonb_build_object('invoice_id', v_inv.id, 'table', 'tax_lines')); end if;
  end if;
  return new;
end $$;
create trigger invoices_guard_line before insert or update on invoices.invoice_lines for each row execute function invoices.guard_child();
create trigger invoices_guard_tax_line before insert or update on invoices.tax_lines for each row execute function invoices.guard_child();
create trigger invoices_guard_file before insert or update on invoices.invoice_files for each row execute function invoices.guard_child();

-- Documentos: nombre canónico en la inserción; después solo lo cambia el hook (invoices.renaming).
create or replace function invoices.name_file()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.normalized_filename := invoices.expected_filename(new.invoice_id, null, new.kind, new.page_order, new.mime_type);
  elsif new.normalized_filename <> old.normalized_filename and coalesce(current_setting('invoices.renaming', true), '') = '' then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'normalized_filename'));
  end if;
  if tg_op = 'UPDATE' and (new.file_id <> old.file_id or new.sha256 <> old.sha256 or new.size_bytes <> old.size_bytes or new.mime_type <> old.mime_type) then
    perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'file_id'));
  end if;
  return new;
end $$;
create trigger invoices_name_file before insert or update on invoices.invoice_files for each row execute function invoices.name_file();

-- Asignaciones: invoice_id desde la línea; línea inmutable; factura no anulada; línea viva.
create or replace function invoices.fill_allocation()
returns trigger language plpgsql as $$
declare v_line invoices.invoice_lines; v_status text;
begin
  if tg_op = 'UPDATE' and new.invoice_line_id <> old.invoice_line_id then perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('field', 'invoice_line_id')); end if;
  select * into v_line from invoices.invoice_lines where id = new.invoice_line_id;
  if v_line.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.invoice_lines', 'id', new.invoice_line_id)); end if;
  if v_line.deleted_at is not null and new.deleted_at is null then perform core.fail('PARENT_DELETED', 422, jsonb_build_object('parent', 'invoice_lines', 'id', v_line.id)); end if;
  new.invoice_id := v_line.invoice_id;
  select status into v_status from invoices.invoices where id = v_line.invoice_id;
  if v_status = 'anulada' and new.deleted_at is null then perform core.fail('INVOICE_ANNULLED', 409, jsonb_build_object('invoice_id', v_line.invoice_id)); end if;
  return new;
end $$;
create trigger invoices_fill_allocation before insert or update on invoices.allocations for each row execute function invoices.fill_allocation();

-- Entregas: no se borran; periodo, manifest, totales y recuento inmutables; entregada solo hacia delante.
create or replace function invoices.guard_export()
returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then perform core.fail('EXPORT_NOT_DELETABLE', 422, jsonb_build_object('id', new.id)); end if;
  if new.period_kind <> old.period_kind or new.fiscal_year <> old.fiscal_year or new.fiscal_quarter is distinct from old.fiscal_quarter or new.from_date <> old.from_date
     or new.to_date <> old.to_date or new.folder_name <> old.folder_name or new.invoice_count <> old.invoice_count or new.totals <> old.totals or new.manifest <> old.manifest
     or new.manifest_sha256 <> old.manifest_sha256 or new.code <> old.code then
    perform core.fail('EXPORT_IMMUTABLE', 409, jsonb_build_object('id', new.id));
  end if;
  if old.status = 'entregada' and new.status <> 'entregada' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status)); end if;
  if new.status = 'entregada' and new.delivered_at is null then new.delivered_at := now(); end if;
  return new;
end $$;
create trigger invoices_guard_export before update on invoices.exports for each row execute function invoices.guard_export();

create or replace function invoices.guard_export_item()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'revision' - 'updated_at' - 'updated_by') <> (to_jsonb(old) - 'revision' - 'updated_at' - 'updated_by') then
    perform core.fail('EXPORT_IMMUTABLE', 409, jsonb_build_object('id', new.id));
  end if;
  return new;
end $$;
create trigger invoices_guard_export_item before update on invoices.export_items for each row execute function invoices.guard_export_item();

-- ---------------------------------------------------------------------------
-- Registro de tablas (never_purge en todo lo documental)
-- ---------------------------------------------------------------------------
select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'invoice_files', array['invoice_id','file_id','original_filename','normalized_filename','page_order','kind','mime_type','size_bytes','sha256'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'invoice_lines', array[
  'invoice_id','position','description','quantity','unit','unit_price','discount_amount','net_amount','vat_rate','vat_amount','gross_amount',
  'item_type','match_name','expense_category','is_investment','confidence','notes'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'tax_lines', array['invoice_id','position','tax_type','rate','taxable_base','amount','notes'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'allocations', array['invoice_line_id','target_app','target_kind','target_id','target_code','target_label','target_revision','allocated_quantity','allocated_amount','notes']);
-- exports y export_items: el cliente solo puede tocar status/delivered_*/notes (lo impone la Edge); el resto lo escribe create_export vía apply_row_op.
select core.register_table('invoices', 'invoices', 'exports', array['period_kind','fiscal_year','fiscal_quarter','from_date','to_date','folder_name','invoice_count','totals','manifest','manifest_sha256','status','delivered_at','delivered_to','zip_file_id','notes'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'export_items', array['export_id','invoice_id','invoice_code','invoice_revision','files'], '{reader,editor,owner}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Proyecciones para otras apps (fase 2): coste por reserva/evento y entradas de stock. Sin notas ni datos personales.
-- ---------------------------------------------------------------------------
create view invoices.booking_cost_projection as
  select a.id as allocation_id, a.target_kind, a.target_id, i.code as invoice_code, i.invoice_date, s.name as supplier_name,
         coalesce(l.expense_category, i.expense_category) as expense_category, coalesce(l.is_investment, i.is_investment) as is_investment,
         a.allocated_amount, a.revision as allocation_revision
  from invoices.allocations a
  join invoices.invoice_lines l on l.id = a.invoice_line_id
  join invoices.invoices i on i.id = a.invoice_id
  join invoices.suppliers s on s.id = i.supplier_id
  where a.deleted_at is null and l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'booking';

create view invoices.food_stock_projection as
  select a.id as allocation_id, a.target_kind, a.target_id, i.code as invoice_code, i.invoice_date, s.name as supplier_name,
         l.description as line_description, l.match_name, a.allocated_quantity, l.unit, a.allocated_amount, a.revision as allocation_revision
  from invoices.allocations a
  join invoices.invoice_lines l on l.id = a.invoice_line_id
  join invoices.invoices i on i.id = a.invoice_id
  join invoices.suppliers s on s.id = i.supplier_id
  where a.deleted_at is null and l.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'food';

revoke all on invoices.booking_cost_projection, invoices.food_stock_projection from public, anon, authenticated;
grant select on invoices.booking_cost_projection, invoices.food_stock_projection to service_role;
select core.allow_read('booking', 'invoices.booking_cost_projection', 'view');
select core.allow_read('food', 'invoices.food_stock_projection', 'view');

-- ---------------------------------------------------------------------------
-- Permisos: ninguna función del schema es ejecutable por anon/authenticated.
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  for f in select 'invoices.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'invoices' loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
