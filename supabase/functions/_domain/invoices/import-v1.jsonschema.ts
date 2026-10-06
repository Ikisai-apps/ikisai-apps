/**
 * JSON Schema `ikisai.invoice.v1` (03_IKISAI_INVOICE_IMPORT_V1.schema.json del handoff) para forzar la forma de la salida del
 * modelo de visión en `imports/extract` (salida estructurada del proveedor, vía `schema` del helper de `_kit`).
 * Es el schema del handoff sin las palabras clave que el proveedor no admite o no necesita (`format`, `minLength`, `minimum`,
 * `maximum`, `minItems`, `default`, `$id`, `title`): esas reglas las sigue comprobando `validateImportDocument` en la Edge,
 * que es la verdad del formato. Generado desde el archivo del handoff; si cambia el schema, regenerar y no editar a mano.
 */
export const IMPORT_JSON_SCHEMA: Record<string, unknown> = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "invoice",
    "lines",
    "taxes",
    "document_totals"
  ],
  "properties": {
    "schema_version": {
      "const": "ikisai.invoice.v1"
    },
    "invoice": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "invoice_date",
        "supplier_name",
        "object",
        "currency"
      ],
      "properties": {
        "invoice_date": {
          "type": "string"
        },
        "supplier_name": {
          "type": "string"
        },
        "supplier_tax_id": {
          "type": [
            "string",
            "null"
          ]
        },
        "invoice_number": {
          "type": [
            "string",
            "null"
          ]
        },
        "object": {
          "type": "string"
        },
        "currency": {
          "type": "string"
        },
        "deductibility_suggestion": {
          "enum": [
            "si",
            "no",
            "parcial",
            "pendiente_revision",
            null
          ]
        },
        "notes": {
          "type": [
            "string",
            "null"
          ]
        }
      }
    },
    "lines": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "description",
          "net_amount"
        ],
        "properties": {
          "description": {
            "type": "string"
          },
          "quantity": {
            "type": [
              "number",
              "null"
            ]
          },
          "unit": {
            "type": [
              "string",
              "null"
            ]
          },
          "unit_price": {
            "type": [
              "number",
              "null"
            ]
          },
          "discount_amount": {
            "type": [
              "number",
              "null"
            ]
          },
          "net_amount": {
            "type": "number"
          },
          "vat_rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "vat_amount": {
            "type": [
              "number",
              "null"
            ]
          },
          "gross_amount": {
            "type": [
              "number",
              "null"
            ]
          },
          "suggested_item_type": {
            "enum": [
              "food_ingredient",
              "equipment",
              "material",
              "service",
              "other",
              null
            ]
          },
          "suggested_match_name": {
            "type": [
              "string",
              "null"
            ]
          },
          "confidence": {
            "type": [
              "number",
              "null"
            ]
          },
          "notes": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      }
    },
    "taxes": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "tax_type",
          "amount"
        ],
        "properties": {
          "tax_type": {
            "enum": [
              "iva",
              "irpf",
              "otra_retencion",
              "otro"
            ]
          },
          "rate": {
            "type": [
              "number",
              "null"
            ]
          },
          "taxable_base": {
            "type": [
              "number",
              "null"
            ]
          },
          "amount": {
            "type": "number"
          },
          "notes": {
            "type": [
              "string",
              "null"
            ]
          }
        }
      }
    },
    "document_totals": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "base",
        "vat",
        "withholding",
        "total"
      ],
      "properties": {
        "base": {
          "type": "number"
        },
        "vat": {
          "type": "number"
        },
        "withholding": {
          "type": "number"
        },
        "total": {
          "type": "number"
        }
      }
    },
    "extraction_notes": {
      "type": [
        "string",
        "null"
      ]
    },
    "overall_confidence": {
      "type": [
        "number",
        "null"
      ]
    }
  }
};
