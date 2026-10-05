-- Invoices · app registrada y primera tabla sincronizable (proveedores). Toca solo el schema invoices.
select core.ensure_app('invoices', 'Ikisai Invoices', 'invoices.ikisai.com');

create schema if not exists invoices;
revoke all on schema invoices from public;
revoke all on schema invoices from anon, authenticated;
grant usage on schema invoices to service_role;

create table invoices.suppliers (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(name) between 1 and 200),
  tax_id text check (tax_id is null or length(tax_id) <= 32),
  default_category text check (default_category is null or default_category in ('compras','suministros','mantenimiento','inversiones','canon_concesion','seguros','personal','fiscalidad','otros')),
  notes text
);
create index suppliers_name_idx on invoices.suppliers (lower(name)) where deleted_at is null;

select core.register_table('invoices', 'invoices', 'suppliers', array['name','tax_id','default_category','notes']);
