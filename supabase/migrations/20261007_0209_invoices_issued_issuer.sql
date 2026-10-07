-- Invoices · emisor de las facturas emitidas (ronda 37). Toca solo el schema invoices.
--
-- El emisor es la entidad de Central (`central.common_entity_projection`). Al registrar una emitida, la Edge guarda una
-- copia de sus datos en ese momento: un registro fiscal no cambia si después cambian los datos de la entidad.
-- `issuer_tax_id` e `issuer_name` son los dos campos que Verifactu pide del emisor (identificación y nombre o razón
-- social); `issuer` guarda el resto (nombre comercial, domicilio, contacto, revisión de la entidad y logotipo por id).
-- Si la entidad aún no tiene datos, quedan vacíos y la app avisa: «Faltan los datos de la entidad en Central».

alter table invoices.issued_invoices
  add column issuer_tax_id text check (issuer_tax_id is null or issuer_tax_id ~ '^[A-Z0-9]{8,15}$'),
  add column issuer_name text check (issuer_name is null or length(btrim(issuer_name)) between 1 and 200),
  add column issuer jsonb check (issuer is null or jsonb_typeof(issuer) = 'object');

select core.register_table('invoices', 'invoices', 'issued_invoices', array[
  'series_code', 'number', 'issue_date', 'operation_date', 'invoice_type', 'rectification_kind', 'rectified', 'rectification_reason', 'rectified_base', 'rectified_quota',
  'recipient_name', 'recipient_tax_id', 'recipient_id_type', 'recipient_country', 'extra_recipients', 'description', 'notes', 'currency',
  'base_total', 'quota_total', 'surcharge_total', 'withholding_total', 'total', 'source_total', 'totals_delta', 'status', 'review_reason', 'annulled_reason',
  'origin', 'external_tool', 'external_id', 'import_sha256', 'income_category', 'payment_status', 'paid_at', 'external_qr_url', 'external_csv',
  'issuer_tax_id', 'issuer_name', 'issuer'], '{reader,editor,owner}', '{editor,owner}', true);
