-- Invoices · directorio de clientes por NIF (ronda 46, aprobado por el usuario). Toca solo el schema invoices.
--
-- Solo los datos fiscales que lleva una factura: nombre o razón social, NIF (o identificador extranjero con su tipo),
-- país y domicilio fiscal, y el tipo de destinatario. Ningún otro dato personal (ni teléfono ni correo).
-- El borrador de factura lo busca para rellenar el NIF y el domicilio; al emitir con un NIF nuevo, la app ofrece guardarlo.
-- Un NIF solo una vez por país entre los clientes vivos. Se sincroniza: la búsqueda funciona sin red.

create table invoices.customers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 200),
  tax_id text not null check (tax_id ~ '^[A-Z0-9][A-Z0-9-]{1,39}$'),
  id_type text not null default 'NIF' check (id_type in ('NIF', '02', '03', '04', '05', '06')),
  country char(2) not null default 'ES' check (country ~ '^[A-Z]{2}$'),
  kind text check (kind in ('empresa', 'profesional', 'particular')),
  address jsonb check (address is null or jsonb_typeof(address) = 'object')
);
create unique index customers_tax_id_uq on invoices.customers (country, tax_id) where deleted_at is null;
create index customers_name_idx on invoices.customers (lower(name)) where deleted_at is null;

select core.register_table('invoices', 'invoices', 'customers', array['name', 'tax_id', 'id_type', 'country', 'kind', 'address'],
  '{reader,editor,owner}', '{editor,owner}');
