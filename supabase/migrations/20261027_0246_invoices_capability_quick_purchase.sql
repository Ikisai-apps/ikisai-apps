-- Invoices · ficha de la capacidad «Registrar compra rápida» en el catálogo del núcleo (0097, PR #779 de Core; API.md §18).
-- Toca solo el schema invoices (la función es del núcleo; el dato es de Finance).
select core.register_capability($cap${
  "id": "invoices.register_purchase_quick",
  "app": "invoices",
  "kind": "execute",
  "title": "Registrar compra rápida",
  "description": "Da de alta en Finance una compra con proveedor, fecha, importe con IVA, foto o PDF opcional y destino (un evento de Booking o general). Queda pendiente de revisión para la oficina.",
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
      "target": { "oneOf": [
        { "type": "object", "required": ["app", "kind", "id"], "properties": { "app": { "const": "booking" }, "kind": { "const": "event" }, "id": { "type": "string", "format": "uuid" } }, "additionalProperties": false },
        { "type": "object", "required": ["app", "kind"], "properties": { "app": { "const": "general" }, "kind": { "enum": ["unassigned", "operating_expense", "investment"] } }, "additionalProperties": false }
      ] },
      "notes": { "type": ["string", "null"], "maxLength": 2000 }
    }
  },
  "output": {
    "type": "object",
    "required": ["invoice_id", "code", "status", "supplier", "total", "base", "vat", "target", "file_id", "replayed", "summary"],
    "properties": {
      "invoice_id": { "type": "string", "format": "uuid" },
      "code": { "type": ["string", "null"] },
      "status": { "type": "string" },
      "supplier": { "type": "object", "properties": { "id": { "type": "string" }, "name": { "type": "string" }, "created": { "type": "boolean" } } },
      "total": { "type": "number" }, "base": { "type": "number" }, "vat": { "type": ["number", "null"] },
      "target": { "type": "object", "properties": { "app": { "type": "string" }, "kind": { "type": "string" }, "id": { "type": ["string", "null"] }, "label": { "type": "string" } } },
      "file_id": { "type": ["string", "null"] },
      "replayed": { "type": "boolean" },
      "summary": { "type": "string" }
    }
  },
  "anchors": ["invoices.facturas.nueva", "invoices.facturas.nueva.formulario", "invoices.facturas.nueva.crear"],
  "since": "0.1.0"
}$cap$::jsonb);
