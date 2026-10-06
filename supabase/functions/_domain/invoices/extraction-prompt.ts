/**
 * Prompt de extracción para ChatGPT (05_PROMPT_EXTRACCION_FACTURA.md del handoff), listo para copiar desde la app.
 * Incluye el schema `ikisai.invoice.v1` resumido y un ejemplo, porque quien lo pega en ChatGPT no tiene el archivo del schema.
 */

export const EXTRACTION_PROMPT = `Lee la factura adjunta (PDF o imágenes) y devuelve ÚNICAMENTE un JSON que valide contra el formato ikisai.invoice.v1 que describo abajo. Si hay alguna ambigüedad material, dila en una nota corta ANTES del JSON; dentro del JSON no pongas prosa.

Reglas:
- No inventes datos ilegibles. Si un valor no aparece o no puede determinarse, usa null donde el formato lo permite.
- Conserva las líneas de la factura con el máximo detalle razonable; no consolides distintos tipos de IVA en uno.
- Separa IVA y retenciones. taxes[].amount y document_totals.withholding son importes POSITIVOS.
- La relación esperada es: total = base + vat - withholding. Si la factura trae redondeos o descuentos que impiden cuadrar exactamente, explícalo en extraction_notes.
- No decidas si el gasto es deducible: como máximo "pendiente_revision".
- suggested_item_type ayuda a clasificar cada línea: food_ingredient, equipment, material, service u other. suggested_match_name puede sugerir el ingrediente o equipo canónico; la app pedirá confirmación.
- La app recalculará y comparará los totales; el JSON nunca es verdad fiscal por sí solo.

Formato ikisai.invoice.v1 (todas las claves exactamente así; ninguna clave extra):
{
  "schema_version": "ikisai.invoice.v1",
  "invoice": {
    "invoice_date": "AAAA-MM-DD",            // obligatorio
    "supplier_name": "texto",                 // obligatorio
    "supplier_tax_id": "NIF o null",
    "invoice_number": "número o null",
    "object": "qué se compró, en pocas palabras",   // obligatorio
    "currency": "EUR",                        // obligatorio
    "deductibility_suggestion": "si" | "no" | "parcial" | "pendiente_revision" | null,
    "notes": "texto o null"
  },
  "lines": [                                  // al menos una
    {
      "description": "texto",                 // obligatorio
      "quantity": número o null,
      "unit": "kg, l, ud… o null",
      "unit_price": número o null,            // sin IVA
      "discount_amount": número o null,       // importe, no porcentaje
      "net_amount": número,                   // obligatorio: base de la línea sin IVA
      "vat_rate": número o null,              // 0, 4, 10, 21
      "vat_amount": número o null,
      "gross_amount": número o null,
      "suggested_item_type": "food_ingredient" | "equipment" | "material" | "service" | "other" | null,
      "suggested_match_name": "texto o null",
      "confidence": número entre 0 y 1 o null,
      "notes": "texto o null"
    }
  ],
  "taxes": [                                  // puede estar vacío si la factura no desglosa
    { "tax_type": "iva" | "irpf" | "otra_retencion" | "otro", "rate": número o null, "taxable_base": número o null, "amount": número, "notes": "texto o null" }
  ],
  "document_totals": { "base": número, "vat": número, "withholding": número, "total": número },   // obligatorio
  "extraction_notes": "texto o null",
  "overall_confidence": número entre 0 y 1 o null
}

Ejemplo válido:
{
  "schema_version": "ikisai.invoice.v1",
  "invoice": { "invoice_date": "2026-10-05", "supplier_name": "Proveedor Ejemplo S.L.", "supplier_tax_id": "B00000000", "invoice_number": "F-2026-123", "object": "alimentos retiro ejemplo", "currency": "EUR", "deductibility_suggestion": "pendiente_revision", "notes": null },
  "lines": [ { "description": "Tomate", "quantity": 20, "unit": "kg", "unit_price": 2.0, "discount_amount": 0, "net_amount": 40.0, "vat_rate": 10, "vat_amount": 4.0, "gross_amount": 44.0, "suggested_item_type": "food_ingredient", "suggested_match_name": "tomate", "confidence": 0.99, "notes": null } ],
  "taxes": [ { "tax_type": "iva", "rate": 10, "taxable_base": 40.0, "amount": 4.0, "notes": null } ],
  "document_totals": { "base": 40.0, "vat": 4.0, "withholding": 0.0, "total": 44.0 },
  "extraction_notes": null,
  "overall_confidence": 0.98
}`;
