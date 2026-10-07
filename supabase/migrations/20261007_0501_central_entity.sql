-- Ikisai Central · configuración común, primer bloque: datos de la entidad (razón social, NIF/CIF, domicilio fiscal y logotipo).
-- Referencia: docs/central/API.md §2.9 (aprobado por el usuario, ronda 3). Toca solo el schema central.
-- Los datos reales no van en Git: el owner los escribe en la app.

create table central.entity (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  legal_name text not null check (length(btrim(legal_name)) between 1 and 200),
  trade_name text check (trade_name is null or length(btrim(trade_name)) between 1 and 120),
  tax_id text not null check (tax_id ~ '^[A-Z0-9]{8,15}$'),
  address_line text not null check (length(btrim(address_line)) between 1 and 200),
  postal_code text not null check (length(btrim(postal_code)) between 3 and 12),
  city text not null check (length(btrim(city)) between 1 and 80),
  province text check (province is null or length(btrim(province)) between 1 and 80),
  country text not null default 'ES' check (country ~ '^[A-Z]{2}$'),
  email text check (email is null or (length(email) <= 320 and email ~ '^[^\s@]+@[^\s@]+\.[^\s@]+$')),
  phone text check (phone is null or length(phone) <= 32),
  website text check (website is null or (length(website) <= 200 and website ~ '^https://')),
  logo_file_id uuid
);
-- Una sola entidad viva.
create unique index entity_single_idx on central.entity ((true)) where deleted_at is null;

-- Solo el owner de Central la escribe; todos los miembros la leen.
select core.register_table('central', 'central', 'entity', array['legal_name','trade_name','tax_id','address_line','postal_code','city',
  'province','country','email','phone','website','logo_file_id'], '{reader,editor,owner}', '{owner}');

-- ---------------------------------------------------------------------------
-- Proyección para las apps que imprimen documentos con los datos de Ikisai: Booking (propuesta al organizador) y
-- Finance (facturas emitidas). Datos de la entidad, no personales. El logotipo va como referencia al archivo
-- verificado (bucket y ruta): la Edge lectora firma la URL con su clave de servicio (solo lectura).
-- `entity_revision` sirve para la obsolescencia por comparación (contrato §8).
-- ---------------------------------------------------------------------------
create view central.common_entity_projection as
select e.id as entity_id, e.legal_name, e.trade_name, e.tax_id, e.address_line, e.postal_code, e.city, e.province, e.country,
       e.email, e.phone, e.website, e.revision as entity_revision, e.updated_at,
       f.id as logo_file_id, f.bucket as logo_bucket, f.path as logo_path, f.mime as logo_mime, f.sha256 as logo_sha256
  from central.entity e
  left join core.files f on f.id = e.logo_file_id and f.app = 'central' and f.status = 'verified'
 where e.deleted_at is null;

revoke all on central.common_entity_projection from public, anon, authenticated;
grant select on central.common_entity_projection to service_role;
select core.allow_read('central', 'central.common_entity_projection', 'view');
select core.allow_read('booking', 'central.common_entity_projection', 'view');
select core.allow_read('invoices', 'central.common_entity_projection', 'view');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
