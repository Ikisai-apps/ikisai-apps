-- Ikisai Central · la proyección de la entidad dice dónde vive el logotipo (contrato §3.9, `core.files.storage_provider`),
-- para que Booking y Finance lo firmen con `createStorage` del kit. Toca solo el schema central.
-- `create or replace view` solo admite columnas nuevas al final: `logo_provider` va la última. Permisos y `allow_read` se conservan.

create or replace view central.common_entity_projection as
select e.id as entity_id, e.legal_name, e.trade_name, e.tax_id, e.address_line, e.postal_code, e.city, e.province, e.country,
       e.email, e.phone, e.website, e.revision as entity_revision, e.updated_at,
       f.id as logo_file_id, f.bucket as logo_bucket, f.path as logo_path, f.mime as logo_mime, f.sha256 as logo_sha256,
       f.storage_provider as logo_provider
  from central.entity e
  left join core.files f on f.id = e.logo_file_id and f.app = 'central' and f.status = 'verified'
 where e.deleted_at is null;

revoke all on central.common_entity_projection from public, anon, authenticated;
grant select on central.common_entity_projection to service_role;
