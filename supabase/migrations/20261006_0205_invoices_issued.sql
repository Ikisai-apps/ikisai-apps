-- Invoices · facturas emitidas registradas (API.md §13, ronda 21 y revisión de Core en la ronda 22). Toca solo el schema invoices.
--
-- Libro registro de facturas expedidas: se registran las emitidas con otra herramienta (`origin` manual o importada). El
-- modelo deja preparado lo común para emitir desde la app cumpliendo Verifactu (`origin = 'app'` y columnas `vf_*`
-- reservadas y vacías; nadie las escribe todavía). Sin papelera: una emitida y sus filas no se borran, se anulan; el
-- número es único entre todas las filas, así que ni anulada ni borrada libera su número.

-- ---------------------------------------------------------------------------
-- Series
-- ---------------------------------------------------------------------------
create table invoices.issued_series (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  code text not null check (length(btrim(code)) between 1 and 20),
  description text,
  kind text not null default 'ordinaria' check (kind in ('ordinaria', 'rectificativa', 'simplificada')),
  yearly boolean not null default true,
  format text not null default '{serie}-{año}-{n:4}',
  active boolean not null default true
);
create unique index issued_series_code_uq on invoices.issued_series (upper(btrim(code)));

-- ---------------------------------------------------------------------------
-- Cabecera
-- ---------------------------------------------------------------------------
create table invoices.issued_invoices (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  series_code text not null check (length(btrim(series_code)) between 1 and 20),
  number text not null check (length(btrim(number)) between 1 and 40),
  full_number text generated always as (
    case when upper(btrim(number)) like upper(btrim(series_code)) || '%' then btrim(number) else btrim(series_code) || '-' || btrim(number) end) stored,
  issue_date date not null,
  operation_date date,
  fiscal_year int generated always as (extract(year from issue_date)::int) stored,
  fiscal_quarter int generated always as (extract(quarter from issue_date)::int) stored,
  invoice_type text not null default 'F1' check (invoice_type in ('F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5')),
  rectification_kind text check (rectification_kind in ('S', 'I')),
  rectified jsonb not null default '[]'::jsonb check (jsonb_typeof(rectified) = 'array'),
  rectification_reason text,
  rectified_base numeric(14,2),
  rectified_quota numeric(14,2),
  recipient_name text,
  recipient_tax_id text,
  recipient_id_type text check (recipient_id_type in ('NIF', '02', '03', '04', '05', '06')),
  recipient_country char(2),
  extra_recipients jsonb not null default '[]'::jsonb check (jsonb_typeof(extra_recipients) = 'array'),
  description text not null check (length(btrim(description)) between 1 and 500),
  notes text,
  currency text not null default 'EUR',
  base_total numeric(14,2) not null default 0,
  quota_total numeric(14,2) not null default 0,
  surcharge_total numeric(14,2) not null default 0,
  withholding_total numeric(14,2) not null default 0,
  total numeric(14,2) not null default 0,
  source_total numeric(14,2),
  totals_delta numeric(14,2),
  status text not null default 'registrada' check (status in ('registrada', 'anulada')),
  review_reason text,
  annulled_reason text,
  origin text not null default 'manual' check (origin in ('manual', 'importada', 'app')),
  external_tool text,
  external_id text,
  import_sha256 text check (import_sha256 is null or import_sha256 ~ '^[0-9a-f]{64}$'),
  income_category text check (income_category in ('alojamiento', 'restauracion', 'actividades', 'eventos', 'otros')),
  payment_status text not null default 'pendiente' check (payment_status in ('pendiente', 'cobrada')),
  paid_at date,
  external_qr_url text,
  external_csv text,
  -- Verifactu (reservado para la emisión desde la app; vacío en las registradas)
  vf_record_kind text check (vf_record_kind in ('alta', 'anulacion')),
  vf_hash text,
  vf_previous_hash text,
  vf_previous_ref jsonb,
  vf_first_record boolean,
  vf_generated_at timestamptz,
  vf_status text check (vf_status in ('pendiente', 'enviado', 'aceptado', 'aceptado_con_errores', 'rechazado')),
  vf_csv text,
  vf_errors jsonb,
  vf_qr_url text,
  vf_system jsonb,
  constraint issued_rectification_ck check (
    invoice_type not like 'R%' or (rectification_kind is not null and jsonb_array_length(rectified) > 0 and nullif(btrim(coalesce(rectification_reason, '')), '') is not null)),
  constraint issued_recipient_ck check (
    invoice_type in ('F2', 'R5') or (nullif(btrim(coalesce(recipient_name, '')), '') is not null and nullif(btrim(coalesce(recipient_tax_id, '')), '') is not null)),
  constraint issued_annul_ck check (status <> 'anulada' or nullif(btrim(coalesce(annulled_reason, '')), '') is not null)
);
-- Número único entre todas las filas (revisión de Core): ni anular ni nada libera un número.
create unique index issued_invoices_number_uq on invoices.issued_invoices (upper(btrim(series_code)), upper(btrim(number)));
create unique index issued_invoices_external_uq on invoices.issued_invoices (external_tool, external_id) where external_tool is not null and external_id is not null;
create index issued_invoices_period_idx on invoices.issued_invoices (fiscal_year, fiscal_quarter);

-- ---------------------------------------------------------------------------
-- Líneas, desglose, documentos y destino del ingreso
-- ---------------------------------------------------------------------------
create table invoices.issued_invoice_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  position int not null default 0 check (position >= 0),
  description text not null check (length(btrim(description)) between 1 and 500),
  quantity numeric(14,3),
  unit text,
  unit_price numeric(14,4),
  discount_amount numeric(14,2) not null default 0,
  net_amount numeric(14,2) not null,
  tax text not null default 'iva' check (tax in ('iva', 'igic', 'ipsi', 'otros')),
  vat_rate numeric(5,2),
  vat_amount numeric(14,2),
  surcharge_rate numeric(5,2),
  surcharge_amount numeric(14,2),
  gross_amount numeric(14,2),
  notes text
);
create index issued_lines_invoice_idx on invoices.issued_invoice_lines (issued_invoice_id, position);

create table invoices.issued_tax_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  position int not null default 0 check (position >= 0),
  tax text not null default 'iva' check (tax in ('iva', 'igic', 'ipsi', 'otros', 'irpf', 'otra_retencion')),
  regime_key text not null default '01',
  qualification text check (qualification in ('S1', 'S2', 'N1', 'N2')),
  exemption text check (exemption in ('E1', 'E2', 'E3', 'E4', 'E5', 'E6')),
  rate numeric(5,2),
  taxable_base numeric(14,2),
  quota numeric(14,2) not null default 0,
  surcharge_rate numeric(5,2),
  surcharge_quota numeric(14,2),
  constraint issued_tax_qualification_ck check (qualification is null or exemption is null)
);
create index issued_tax_invoice_idx on invoices.issued_tax_lines (issued_invoice_id);

create table invoices.issued_invoice_files (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  file_id uuid not null references core.files(id),
  original_filename text not null check (length(original_filename) between 1 and 255),
  normalized_filename text,
  mime_type text not null check (mime_type in ('application/pdf', 'image/webp', 'image/jpeg', 'image/png')),
  size_bytes bigint not null check (size_bytes >= 0),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  page_order int not null default 1 check (page_order >= 1),
  unique (issued_invoice_id, file_id)
);

create table invoices.issued_allocations (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  issued_invoice_id uuid not null references invoices.issued_invoices(id),
  target_app text not null check (target_app in ('booking', 'general')),
  target_kind text not null,
  target_id text,
  target_code text,
  target_label text not null,
  target_revision bigint,
  allocated_amount numeric(14,2) not null check (allocated_amount > 0),
  notes text,
  constraint issued_alloc_pair_ck check ((target_app = 'booking' and target_kind in ('reservation', 'event') and target_id is not null)
    or (target_app = 'general' and target_kind = 'general' and target_id is null))
);
create index issued_alloc_invoice_idx on invoices.issued_allocations (issued_invoice_id);

-- ---------------------------------------------------------------------------
-- Sin papelera: una emitida, sus líneas, su desglose y sus documentos no se borran (se anula la factura).
-- ---------------------------------------------------------------------------
create or replace function invoices.guard_issued_delete()
returns trigger language plpgsql as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform core.fail('ISSUED_NOT_DELETABLE', 422, jsonb_build_object('table', tg_table_schema || '.' || tg_table_name, 'id', old.id));
  end if;
  return new;
end $$;
create trigger issued_invoices_no_delete before update on invoices.issued_invoices for each row execute function invoices.guard_issued_delete();
create trigger issued_lines_no_delete before update on invoices.issued_invoice_lines for each row execute function invoices.guard_issued_delete();
create trigger issued_taxes_no_delete before update on invoices.issued_tax_lines for each row execute function invoices.guard_issued_delete();
create trigger issued_files_no_delete before update on invoices.issued_invoice_files for each row execute function invoices.guard_issued_delete();

-- Una anulada no se edita (salvo para quitarle las asignaciones, que hace annul_issued).
create or replace function invoices.guard_issued_annulled()
returns trigger language plpgsql as $$
begin
  if old.status = 'anulada' then perform core.fail('ISSUED_ANNULLED', 409, jsonb_build_object('id', old.id)); end if;
  return new;
end $$;
create trigger issued_invoices_annulled before update on invoices.issued_invoices for each row execute function invoices.guard_issued_annulled();

-- Nombre canónico del documento: AAAA_MM_DD_(cliente)_SERIE-NUMERO[_pNN].ext
create or replace function invoices.issued_file_name()
returns trigger language plpgsql as $$
declare v invoices.issued_invoices; v_ext text;
begin
  select * into v from invoices.issued_invoices where id = new.issued_invoice_id;
  v_ext := case new.mime_type when 'application/pdf' then 'pdf' when 'image/webp' then 'webp' when 'image/jpeg' then 'jpg' else 'png' end;
  new.normalized_filename := to_char(v.issue_date, 'YYYY_MM_DD') || '_(' || coalesce(nullif(invoices.slugify(coalesce(v.recipient_name, '')), ''), 'sin_destinatario') || ')_'
    || regexp_replace(v.full_number, '[^A-Za-z0-9-]+', '_', 'g') || case when new.page_order > 1 then '_p' || lpad(new.page_order::text, 2, '0') else '' end || '.' || v_ext;
  return new;
end $$;
create trigger issued_files_name before insert on invoices.issued_invoice_files for each row execute function invoices.issued_file_name();

-- ---------------------------------------------------------------------------
-- Recálculo de importes (misma regla que _domain/invoices/issued.ts). Con desglose manda el desglose; sin él, las líneas
-- agrupadas por impuesto y tipo. Total = base + cuotas + recargo − retenciones.
-- ---------------------------------------------------------------------------
create or replace function invoices.recalculate_issued(p_id uuid,
  out base numeric, out quota numeric, out surcharge numeric, out withholding numeric, out total numeric)
language plpgsql stable as $$
#variable_conflict use_column
declare v_has_taxes boolean;
begin
  select exists (select 1 from invoices.issued_tax_lines where issued_invoice_id = p_id and deleted_at is null and tax not in ('irpf', 'otra_retencion')) into v_has_taxes;
  if v_has_taxes then
    select coalesce(sum(coalesce(taxable_base, 0)), 0), coalesce(sum(quota), 0), coalesce(sum(coalesce(surcharge_quota, 0)), 0) into base, quota, surcharge
      from invoices.issued_tax_lines where issued_invoice_id = p_id and deleted_at is null and tax not in ('irpf', 'otra_retencion');
  else
    select coalesce(sum(net_amount), 0) into base from invoices.issued_invoice_lines where issued_invoice_id = p_id and deleted_at is null;
    select coalesce(sum(case when g.all_amounts then g.amounts else round(g.net * coalesce(g.vat_rate, 0) / 100, 2) end), 0),
           coalesce(sum(case when g.all_surcharge then g.surcharges else round(g.net * coalesce(g.surcharge_rate, 0) / 100, 2) end), 0)
      into quota, surcharge
      from (select vat_rate, surcharge_rate, sum(net_amount) net, bool_and(vat_amount is not null) all_amounts, sum(coalesce(vat_amount, 0)) amounts,
                   bool_and(surcharge_amount is not null) all_surcharge, sum(coalesce(surcharge_amount, 0)) surcharges
            from invoices.issued_invoice_lines where issued_invoice_id = p_id and deleted_at is null group by vat_rate, surcharge_rate) g;
  end if;
  select coalesce(sum(quota), 0) into withholding from invoices.issued_tax_lines where issued_invoice_id = p_id and deleted_at is null and tax in ('irpf', 'otra_retencion');
  total := base + quota + surcharge - withholding;
end $$;

create or replace function invoices.check_issued(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p);
  v_ids uuid[]; v_id uuid; v_inv invoices.issued_invoices; r record; v_fields jsonb; v_delta numeric; v_reason text; v_alloc numeric;
begin
  select array_agg(distinct x.id) into v_ids from (
    select ch.row_id id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'issued_invoices' and ch.op <> 'call'
    union
    select (coalesce(ch.after, ch.before)->>'issued_invoice_id')::uuid from core.changes ch
    where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.op <> 'call'
      and ch.table_name in ('issued_invoice_lines', 'issued_tax_lines', 'issued_invoice_files', 'issued_allocations')
  ) x where x.id is not null;
  if v_ids is null then return; end if;
  foreach v_id in array v_ids loop
    select * into v_inv from invoices.issued_invoices where id = v_id for update;
    if v_inv.id is null then continue; end if;
    if v_inv.status <> 'anulada' then
      select * into r from invoices.recalculate_issued(v_id);
      v_delta := case when v_inv.source_total is null then null else v_inv.source_total - r.total end;
      v_reason := case when invoices.outside_tolerance(v_delta) then 'REVISAR IMPORTES' else null end;
      v_fields := '{}'::jsonb;
      if v_inv.base_total <> r.base then v_fields := v_fields || jsonb_build_object('base_total', r.base); end if;
      if v_inv.quota_total <> r.quota then v_fields := v_fields || jsonb_build_object('quota_total', r.quota); end if;
      if v_inv.surcharge_total <> r.surcharge then v_fields := v_fields || jsonb_build_object('surcharge_total', r.surcharge); end if;
      if v_inv.withholding_total <> r.withholding then v_fields := v_fields || jsonb_build_object('withholding_total', r.withholding); end if;
      if v_inv.total <> r.total then v_fields := v_fields || jsonb_build_object('total', r.total); end if;
      if v_inv.totals_delta is distinct from v_delta then v_fields := v_fields || jsonb_build_object('totals_delta', v_delta); end if;
      if v_inv.review_reason is distinct from v_reason then v_fields := v_fields || jsonb_build_object('review_reason', v_reason); end if;
      if v_fields <> '{}'::jsonb then
        perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v_id, 'expectedRevision', v_inv.revision, 'fields', v_fields));
      end if;
      -- El ingreso asignado nunca supera la base
      select coalesce(sum(allocated_amount), 0) into v_alloc from invoices.issued_allocations where issued_invoice_id = v_id and deleted_at is null;
      if v_alloc > r.base + 0.02 then
        perform core.fail('ALLOCATIONS_EXCEED_INVOICE', 422, jsonb_build_object('issued_invoice_id', v_id, 'allocated', v_alloc, 'base', r.base));
      end if;
    end if;
  end loop;
end $$;
select core.add_validate_hook('invoices', 'invoices.check_issued');

-- ---------------------------------------------------------------------------
-- Anular una emitida: motivo obligatorio; retira sus asignaciones. El número sigue ocupado.
-- ---------------------------------------------------------------------------
create or replace function invoices.annul_issued(p jsonb)
returns jsonb language plpgsql as $$
declare a jsonb := p->'args'; v invoices.issued_invoices; al record;
begin
  begin select * into v from invoices.issued_invoices where id = (a->>'issued_invoice_id')::uuid for update; exception when others then v.id := null; end;
  if v.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'invoices.issued_invoices', 'id', a->>'issued_invoice_id')); end if;
  if a->>'expectedRevision' is not null and (a->>'expectedRevision')::bigint <> v.revision then
    perform core.fail('VERSION_CONFLICT', 409, jsonb_build_object('table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', (a->>'expectedRevision')::bigint, 'currentRevision', v.revision, 'current', to_jsonb(v)));
  end if;
  if v.status = 'anulada' then perform core.fail('ISSUED_ANNULLED', 409, jsonb_build_object('id', v.id)); end if;
  if nullif(btrim(coalesce(a->>'reason', '')), '') is null then perform core.fail('ANNUL_REASON_REQUIRED', 422, jsonb_build_object('issued_invoice_id', v.id)); end if;
  for al in select * from invoices.issued_allocations where issued_invoice_id = v.id and deleted_at is null loop
    perform invoices.row_op(p, jsonb_build_object('op', 'delete', 'table', 'invoices.issued_allocations', 'id', al.id, 'expectedRevision', al.revision));
  end loop;
  perform invoices.row_op(p, jsonb_build_object('op', 'update', 'table', 'invoices.issued_invoices', 'id', v.id, 'expectedRevision', v.revision,
    'fields', jsonb_build_object('status', 'anulada', 'annulled_reason', btrim(a->>'reason'))));
  select * into v from invoices.issued_invoices where id = v.id;
  return to_jsonb(v);
end $$;
select core.allow_procedure('invoices', 'invoices.annul_issued');

-- ---------------------------------------------------------------------------
-- Registro en el núcleo (las columnas vf_* no son escribibles: las rellenará la emisión desde la app)
-- ---------------------------------------------------------------------------
select core.register_table('invoices', 'invoices', 'issued_series', array['code', 'description', 'kind', 'yearly', 'format', 'active'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'issued_invoice_lines', array[
  'issued_invoice_id', 'position', 'description', 'quantity', 'unit', 'unit_price', 'discount_amount', 'net_amount', 'tax', 'vat_rate', 'vat_amount',
  'surcharge_rate', 'surcharge_amount', 'gross_amount', 'notes'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'issued_tax_lines', array[
  'issued_invoice_id', 'position', 'tax', 'regime_key', 'qualification', 'exemption', 'rate', 'taxable_base', 'quota', 'surcharge_rate', 'surcharge_quota'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'issued_invoice_files', array['issued_invoice_id', 'file_id', 'original_filename', 'page_order', 'mime_type', 'size_bytes', 'sha256'], '{reader,editor,owner}', '{editor,owner}', true);
select core.register_table('invoices', 'invoices', 'issued_allocations', array['issued_invoice_id', 'target_app', 'target_kind', 'target_id', 'target_code', 'target_label', 'target_revision', 'allocated_amount', 'notes'], '{reader,editor,owner}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Proyección para Booking (aprobada por Core): ingreso real por reserva o evento, sin datos del destinatario.
-- ---------------------------------------------------------------------------
create view invoices.booking_income_projection as
  select a.id as allocation_id, a.issued_invoice_id, i.full_number, i.issue_date, a.target_kind, a.target_id, a.allocated_amount,
         i.status, i.income_category, a.revision as allocation_revision
  from invoices.issued_allocations a
  join invoices.issued_invoices i on i.id = a.issued_invoice_id
  where a.deleted_at is null and i.deleted_at is null and i.status <> 'anulada' and a.target_app = 'booking';
revoke all on invoices.booking_income_projection from public, anon, authenticated;
grant select on invoices.booking_income_projection to service_role;
select core.allow_read('booking', 'invoices.booking_income_projection', 'view');

revoke all on function invoices.guard_issued_delete(), invoices.guard_issued_annulled(), invoices.issued_file_name(), invoices.recalculate_issued(uuid),
  invoices.check_issued(jsonb), invoices.annul_issued(jsonb) from public, anon, authenticated;
