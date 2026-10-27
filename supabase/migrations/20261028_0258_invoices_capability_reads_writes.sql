-- Finance · qué lee y qué escribe la capacidad «Registrar compra rápida» (encargo de Core del 28-10; núcleo 0111, cobertura de
-- campos): `reads` y `writes` como `entity.prop`, con `entity` = `esquema.tabla` y `prop` = la columna, como los campos del
-- inventario. Así un paso de Flow que la usa cubre esos campos aunque no los pinte. La ficha es la de 0247 con las dos listas;
-- `register_capability` la actualiza.

select core.register_capability($cap${
  "id": "invoices.register_purchase_quick",
  "app": "invoices",
  "kind": "execute",
  "title": "Registrar compra rápida",
  "description": "Da de alta en Finance una compra con proveedor, fecha, importe con IVA, foto o PDF y número de factura opcionales y destino (un evento de Booking o general). Queda pendiente de revisión para la oficina. Con justificante es fiscal; sin él, de proceso, y no llega a la gestoría hasta tenerlo.",
  "route": "POST purchases/quick",
  "roles": ["editor", "owner"],
  "risk": "low",
  "idempotent": true,
  "reversible": false,
  "input": {
    "type": "object",
    "required": ["requestId", "supplier", "date", "total", "description", "target"],
    "additionalProperties": false,
    "properties": {
      "requestId": { "type": "string", "pattern": "^[A-Za-z0-9_.:-]{1,100}$" },
      "supplier": { "oneOf": [
        { "type": "object", "required": ["id"], "properties": { "id": { "type": "string", "format": "uuid" } }, "additionalProperties": false },
        { "type": "object", "required": ["name"], "properties": { "name": { "type": "string", "minLength": 1, "maxLength": 200 }, "tax_id": { "type": ["string", "null"], "maxLength": 32 } }, "additionalProperties": false }
      ] },
      "date": { "type": "string", "format": "date" },
      "total": { "type": "number", "exclusiveMinimum": 0, "maximum": 1000000, "multipleOf": 0.01 },
      "vat_rate": { "type": ["number", "null"], "enum": [0, 4, 5, 10, 21, null] },
      "description": { "type": "string", "minLength": 1, "maxLength": 120 },
      "file_id": { "type": ["string", "null"], "format": "uuid" },
      "invoice_number": { "type": ["string", "null"], "maxLength": 64 },
      "receipt_kind": { "enum": ["invoice", "ticket"] },
      "target": { "oneOf": [
        { "type": "object", "required": ["app", "kind", "id"], "properties": { "app": { "const": "booking" }, "kind": { "const": "event" }, "id": { "type": "string", "format": "uuid" } }, "additionalProperties": false },
        { "type": "object", "required": ["app", "kind"], "properties": { "app": { "const": "general" }, "kind": { "enum": ["unassigned", "operating_expense", "investment"] } }, "additionalProperties": false }
      ] },
      "notes": { "type": ["string", "null"], "maxLength": 2000 }
    }
  },
  "output": {
    "type": "object",
    "required": ["invoice_id", "code", "status", "nature", "supplier", "total", "base", "vat", "target", "file_id", "replayed", "summary"],
    "properties": {
      "invoice_id": { "type": "string", "format": "uuid" },
      "code": { "type": ["string", "null"] },
      "status": { "type": "string" },
      "nature": { "enum": ["fiscal", "process"] },
      "supplier": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" }, "created": { "type": "boolean" } } },
      "total": { "type": "number" }, "base": { "type": "number" }, "vat": { "type": ["number", "null"] },
      "target": { "type": "object", "properties": { "app": { "type": "string" }, "kind": { "type": "string" }, "id": { "type": ["string", "null"] }, "label": { "type": "string" } } },
      "file_id": { "type": ["string", "null"] },
      "replayed": { "type": "boolean" },
      "summary": { "type": "string" }
    }
  },
  "reads": ["invoices.suppliers.name", "invoices.suppliers.tax_id", "invoices.invoices.invoice_number", "invoices.invoices.status", "invoices.invoices.code"],
  "writes": ["invoices.suppliers.name", "invoices.suppliers.tax_id", "invoices.invoices.supplier_id", "invoices.invoices.invoice_date", "invoices.invoices.object", "invoices.invoices.source_total", "invoices.invoices.invoice_number", "invoices.invoices.receipt_kind", "invoices.invoices.notes", "invoices.invoice_lines.description", "invoices.invoice_lines.net_amount", "invoices.invoice_lines.vat_rate", "invoices.invoice_lines.vat_amount", "invoices.tax_lines.tax_type", "invoices.tax_lines.rate", "invoices.tax_lines.taxable_base", "invoices.tax_lines.amount", "invoices.invoice_files.file_id", "invoices.allocations.target_app", "invoices.allocations.target_kind", "invoices.allocations.target_id", "invoices.allocations.target_label", "invoices.allocations.allocated_amount"],
  "anchors": ["invoices.facturas.nueva", "invoices.facturas.nueva.formulario", "invoices.facturas.nueva.crear"],
  "since": "0.1.0"
}$cap$::jsonb);
