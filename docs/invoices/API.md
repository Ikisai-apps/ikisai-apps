# Ikisai Invoices · API y modelo de datos (puerta G2)

Fecha: 6 de octubre de 2026 (revisión 2, cotejada con el handoff V3). Autor: equipo Invoices (agente de backend). Estado: **aprobado de forma provisional por Core**; los comentarios de Core en la PR no bloquean. Sigue `docs/core/PLANTILLA_API_APP.md`; el contrato `docs/core/CONTRATO_SINCRONIZACION.md` es normativo y aquí no se repite.

Fuentes: `02_HANDOFF_TECNICO_CORE_V3.md` §24A, §25 (Invoices API) y §31A; `03_IKISAI_INVOICE_IMPORT_V1.schema.json`; `04_EJEMPLO_IKISAI_INVOICE_IMPORT_V1.json`; `05_PROMPT_EXTRACCION_FACTURA.md`; `07_CHECKLIST_ACEPTACION.md` A; `docs/core/PLAN.md` §5; criterios fiscales de C08. Donde el handoff y el plan de Core difieren (el handoff no preveía `core` ni offline), manda el plan de Core; donde el handoff fija comportamiento funcional (nombre canónico, estados, JSON, ZIP), manda el handoff.

---

## 1. Dominio y límites

**Qué resuelve.** `invoices.ikisai.com` gestiona **facturas de compra y lo que realmente se compró**: documento original (PDF o fotos) con nombre canónico, datos estructurados importados del JSON `ikisai.invoice.v1` que produce ChatGPT con el prompt del handoff, líneas compradas, IVA y retenciones recalculados y comparados con el total documental (tolerancia 0,02 €), categoría de gasto cerrada y marca de inversión, periodo fiscal derivado de la fecha, estado de pago, **asignación por línea** a destinos tipados de Tasks, Booking, Food o general, y las dos lecturas que necesita el usuario: **Compras** (artículos comprados, para qué, qué falta por asignar) y **Gestoría** (resumen fiscal por rango y ZIP con originales, CSV y manifest con hashes).

```text
PDF / foto → archivo normalizado → JSON importado → factura → líneas → IVA / retenciones / total → asignación → entrada útil para inventario → ZIP gestoría
```

**Qué no hace (handoff §24A «Fuera de V1»).** OCR/IA embebida en V1 (en V2 la ruta `imports/extract` llama al helper de visión de `_kit`; la app ya tiene el botón «Extraer» y responde con claridad cuando no está disponible), cuentas PGC, facturas emitidas, conciliación o conexión bancaria, modelos tributarios, inventario completo, amortizaciones, CRM de proveedores, aprobación multinivel. No sustituye la contabilidad oficial ni a la gestoría: es un resumen documental.

**Datos de otras apps.** Los destinos son enlaces tipados (§7). No se copia nada de Tasks, Booking ni Food como fuente de verdad: `target_id`, `target_code`, un `target_label` de cortesía y `target_revision` para la obsolescencia por comparación.

**Papelera.** Las facturas, sus documentos, sus líneas e impuestos y las entregas **no se borran**: una factura se anula (`status = 'anulada'`) y se conserva. `suppliers` y `allocations` admiten borrado lógico y papelera.

---

## 2. Tablas sincronizables (`invoices.*`)

Todas llevan las columnas del contrato §2.1 y se registran con `core.register_table` en la misma migración. Importes `numeric(12,2)` salvo indicación; `EUR` en V1. Fechas `date`. Roles: lectura `{reader, editor, owner}`, escritura `{editor, owner}`. La gestoría puede ser `reader`: ve todo y descarga el ZIP, no escribe.

### 2.1 `invoices.suppliers` (existe; se amplía)

Decisión de Core (plan §5): proveedores en tabla ligera, aunque el handoff los denormalizaba en la factura. La migración de G2 añade:

| Columna | Tipo | Notas |
|---|---|---|
| `aliases` | `text[] not null default '{}'` | Nombres con los que aparece en facturas («MAKRO ESPAÑA S.A.»). Máximo 20, cada uno ≤ 200. Emparejamiento de la importación. |
| `slug` | `text not null` | Forma corta para el nombre canónico: `makro`. Se genera desde `name` si no se da (§2.12). No es único: dos proveedores con el mismo slug colisionan en el nombre de archivo y se resuelven con `_NN`. |
| `default_is_investment` | `boolean not null default false` | |

`writable_columns`: `name, tax_id, default_category, default_is_investment, aliases, slug, notes`. Índice `unique (upper(tax_id)) where deleted_at is null and tax_id is not null`.

### 2.2 `invoices.invoices`

| Columna | Tipo | Restricciones |
|---|---|---|
| `code` | `text unique not null` | `FVR_AAAA_NNN` (`core.next_code('FVR', año de invoice_date)`), asignado por trigger en el `insert`. No escribible. |
| `supplier_id` | `uuid not null references invoices.suppliers(id)` | |
| `invoice_date` | `date not null` | Fecha de la factura. Origen del nombre canónico y del periodo fiscal. |
| `object` | `text not null check (length(object) between 1 and 120)` | Objeto corto («alimentos retiro yoga»). Va al nombre canónico. |
| `invoice_number` | `text null` | Número del proveedor (≤ 64); puede faltar en tickets. |
| `currency` | `char(3) not null default 'EUR' check (currency = 'EUR')` | |
| `due_date` | `date null` | |
| `expense_category` | `text null` | Lista cerrada §2.10. Obligatoria para `validada`. |
| `is_investment` | `boolean not null default false` | Explotación / inversión (C08 §7.2). |
| `deductibility` | `text not null default 'pendiente_revision'` | `check in ('si','no','parcial','pendiente_revision')`. La app sugiere; no decide. |
| `status` | `text not null default 'pendiente_datos'` | `check in ('pendiente_datos','pendiente_revision','validada','archivada','anulada')`. §2.11. |
| `review_reason` | `text null` | Por qué está en `pendiente_revision`: `IMPORTADA`, `DATOS_INTRODUCIDOS` (manual con contenido), `REVISAR IMPORTES` (`|totals_delta| > 0,02`), `IMPORTES_CORREGIDOS` (volvió a cuadrar), `EDITADA_TRAS_VALIDAR`. |
| `annulled_reason` | `text null` | Obligatorio en `anulada`. |
| `payment_status` | `text not null default 'pendiente'` | `check in ('pendiente','pagada')`. |
| `payment_method` | `text null` | `check in ('transferencia','tarjeta','efectivo','bizum','domiciliacion','otro')`. |
| `paid_at` | `date null` | Obligatorio con `pagada`. |
| `source_total` | `numeric(12,2) null` | Total que imprime el documento (`document_totals.total` o lo que teclea el usuario). |
| `calculated_base` | `numeric(12,2) not null default 0` | Σ `taxable_base` de los impuestos `iva` (si no traen base, la de `otro`; si no hay desglose, Σ `net_amount` de las líneas). |
| `calculated_vat` | `numeric(12,2) not null default 0` | Σ `tax_lines.amount` con `tax_type = 'iva'`. |
| `calculated_other` | `numeric(12,2) not null default 0` | Σ `amount` con `tax_type = 'otro'` (otros tributos que se suman, p. ej. recargo de equivalencia). |
| `calculated_withholding` | `numeric(12,2) not null default 0` | Σ `amount` con `tax_type in ('irpf','otra_retencion')`. |
| `calculated_total` | `numeric(12,2) not null default 0` | `base + vat + other − withholding`. |
| `totals_delta` | `numeric(12,2) null` | `source_total − calculated_total`; `null` si no hay `source_total`. |
| `source` | `text not null default 'manual' check in ('manual','import_v1')` | |
| `import_sha256` | `text null` | SHA-256 del JSON importado. |
| `import_meta` | `jsonb null` | `{overall_confidence, extraction_notes, deductibility_suggestion, document_totals, recalculation:{...}, warnings[]}`. Lo escribe `import_v1`. |
| `fiscal_year` | `int generated always as (extract(year from invoice_date)::int) stored` | **Periodo fiscal derivado.** |
| `fiscal_quarter` | `int generated always as (extract(quarter from invoice_date)::int) stored` | |
| `fiscal_period` | `text generated always as (… 'AAAA' || 'T' || trimestre) stored` | `2026T4`. |
| `notes` | `text null` | |

`writable_columns`: `supplier_id, invoice_date, object, invoice_number, currency, due_date, expense_category, is_investment, deductibility, status, review_reason, annulled_reason, payment_status, payment_method, paid_at, source_total, calculated_base, calculated_vat, calculated_other, calculated_withholding, calculated_total, totals_delta, source, import_sha256, import_meta, notes`. Los `calculated_*` y `totals_delta` los escribe el cliente (dominio compartido) y el servidor los **recalcula y sobrescribe** en el hook de invariantes (§4.3): si el cliente manda otra cosa, gana el servidor. `import_meta` solo lo acepta la Edge dentro de `call import_v1` (en `insert`/`update` directos lo rechaza).

`never_purge = true`. Índices: `unique (supplier_id, lower(invoice_number)) where deleted_at is null and status <> 'anulada' and invoice_number is not null`; `(invoice_date desc)`; `(fiscal_year, fiscal_quarter)`; `(status)`.

### 2.3 `invoices.invoice_files`

Binario en Storage (`purchase-documents`), registro en `core.files`. El lint permite leer `core.files`, así que la FK existe.

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `file_id` | `uuid not null references core.files(id)` | `unique (invoice_id, file_id)`. |
| `original_filename` | `text not null` | Nombre con el que llegó (handoff: conservar en metadatos). |
| `normalized_filename` | `text not null` | Nombre canónico (§2.12). Lo calcula el servidor; no escribible. `unique where deleted_at is null`. |
| `mime_type` | `text not null` | `application/pdf`, `image/webp`, `image/jpeg`, `image/png`. Copiado de `core.files`. |
| `size_bytes` | `bigint not null` | Copiado de `core.files`. |
| `sha256` | `text not null` | Copiado de `core.files` (hash verificado por el servidor). Es el que va al manifest. |
| `page_order` | `int not null default 1` | Orden de página para varias imágenes (`_p01`, `_p02`). |
| `kind` | `text not null default 'original' check in ('original','attachment')` | `original` = páginas del documento; `attachment` = albarán, justificante. |

`writable_columns`: `invoice_id, file_id, original_filename, page_order, kind, mime_type, size_bytes, sha256`. Los tres últimos los rellena la Edge desde `core.files` en `beforeCommit` (sobrescribe lo que mande el cliente). `never_purge = true`. Borrado lógico solo con factura en `pendiente_datos|pendiente_revision` (trigger). Duplicado binario (mismo `sha256` en otra factura viva) → aviso `DUPLICATE_FILE` en el preview, no bloqueo.

### 2.4 `invoices.invoice_lines`

Una fila = un artículo o servicio comprado (handoff).

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `position` | `int not null` | `unique (invoice_id, position) deferrable initially deferred`. |
| `description` | `text not null check (length between 1 and 500)` | |
| `quantity` | `numeric(12,3) null` | |
| `unit` | `text null` | ≤ 16. |
| `unit_price` | `numeric(12,4) null` | Sin IVA. |
| `discount_amount` | `numeric(12,2) not null default 0` | Importe, no porcentaje (handoff y schema). |
| `net_amount` | `numeric(12,2) not null` | Base de la línea. Si hay `quantity` y `unit_price`: `round(q × p, 2) − discount_amount` ± 0,02 (aviso, no bloqueo). |
| `vat_rate` | `numeric(5,2) null check (vat_rate is null or vat_rate between 0 and 100)` | No se asume una tasa por factura. |
| `vat_amount` | `numeric(12,2) null` | |
| `gross_amount` | `numeric(12,2) null` | `net_amount + vat_amount`. |
| `item_type` | `text null check in ('food_ingredient','equipment','material','service','other')` | De `suggested_item_type`; el usuario lo confirma. |
| `match_name` | `text null` | De `suggested_match_name` (ingrediente o equipo canónico sugerido). Food lo usará en V2. |
| `expense_category` | `text null` | Sobrescribe la de la factura (lista cerrada). |
| `is_investment` | `boolean null` | Sobrescribe la de la factura. |
| `confidence` | `numeric(3,2) null check (between 0 and 1)` | De la extracción. |
| `notes` | `text null` | |

`writable_columns`: todas las anteriores. `never_purge = true` (una línea borrada se marca `deleted_at`, nunca se purga: es parte del documento). Borrado lógico solo con factura no `validada|archivada|anulada`.

### 2.5 `invoices.tax_lines`

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `position` | `int not null` | |
| `tax_type` | `text not null check in ('iva','irpf','otra_retencion','otro')` | Handoff. |
| `rate` | `numeric(5,2) null` | |
| `taxable_base` | `numeric(12,2) null` | |
| `amount` | `numeric(12,2) not null check (amount >= 0)` | Siempre positivo; el signo lo da `tax_type`. |
| `notes` | `text null` | |

`writable_columns`: todas. `never_purge = true`. Convención: `total = base + IVA − retenciones`.

### 2.6 `invoices.allocations`

La unidad de asignación es la **línea** (handoff). Una línea puede repartirse entre varios destinos; no se permite sobreasignar.

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_line_id` | `uuid not null references invoices.invoice_lines(id)` | |
| `invoice_id` | `uuid not null references invoices.invoices(id)` | Redundante a propósito (índices y validación); el trigger lo rellena y comprueba que coincide con la línea. |
| `target_app` | `text not null check in ('tasks','booking','food','general')` | |
| `target_kind` | `text not null` | `tasks`: `area|project|task` · `booking`: `reservation|event` · `food`: `ingredient|equipment` · `general`: `unassigned|operating_expense|investment`. `check` por pares. |
| `target_id` | `text null` | Id en la app destino (`text`: Tasks puede usar ids no uuid). Obligatorio salvo `general`. |
| `target_code` | `text null` | Código humano del destino si lo tiene. |
| `target_label` | `text not null` | Texto de cortesía («Retiro Yoga · EVT_2026_004», «Cocina › Huerto»). Se refresca al validar. |
| `target_revision` | `bigint null` | Revisión del destino al validar (obsolescencia por comparación). |
| `allocated_quantity` | `numeric(12,3) null check (> 0)` | |
| `allocated_amount` | `numeric(12,2) not null check (> 0)` | Base (sin IVA) asignada. |
| `notes` | `text null` | |

`writable_columns`: todas salvo `invoice_id` (lo pone el trigger). Papelera normal. Índices: `(invoice_line_id)`, `(invoice_id)`, `(target_app, target_kind, target_id) where deleted_at is null`.

Invariantes (§4.3): por línea, `Σ allocated_amount ≤ net_amount + 0,02` y, si hay cantidades, `Σ allocated_quantity ≤ quantity + 0,001`.

### 2.7 `invoices.exports`

Entregas a la gestoría. **El ZIP no modifica ni cierra registros** (handoff): la entrega es un registro de qué se envió, con su manifest y hashes, para poder demostrar y detectar después qué cambió.

| Columna | Tipo | Restricciones |
|---|---|---|
| `code` | `text unique not null` | `GST_AAAA_NNN` (`core.next_code('GST', fiscal_year)`), por trigger. |
| `period_kind` | `text not null check in ('quarter','year','custom')` | |
| `fiscal_year` | `int not null` | |
| `fiscal_quarter` | `int null check (between 1 and 4)` | |
| `from_date`, `to_date` | `date not null` | |
| `folder_name` | `text not null` | `IKISAI_COMPRAS_2026_T4` (o `_2026` / `_2026_01_01_2026_02_15`). |
| `invoice_count` | `int not null` | |
| `totals` | `jsonb not null` | Resumen fiscal del conjunto (§6.4). |
| `manifest` | `jsonb not null` | §6.5. Inmutable. |
| `manifest_sha256` | `text not null` | SHA-256 del manifest canónico. |
| `status` | `text not null default 'generada' check in ('generada','entregada')` | |
| `delivered_at` | `timestamptz null` | |
| `delivered_to` | `text null` | |
| `notes` | `text null` | |

`writable_columns` (SQL): todas salvo `code`, para que `create_export` escriba por `apply_row_op`; la Edge solo deja al cliente `status, delivered_at, delivered_to, notes` y rechaza el `insert` directo. `never_purge = true`; sin borrado lógico (trigger).

### 2.8 `invoices.export_items`

| Columna | Tipo | Restricciones |
|---|---|---|
| `export_id` | `uuid not null references invoices.exports(id)` | |
| `invoice_id` | `uuid not null references invoices.invoices(id)` | `unique (export_id, invoice_id)`. |
| `invoice_code` | `text not null` | |
| `invoice_revision` | `bigint not null` | Para «entrega desfasada»: si la factura cambió después, se avisa. |
| `files` | `jsonb not null` | `[{file_id, normalized_filename, sha256, size_bytes}]` incluidos. |

`writable_columns` (SQL): todas, solo las usa `create_export`; la Edge rechaza cualquier escritura del cliente. `never_purge = true`.

### 2.9 Códigos humanos

Prefijos de Invoices: **`FVR`** (factura recibida, igual que C08) y **`GST`** (entrega a gestoría). `FVE` reservado (emitidas, fuera de V1). El año de la secuencia es el de `invoice_date`.

### 2.10 Categorías de gasto (cerradas)

`compras` · `suministros` · `mantenimiento` · `inversiones` · `canon_concesion` · `seguros` · `personal` · `fiscalidad` · `otros`. Una sola definición SQL (`invoices.expense_category_values()`) usada en los tres `check`; el dominio exporta `EXPENSE_CATEGORIES` y una prueba compara ambas.

### 2.11 Estados de factura (handoff §24A)

| Estado | Significado | Edición |
|---|---|---|
| `pendiente_datos` | Solo hay documento, fecha, proveedor y objeto (o importación incompleta). | Todo. Se pueden borrar líneas, impuestos y documentos. |
| `pendiente_revision` | Hay líneas e impuestos pero algo no cuadra (`REVISAR IMPORTES`: `|totals_delta| > 0,02`), o falta categoría, o la importación trajo avisos. `review_reason` lo explica. | Todo. |
| `validada` | Revisión humana explícita (`invoices.validate`): totales dentro de tolerancia, categoría presente, documento original presente. **Nunca se marca `validada` en silencio.** | Pago, deducibilidad, notas, asignaciones, adjuntos. Cambiar líneas, impuestos, fecha, proveedor u objeto la devuelve automáticamente a `pendiente_revision` (trigger), con `review_reason = 'EDITADA_TRAS_VALIDAR'`. |
| `archivada` | Cierre manual tras entregar el periodo a la gestoría (acción «Archivar periodo» en Gestoría). | Solo `payment_*`, `notes`, asignaciones. Lo demás → `INVOICE_ARCHIVED 409`. |
| `anulada` | Error, duplicado, abono. Se conserva fuera de resúmenes y ZIP. | Solo `notes`. |

Transiciones: `pendiente_datos ↔ pendiente_revision` (automático por contenido), `pendiente_revision → validada` (procedimiento), `validada → pendiente_revision` (automático al editar), `validada → archivada` (procedimiento `archive_period` o acción individual del owner), `archivada → validada` (owner, «desarchivar»), cualquiera → `anulada` (procedimiento con motivo). Nada vuelve de `anulada`.

### 2.12 Nombre canónico de archivo (handoff §24A «Subida y nombre»)

```text
AAAA_MM_DD_(empresa)_objeto[_NN][_pNN|_aNN].ext
2026_10_05_(makro)_alimentos_retiro_yoga.pdf
2026_10_05_(makro)_alimentos_retiro_yoga_p01.jpg     ← varias imágenes de una factura
2026_10_05_(makro)_alimentos_retiro_yoga_02.pdf      ← colisión con otra factura del mismo día, empresa y objeto
2026_10_05_(makro)_alimentos_retiro_yoga_02_p01.jpg  ← segunda factura del grupo, primera página
2026_10_05_(makro)_alimentos_retiro_yoga_a01.pdf     ← adjunto (albarán, justificante)
```

- `empresa` = `suppliers.slug`; `objeto` = `slug(invoices.object)`. `slug`: minúsculas, sin acentos (tabla ASCII propia en SQL y TS, sin depender de `unaccent`), `[^a-z0-9]+ → _`, sin `_` en los extremos, ≤ 40 caracteres.
- `ext` por `mime_type` (`pdf`, `jpg`, `png`, `webp`), nunca del nombre original.
- `_pNN` cuando la factura tiene más de un archivo `original` (orden `page_order`, dos dígitos). Un único PDF no lleva sufijo.
- `_NN` (desde `02`) distingue facturas del mismo grupo (misma fecha, empresa y objeto): es la posición de la factura por antigüedad dentro del grupo, estable aunque otra se anule. Va antes de `_pNN`. Los adjuntos (`kind = 'attachment'`) llevan `_aNN` en vez de `_pNN`. Nunca se sobrescribe.
- El nombre no es clave: `invoice_files.id` lo es. El nombre original se conserva en `original_filename`.
- Lo calcula `invoices.normalized_filename(...)` en SQL (trigger `before insert` en `invoice_files`) y, de forma idéntica, `normalizedFilename()` en `_domain/invoices` para la vista previa en el cliente; una prueba compara ambos sobre PGlite. Si cambian `invoice_date`, `object` o el proveedor **antes** de `validada`, se renombran los archivos (solo el campo; la ruta en Storage, que la decide `core.file_create`, no cambia). Después de `validada` no se renombra.

---

## 3. Procedimientos (`call`)

`security definer`, solo `service_role`, registrados con `core.allow_procedure('invoices', …)`, y escriben **solo** vía `core.apply_row_op(app, actor, role, requestId, cursor, op)`. Reciben `{app, actor, role, requestId, cursor, args}`.

### 3.1 `invoices.import_v1(p jsonb)`

Importación transaccional del JSON `ikisai.invoice.v1` (`03_IKISAI_INVOICE_IMPORT_V1.schema.json`, reproducido en `_domain/invoices/import-v1.schema.ts` y validado también en SQL). «Un JSON inválido no sustituye datos válidos existentes»: todo o nada.

**`args`**

```json
{
  "document": { "schema_version": "ikisai.invoice.v1", "invoice": {}, "lines": [], "taxes": [], "document_totals": {}, "extraction_notes": null, "overall_confidence": 0.98 },
  "document_sha256": "hex64",
  "invoice_id": "uuid",
  "ids": { "lines": ["uuid"], "tax_lines": ["uuid"], "supplier": "uuid|null", "files": ["uuid"] },
  "supplier": { "mode": "existing|create", "id": "uuid|null", "slug": "makro|null" },
  "invoice": { "object": "alimentos retiro yoga|null", "invoice_date": "2026-10-05|null", "expense_category": "compras|null", "is_investment": false, "deductibility": "pendiente_revision|null", "notes": null },
  "files": [ { "file_id": "uuid", "original_filename": "p1.jpg", "page_order": 1 } ]
}
```

- `invoice_id`: nuevo (uuid del cliente) **o** una factura existente en `pendiente_datos` sin líneas (flujo del handoff: primero se sube el documento con fecha, proveedor y objeto; después se importa el JSON sobre esa factura; `POST invoices/:id/import`).
- `invoice.*` son los valores que el usuario confirmó en la vista previa; si vienen nulos se toman del documento (`invoice.object` del JSON, `invoice_date`, `deductibility_suggestion`) o del proveedor (`default_category`, `default_is_investment`) o del defecto (`pendiente_revision`, `false`).
- `files`: opcional; la Edge ya los ha comprobado (§4.1). Los `file_id` llegan resueltos por el `sync-client` desde marcadores `{"$blob": sha}`.

**Documento `ikisai.invoice.v1`** (exactamente el schema del handoff; resumen):

```text
schema_version: "ikisai.invoice.v1"
invoice: { invoice_date (date, req), supplier_name (req), supplier_tax_id?, invoice_number?, object (req), currency (req, 'EUR'), deductibility_suggestion? ∈ si|no|parcial|pendiente_revision, notes? }
lines[1..]: { description (req), quantity?, unit?, unit_price?, discount_amount?, net_amount (req), vat_rate?, vat_amount?, gross_amount?, suggested_item_type? ∈ food_ingredient|equipment|material|service|other, suggested_match_name?, confidence? ∈ [0,1], notes? }
taxes[]: { tax_type (req) ∈ iva|irpf|otra_retencion|otro, rate?, taxable_base?, amount (req, ≥ 0), notes? }
document_totals: { base, vat, withholding, total }  (req)   ·   total = base + vat − withholding
extraction_notes?, overall_confidence? ∈ [0,1]
additionalProperties: false en todos los objetos.
```

**Pasos (una transacción):**

1. **Esquema.** Validación estricta contra el schema (claves desconocidas → error). `currency = 'EUR'`. Error → `IMPORT_INVALID 422 {path, reason}`.
2. **Factura destino.** Si `invoice_id` existe: debe estar en `pendiente_datos`, sin líneas ni impuestos vivos, `source = 'manual'` → si no, `INVOICE_NOT_IMPORTABLE 409`. Si no existe, se insertará.
3. **Proveedor.** `existing` → fila viva; `create` → `insert` en `suppliers` con `ids.supplier`, `name = supplier_name`, `tax_id`, `slug` (dado o derivado), `aliases = []`. NIF ya en uso → `SUPPLIER_TAX_ID_EXISTS 409 {supplier_id}`. Si el proveedor existe y `supplier_name` del JSON no coincide con `name` ni con `aliases`, se añade a `aliases` (`update`).
4. **Duplicados.** Misma `(supplier_id, lower(invoice_number))` viva no anulada → `DUPLICATE_INVOICE 409 {invoice_id, code}` (solo si `invoice_number` no es nulo). Mismo `import_sha256` → `DUPLICATE_IMPORT 409`. Un `file.sha256` ya presente en otra factura viva → aviso (no bloquea).
5. **Recalculo** (misma función en TS y SQL, `recalculate(lines, taxes)`):
   - por línea: si `quantity` y `unit_price` no son nulos, `expected_net = round(q × p, 2) − discount_amount`; si `|expected_net − net_amount| > 0,02` → aviso `LINE_NET_MISMATCH` (no bloquea: el documento puede traer precios redondeados); si `vat_rate` y `vat_amount` no son nulos, `|round(net × rate/100, 2) − vat_amount| > 0,02` → aviso `LINE_VAT_MISMATCH`;
   - `calculated_base = Σ taxes.taxable_base (iva|otro)` si hay impuestos con base, si no `Σ lines.net_amount`;
   - `calculated_vat = Σ taxes.amount (iva)`; si no hay `taxes` se construyen desde las líneas agrupando por `vat_rate`;
   - `calculated_withholding = Σ taxes.amount (irpf|otra_retencion)`;
   - `calculated_total = base + vat − withholding`;
   - comprobaciones cruzadas con `document_totals`: `|Σ lines.net_amount − base| > 0,02` → aviso `LINES_VS_BASE`; `|calculated_total − document_totals.total| > 0,02` → **`REVISAR IMPORTES`**.
6. **Estado.** Dentro de tolerancia y con categoría → `pendiente_revision` con `review_reason = 'IMPORTADA'` (la validación es siempre humana: handoff «No marcar como validada sin revisión explícita»). Fuera de tolerancia → `pendiente_revision` con `review_reason = 'REVISAR IMPORTES'` y `totals_delta`. Nunca `validada`.
7. **Inserción** vía `apply_row_op`: `invoices` (`insert` o `update` de la existente; `source = 'import_v1'`, `import_sha256`, `source_total = document_totals.total`, `calculated_*`, `totals_delta`, `import_meta`), `invoice_lines` (orden del JSON, `item_type`, `match_name`, `confidence`), `tax_lines`, `invoice_files` para cada archivo (`kind = 'original'`).
8. **Resultado**: `{invoice_id, code, status, review_reason, supplier_id, normalized_filenames[], recalculation:{calculated_base, calculated_vat, calculated_other, calculated_withholding, calculated_total, source_total, delta, within_tolerance}, warnings[]}`.

### 3.2 `invoices.validate(p jsonb)`

Paso explícito `pendiente_revision → validada`. `args = {invoice_id, expectedRevision}`. Recalcula en servidor; exige `|totals_delta| ≤ 0,02` o `source_total is null`, `expense_category` presente, al menos un `invoice_files` vivo `original`, al menos una `tax_line` o una línea. Errores: `INVOICE_INCOMPLETE 422 {missing:[…]}`, `INVOICE_TOTALS_MISMATCH 422 {delta}`. El usuario puede, en la UI, corregir `source_total` o las líneas antes de reintentar; no hay «forzar».

### 3.3 `invoices.annul(p jsonb)`

`args = {invoice_id, expectedRevision, reason}` → `status = 'anulada'`, `annulled_reason`; borra lógicamente las `allocations` vivas de sus líneas. Devuelve la factura y la lista de entregas que la incluían (para avisar «la entrega GST_… queda desfasada»).

### 3.4 `invoices.create_export(p jsonb)`

`args = {export_id, period_kind, fiscal_year, fiscal_quarter?, from_date?, to_date?}`. Selecciona facturas `validada|archivada` con `invoice_date` en el rango; genera `manifest`, `totals` (§6.4) y `folder_name`; inserta `exports` y `export_items`. **No cambia el estado de ninguna factura.** Si hay facturas `pendiente_*` en el rango → se incluyen en `manifest.excluded[]` con su motivo y se devuelven como `warnings` (no bloquea: la gestoría puede recibir lo validado y el resto en la siguiente). Sin facturas → `EXPORT_EMPTY 422`. Devuelve `{export_id, code, folder_name, invoice_count, manifest_sha256, warnings}`. Rol `editor`.

### 3.5 `invoices.archive_period(p jsonb)`

`args = {fiscal_year, fiscal_quarter, export_id}`: pasa a `archivada` todas las `validada` del periodo que estén incluidas en la entrega indicada (y esta debe estar `entregada`). Solo `owner`. Devuelve `{archived: n}`. La acción individual «archivar / desarchivar» es un `update` normal de `status` que el trigger permite solo a `owner` (lee `core.memberships`, permitido por el lint).

### 3.6 `invoices.mark_delivered(p jsonb)`

`args = {export_id, expectedRevision, delivered_to}` → `status = 'entregada'`, `delivered_at = now()`. (Equivale a un `update`; se mantiene como `call` para nombrar la transición en el historial.)

---

## 4. Hooks de validación

### 4.1 `beforeCommit` (Edge, con `_domain/invoices`)

- **Tipos, obligatorios y listas cerradas** de cada tabla con los validadores del dominio (los mismos que usa el cliente). Mensajes en español con `field`.
- `invoices.invoices`: `delete` → `INVOICE_NOT_DELETABLE 422` (usar `annul`); `status` a `validada`/`anulada` por `update` directo → `INVALID_TRANSITION 422` (son procedimientos); `import_meta` en `insert`/`update` directos → `INVALID_FIELDS`; `paid_at` obligatorio con `pagada`; `calculated_*`/`totals_delta` se recalculan en SQL (§4.3), aquí solo se comprueba el tipo.
- `invoices.invoice_files`: `insert` → `core_file_get(file_id)`: `app = 'invoices'`, `status = 'verified'`, MIME admitido; sobrescribe `mime_type`, `size_bytes`, `sha256` en `fields`. Un `file_id` ya referenciado por otra factura viva → se permite pero se devuelve `warnings: [DUPLICATE_FILE]` en el resultado (la Edge lo añade al `CommitResult`).
- `invoices.allocations`: pares `target_app`/`target_kind`; `target_id` obligatorio salvo `general`; **`tasks` → validación con el token del usuario** (`ctx.token`, §7.2): existe y es visible → rellena `target_label`, `target_code`, `target_revision`; 404 → `TARGET_NOT_FOUND 422`; 403 → `TARGET_FORBIDDEN 422`; red/5xx → `TARGET_UNAVAILABLE 503` (el lote se queda en la cola y se reintenta). `booking`/`food` → `TARGET_APP_NOT_AVAILABLE 422` hasta que existan sus proyecciones (bandera por app en la Edge; fase 2).
- `call invoices.import_v1`: valida el documento con el schema TS antes de SQL; valida cada `file` como arriba.
- `call invoices.create_export` / `archive_period`: roles y rangos.

### 4.2 Triggers (`invoices.*`)

- `assign_code` (`before insert` en `invoices`, `exports`): `code` si nulo.
- `set_normalized_filename` (`before insert` en `invoice_files`; `after update` de `invoice_date|object|supplier_id` en `invoices` mientras no esté `validada`): §2.12.
- `guard_invoice` (`before update` en `invoices`): `deleted_at` → `INVOICE_NOT_DELETABLE`; `anulada` y cambia algo distinto de `notes` → `INVOICE_ANNULLED 409`; `archivada` y cambia algo fuera de `{payment_status, payment_method, paid_at, notes, status}` → `INVOICE_ARCHIVED 409`; `status` → `archivada` o desde `archivada` por alguien que no es `owner` (`core.memberships`) → `FORBIDDEN`; `anulada` sin motivo → `ANNUL_REASON_REQUIRED`; `pagada` sin `paid_at` → `PAID_AT_REQUIRED`; `validada` y cambian `invoice_date|object|supplier_id|invoice_number|source_total|expense_category|is_investment` → `status := 'pendiente_revision'`, `review_reason := 'EDITADA_TRAS_VALIDAR'`.
- `guard_child` (`before insert or update` en `invoice_lines`, `tax_lines`, `invoice_files`): la factura no está `anulada|archivada` (→ `INVOICE_LOCKED 409`; excepción: `invoice_files.kind = 'attachment'`); si está `validada`, la toca y la devuelve a `pendiente_revision` (`EDITADA_TRAS_VALIDAR`); borrado lógico de `invoice_files` o `invoice_lines` solo con factura `pendiente_*` → `INVOICE_FILE_LOCKED 422` / `INVOICE_LINE_LOCKED 422`.
- `fill_allocation` (`before insert or update` en `allocations`): `invoice_id := línea.invoice_id`; la factura no está `anulada`.
- `guard_export` (`before update` en `exports`): `deleted_at` → `EXPORT_NOT_DELETABLE`; periodo, `manifest`, `totals`, `invoice_count` inmutables → `EXPORT_IMMUTABLE 409`.
- `check` de pares en `allocations` (§2.6).

### 4.3 `validate_hooks` SQL: `invoices.check_invariants(p jsonb)`

Registrado con `core.add_validate_hook`. Al final de cada lote, sobre las facturas tocadas en la transacción (filas propias o hijas con `updated_at = now()`; `core.touch_revision` usa `now()`, constante en la transacción; también puede leer `core.changes` del cursor actual, permitido por el lint):

1. **Recalcula y escribe** `calculated_base`, `calculated_vat`, `calculated_other`, `calculated_withholding`, `calculated_total`, `totals_delta` con `invoices.recalculate()` en SQL (misma definición que TS). Si algo difiere de lo que mandó el cliente, el hook lo corrige **con `core.apply_row_op`** dentro del mismo lote: el cambio queda en `core.changes` y llega al cliente en la respuesta del commit (`changes`). Lo mismo vale para los estados automáticos y el renombrado de archivos: ningún trigger escribe filas derivadas. Si `|totals_delta| > 0,02` y la factura está `pendiente_revision` sin `review_reason`, pone `REVISAR IMPORTES`.
2. Si `status = 'validada'`: `|totals_delta| ≤ 0,02` o `source_total is null`; `expense_category` no nulo; un `original` vivo → si falla, `INVOICE_INVALID_STATE 422 {invoice_id, reason}` (solo puede pasar si alguien salta la Edge).
3. Asignaciones: por línea viva, `Σ allocated_amount ≤ net_amount + 0,02` → `ALLOCATIONS_EXCEED_LINE 422 {line_id, allocated, net_amount}`; `Σ allocated_quantity ≤ quantity + 0,001` cuando ambas existen → `ALLOCATIONS_EXCEED_QUANTITY 422`.
4. `tax_lines` vivas: `amount ≥ 0`; `(tax_type, rate)` sin duplicar → `TAX_LINE_DUPLICATE 422`.

Errores con `core.fail(code, 422, details)`; la Edge los devuelve como `{error:{code,message,details}}`.

---

### 4.4 Agentes de IA (contrato §3.1, migración 0202)

Un agente (clave `ika_`, rol `editor`) trabaja con las mismas rutas y reglas que una persona; lo que cambia es cuándo su lote necesita la aprobación de un owner humano (propuesta de 24 h).

- **Seguro sin aprobación:** solo `invoices.import_v1`. Crea o completa una factura en `pendiente_revision` y nunca la valida, así que una persona siempre revisa lo importado.
- **Con aprobación (por defecto):** `invoices.validate`, `invoices.annul`, `invoices.create_export`, `invoices.mark_delivered`, `invoices.archive_period`, cualquier borrado y cualquier lote de **10 o más elementos** (filas distintas más importaciones; decisión del usuario).
- **Hook `agentRisk`** (`createAgentRisk` en `invoices-api/app.ts`, lectura `invoices.agent_risk` para editor y owner):
  - tocar una factura que ya está en una entrega a la gestoría, o sus artículos, impuestos, documentos o asignaciones → motivo `invoice:exported:<código>` (`invoice:delivered:<código>` si la entrega está marcada entregada);
  - cambiar una factura validada o archivada, o sus artículos, impuestos o documentos → `invoice:validada:<código>` / `invoice:archivada:<código>`. Asignar destinos a una factura validada no cambia sus datos fiscales y no pide aprobación.
- `imports/extract` no pasa por el riesgo (no escribe): un agente puede pedir extracciones y cada una cuesta tokens.

## 5. Visibilidad

Sin ámbitos: `memberships.scopes = null`, sin hook `visible`. La visibilidad es la membresía.

---

## 6. Rutas propias (`/api/v1/...`)

Las del núcleo las da `_kit`. Las escrituras van siempre por `POST commands` (filas o `call`), nunca por rutas propias, para que el cliente offline las encole igual. Las lecturas compuestas se registran con `core.allow_read('invoices', 'invoices.<fn>', 'function')` y se sirven por `GET/POST read/invoices.<fn>`; además, el dominio TS calcula lo mismo sobre el espejo local para que funcionen sin red.

| Método y ruta | Entrada | Salida | Rol |
|---|---|---|---|
| `GET dashboard` | — | `{cursor, counts:{pendiente_datos, pendiente_revision, sin_asignar, sin_pagar, sin_documento}, current_period:{year, quarter, totals}, last_export}` | reader |
| `POST imports/preview` | `{document, invoice_id?, supplier?, invoice?}` | Sin escribir: `{document_sha256, valid, errors[], supplier_matches:[{id,name,tax_id,slug,score,by:'tax_id'|'alias'|'name'}], duplicate:{invoice_id,code}|null, recalculation, proposed:{object, invoice_date, expense_category, is_investment, deductibility, status, review_reason}, normalized_filename_preview, warnings[]}` | editor |
| `POST imports/extract` | `{file_ids: [uuid, …]}` (1–8 documentos verificados de la misma factura) | **Extracción automática (V2).** La Edge pasa los documentos ya subidos y el prompt de extracción al helper de `_kit/extract.ts` (`createDocumentExtractorFromEnv`: OpenAI si existe el secreto `OPENAI_API_KEY`, decisión del usuario; si no, Anthropic con `ANTHROPIC_API_KEY`; los carga Core) junto con el JSON Schema del handoff (`IMPORT_JSON_SCHEMA`, salida estructurada del proveedor) y el prompt sin prosa (`EXTRACTION_PROMPT_STRUCTURED`: las ambigüedades van en `extraction_notes`), y devuelve `{document, document_sha256, warnings[], usage}` con el documento **validado contra el schema** `ikisai.invoice.v1`. `usage` es `{model, inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens, latencyMs}` y la app lo muestra como coste de la extracción. No escribe nada: el cliente lleva el resultado a la misma vista previa de importación y el usuario confirma. Errores: `EXTRACTION_UNAVAILABLE 503` (sin helper, sin clave o el proveedor no responde: la app ofrece pegar el JSON de ChatGPT), `EXTRACTION_INVALID 422 {errors, warnings}` (el modelo devolvió algo que no cumple el formato), `INVALID_FILE 422` (documento no verificado o de otra app), `INVALID_OPERATION 422` (ids). | editor |
| `GET targets/tasks?q=&kind=` | búsqueda | Proxy a Tareas con `ctx.token` (§7.2): `{items:[{kind:'area'|'project'|'task', id, code?, label, path:['Área','Proyecto'], revision, archived}]}` | editor |
| `GET targets/tasks/:kind/:id` | — | `{kind, id, code?, label, path, revision, archived}` o `TARGET_NOT_FOUND 404` | reader |
| `GET targets/booking?q=` · `GET targets/food?q=` | — | Fase 2 (`read/booking.food_event_projection`, proyección de Food). V1: `TARGET_APP_NOT_AVAILABLE 422`. | reader |
| `GET read/invoices.items?…` | `where[...]`, `from`, `to`, `supplier_id`, `expense_category`, `target_app`, `target_id`, `unassigned=1`, `limit`, `offset` | **Compras** (§6.3): líneas de facturas no anuladas con su factura, proveedor y asignaciones. | reader |
| `GET read/invoices.fiscal_summary?year=&quarter=` (o `from`/`to`) | — | §6.4 | reader |
| `GET read/invoices.export_bundle` `{export_id}` | — | Para la Edge y la app: entrega sin manifest, `manifest_text` (exactamente lo que se hasheó), `files[]` con bucket y ruta en Storage, `stale` (entrega desfasada). | reader |
| `GET read/invoices.export_preview` | `{period_kind, fiscal_year, fiscal_quarter?, from_date?, to_date?}` | Vista previa de la entrega sin crearla: carpeta, recuento, excluidas y motivo, totales. | editor |
| `GET exports/:id/manifest.json` · `GET exports/:id/:name.csv` | — | Archivos de la entrega, regenerados desde `manifest` (`Content-Disposition: attachment`). `manifest.json` se sirve byte a byte como `manifest_text`. | reader |
| `GET exports/:id/download` | — | **ZIP en streaming** (§6.5), nombre `IKISAI_COMPRAS_2026_T4.zip`. `EXPORT_FILE_MISSING 409 {file_id}` si un documento ya no está en Storage. | reader |
| `POST exports/accountant` | `{period_kind, fiscal_year, fiscal_quarter?, from_date?, to_date?}` | Atajo del handoff: alias de `read/invoices.export_preview`; la creación va por `call create_export`. | editor |

### 6.1 Flujo de subida e importación (handoff «Subida y nombre» + «Importación desde ChatGPT»)

1. **Subir**: el usuario elige PDF o fotos y la app pide **fecha, proveedor y objeto**. Se crea la factura (`insert invoices` en `pendiente_datos`, `source = 'manual'`) y los `invoice_files` con marcadores `{"$blob": sha}` en un mismo lote. La vista previa del nombre canónico se calcula en el cliente. Sin red todo queda en cola.
2. **Pasar el documento a ChatGPT** fuera de la app (prompt del handoff). Volver con el JSON.
3. **Importar**: en la ficha, «Importar JSON» → pegar o cargar → validación local contra el schema → `imports/preview` si hay red → **vista previa**: proveedor emparejado (NIF, alias, nombre) o nuevo; fecha/objeto del JSON vs los tecleados; tabla de líneas; impuestos; **recalculo** (base, IVA, retenciones, total calculados vs documentales, delta en ámbar si ≤ 0,02 y en rojo con «REVISAR IMPORTES» si mayor); avisos de extracción; categoría e inversión propuestas.
4. **Confirmar** → la app genera las **operaciones de fila** equivalentes (`importOperations` del dominio: proveedor nuevo o alias, factura con `source = 'import_v1'`, `import_sha256`, `source_total`, `review_reason`, totales recalculados, líneas, impuestos y documentos) y las encola con `commit`. Así la factura aparece en el espejo al momento y la importación funciona sin red; el hook `check_invariants` del servidor recalcula y fija el estado, y los duplicados los paran los índices únicos (el lote pasa a Rechazados con el mensaje). `import_meta` solo lo escribe el procedimiento `invoices.import_v1`, que queda para la API (agentes, pruebas) y para la extracción desde la Edge en V2. La factura queda `pendiente_revision`.
5. **Revisar y validar**: en la ficha, corregir lo que haga falta y pulsar «Validar» → `call invoices.validate`. Solo entonces `validada` («✓ Importes comprobados»).

También se puede importar sin haber subido antes (paso 1 y 3 juntos): el mismo `call` crea la factura y los archivos.

### 6.2 Destinos de Tareas

Desde una línea: «Asignar a…» → `general` (sin asignar / gasto de explotación / inversión), `Tasks` → buscador **Área → Proyecto → Tarea** (`targets/tasks`, con los últimos destinos usados en caché local), importe (por defecto lo que queda sin asignar de la línea) y cantidad opcional. Sin red: solo destinos cacheados o `general`; la validación real ocurre en `beforeCommit`. Si falla, el lote pasa a **rechazados** (`sync-client` 0.2 `rejected()`), la UI lo muestra con «cambiar destino» (reencola corregido con `retryRejected`) o «descartar».

### 6.3 Compras (`invoices.items`)

Unidad: la **línea** (artículo comprado). Por fila: factura (código, fecha, proveedor, estado), descripción, `item_type`, `match_name`, cantidad y unidad, `net_amount`, IVA, categoría efectiva (línea → factura), inversión efectiva, asignado (`Σ allocated_amount`), sin asignar, destinos (chips). Filtros del handoff: fecha, proveedor, categoría, destino (`target_app`/`target_id`), retiro (`booking` + `event`), ingrediente (`food` + `ingredient`), **sin asignar**; además inversión y `item_type`. Agrupaciones: por categoría, por destino, por proveedor, por `item_type`. Filtros en la app: destino (retiro = `booking/event`, ingrediente = `food/ingredient`, maquinaria, proyecto, tarea, área, generales), tipo de artículo y «solo sin asignar». Totales del filtro (base). Solo facturas no `anulada`; las `pendiente_*` se incluyen marcadas (el handoff dice «líneas validadas»; se muestran las demás atenuadas con filtro «solo validadas» activado por defecto).

### 6.4 Resumen fiscal (`invoices.fiscal_summary`)

```json
{
  "range": { "kind": "quarter", "year": 2026, "quarter": 4, "from": "2026-10-01", "to": "2026-12-31" },
  "invoices": { "validada": 40, "archivada": 0, "pendiente_datos": 1, "pendiente_revision": 2, "anulada": 1 },
  "base": 2150.00, "vat": 332.00, "withholding": 15.00, "total": 2467.00,
  "vat_by_rate": [ { "rate": 21, "base": 1200.00, "amount": 252.00 }, { "rate": 10, "base": 800.00, "amount": 80.00 }, { "rate": 0, "base": 150.00, "amount": 0 } ],
  "withholdings_by_type": [ { "tax_type": "irpf", "rate": 15, "base": 100.00, "amount": 15.00 } ],
  "by_category": [ { "expense_category": "compras", "is_investment": false, "base": 1500.00, "vat": 150.00, "total": 1650.00, "count": 20 } ],
  "investment": { "base": 500.00, "total": 605.00, "count": 2 }, "operating": { "base": 1650.00, "total": 1862.00, "count": 38 },
  "deductibility": { "si": 2000.00, "no": 50.00, "parcial": 0, "pendiente_revision": 100.00 },
  "alerts": { "pending_invoices": [ {"id":"…","code":"FVR_2026_041","status":"pendiente_revision","review_reason":"REVISAR IMPORTES"} ], "discrepancies": [ {"id":"…","code":"…","totals_delta": 0.50} ], "deductibility_unreviewed": 3, "missing_file": 0, "unpaid_overdue": 2 }
}
```

Base, IVA, retenciones y total solo de `validada|archivada`; las demás se cuentan y van en `alerts`. Agrupación de IVA por tasa (handoff). Es un resumen documental, no una declaración.

### 6.5 ZIP de gestoría (handoff «ZIP gestoría»)

`invoices.create_export` congela `manifest` y `totals`; `GET exports/:id/download` genera el ZIP **bajo demanda y en streaming** (`npm:fflate`, `Zip` + `ZipPassThrough` sin compresión para PDF e imágenes; los CSV y JSON se generan desde `manifest`). No se guarda el ZIP (columna reservada `zip_file_id` si algún día conviene archivarlo).

```text
IKISAI_COMPRAS_2026_T4/
├── facturas/
│   ├── 2026_10_05_(makro)_alimentos_retiro_yoga.pdf
│   ├── 2026_10_07_(iberdrola)_luz_octubre_p01.jpg
│   ├── 2026_10_07_(iberdrola)_luz_octubre_p02.jpg
│   └── ...
├── facturas_recibidas.csv      codigo;fecha;proveedor;nif;numero;objeto;categoria;inversion;deducibilidad;base;iva;retenciones;total;total_documento;delta;estado;pago;fecha_pago;archivos
├── lineas_compra.csv           codigo_factura;fecha;proveedor;posicion;descripcion;tipo_articulo;cantidad;unidad;precio_unitario;descuento;base;iva_tipo;iva_importe;total_linea;categoria;inversion;asignaciones
├── resumen_impuestos.csv       tipo;tasa;base;importe   (IVA por tasa, retenciones por tipo, totales)
└── manifest.json
```

CSV: separador `;`, UTF-8 con BOM, decimales con coma (Excel en español), fechas `AAAA-MM-DD`. `manifest.json` (claves ordenadas; su SHA-256 es `exports.manifest_sha256`):

```json
{
  "schema": "ikisai.invoices.export.v1",
  "export": { "code": "GST_2026_002", "folder": "IKISAI_COMPRAS_2026_T4", "range": {}, "created_at": "…", "created_by": "nombre visible", "app_release": "v0.2.0" },
  "invoice_count": 41, "file_count": 43,
  "totals": { "…": "§6.4" },
  "invoices": [ { "code": "FVR_2026_001", "revision": 4, "supplier": {"name":"…","tax_id":"…"}, "invoice_number": "…", "invoice_date": "2026-10-05", "object": "…", "expense_category": "…", "is_investment": false, "deductibility": "si", "base": 100.00, "vat": 10.00, "withholding": 0, "total": 110.00, "source_total": 110.00, "status": "validada", "files": [ { "name": "facturas/2026_10_05_(makro)_alimentos_retiro_yoga.pdf", "sha256": "hex64", "size_bytes": 83211, "mime_type": "application/pdf", "page_order": 1 } ] } ],
  "excluded": [ { "code": "FVR_2026_041", "status": "pendiente_revision", "reason": "REVISAR IMPORTES" } ],
  "integrity": { "algorithm": "sha256", "files": "SHA-256 de cada archivo incluido, verificado por el servidor al subirlo" }
}
```

El cliente puede verificar los hashes del ZIP descargado con Web Crypto («entrega íntegra»). «Entrega desfasada»: alguna factura incluida tiene hoy `revision > export_items.invoice_revision` o está `anulada`, o hay facturas validadas del rango que no estaban → Gestoría lo muestra y ofrece «Generar entrega nueva».

---

**Registro y límite de los agentes (migración 0204, decisión del usuario).** Cada extracción deja una fila por documento en `invoices.extractions` (`file_id`, `invoice_id`, `outcome` `ok`/`invalida`, `model`, `input_tokens`, `output_tokens`, `latency_ms`; el coste va en la primera fila) con quien la pidió en `updated_by`. Solo la escribe la Edge y no se copia al móvil. Una persona extrae sin límite. Un agente extrae **una vez por documento de una factura pendiente**; si el documento ya se extrajo, o es de una factura que ya no está en `pendiente_datos`, la ruta responde `428 CONFIRMATION_REQUIRED` con motivo `extract:repeat:<código o file_id>` o `extract:not_pending:<código>`. Para repetir, el agente prepara una propuesta con una inserción `{op: 'insert', table: 'invoices.extractions', fields: {file_id}}` por documento; cuando un owner humano la aprueba, vuelve a llamar con `confirmationId`. La Edge consume la propuesta (una sola vez) y completa esas filas con el resultado.

### 6.6 MCP (contrato §3.2)

`POST /api/v1/mcp` ofrece las herramientas genéricas del núcleo (`invoices_snapshot`, `invoices_commit`, `invoices_prepare_batch`…) y tres de dominio (`invoicesMcpTools` en `invoices-api/app.ts`). Todas pasan por el mismo camino que la API: hooks, riesgo de agente (§4.4) y propuestas.

| Herramienta | Rol | Qué hace |
|---|---|---|
| `invoices_import_json` | editor | Importa un JSON `ikisai.invoice.v1`: valida, empareja el proveedor (NIF, alias o nombre; si no, lo crea) y llama a `invoices.import_v1`. La factura queda en `pendiente_revision`, nunca validada. Opcional: `invoice_id` (factura en `pendiente_datos`), `supplier_id`, `file_ids` ya subidos. Ids estables a partir del hash del JSON: reintentar devuelve `replayed`. Errores como resultado `isError`: `IMPORT_INVALID`, `DUPLICATE_IMPORT`, `DUPLICATE_INVOICE`. |
| `invoices_purchases` | reader | Lectura `invoices.items` de un periodo (`year` + `quarter`/`month`, o `from`/`to`) con filtros de destino y `validated_only`. |
| `invoices_fiscal_summary` | reader | Lectura `invoices.fiscal_summary` de un periodo. |

## 7. Proyecciones y enlaces

### 7.1 Lo que publica Invoices (fase 2)

Registradas con `core.allow_read('booking', …)` / `core.allow_read('food', …)` por la migración de Invoices:

- `invoices.booking_cost_projection` (`allocation_id, target_kind, target_id, invoice_code, invoice_date, supplier_name, expense_category, is_investment, allocated_amount, allocation_revision`): coste asignado por reserva o evento, para «coste real por retiro».
- `invoices.food_stock_projection` (`allocation_id, target_kind, target_id, invoice_code, invoice_date, supplier_name, line_description, match_name, allocated_quantity, unit, allocated_amount, allocation_revision, unit_normalized, quantity_normalized`; las dos últimas desde la migración 0203: `unit_normalized` es `kg`, `l` o `ud` según `invoices.normalize_unit(unit)` —g, ml y cl se convierten— y `quantity_normalized` la cantidad asignada en esa unidad, ambas null si la unidad del documento no se reconoce): entradas de stock (ingrediente, cantidad, unidad, fecha, coste, proveedor) para Food.

Sin datos personales ni notas. Solo asignaciones vivas de facturas no anuladas.

### 7.2 Destinos que consume

| `target_app` | `target_kind` | Validación | Fase |
|---|---|---|---|
| `general` | `unassigned`, `operating_expense`, `investment` | Ninguna. | V1 |
| `tasks` | `area`, `project`, `task` | API de Tareas con `ctx.token`: hasta que Tasks publique la lectura `tasks.targets`, la Edge usa `GET {TASKS_API}/api/v1/snapshot?tables=tasks.tabs,tasks.projects,tasks.tasks` con el bearer del usuario (devuelve solo lo visible para él), busca el id y construye `label`/`path`/`revision`; después, `GET read/tasks.targets`. `TASKS_API` = `https://tasks.ikisai.com` (o la función `tasks-api` directa en QA), configurable por variable de entorno. | V1 |
| `booking` | `event` (`reservation` cuando la proyección exponga el id de la reserva) | `GET read/booking.food_event_projection` (contrato §8), registrada para `invoices` por Booking en la migración 0402 (PR #80). La Edge resuelve `event_id` y devuelve `title · start_date`, `event_code` y `event_revision`. | V1 (desde la 0402) |
| `food` | `ingredient`, `equipment` | Proyección a pedir a Food (`food.invoices_catalog_projection`: `kind, id, name, unit, revision`). | Fase 2 |

Si una proyección no está registrada todavía, la Edge responde `TARGET_APP_NOT_AVAILABLE` y la app lo muestra en el buscador sin bloquear Invoices (handoff §31A).

### 7.3 Obsolescencia

Sin flags. La UI compara `target_revision` con la revisión actual del destino al abrir Compras o la ficha con red, en segundo plano; «destino cambiado» / «destino desaparecido» con «revisar» o «pasar a general».

---

## 8. Archivos

- **Bucket** `purchase-documents` (privado; 52 428 800 bytes). MIME: PDF, WebP, JPEG, PNG.
- **Ruta** la decide `core.file_create` (`invoices/<año>/<file_id>/<nombre_seguro>`); el nombre canónico vive en `invoice_files.normalized_filename` y es el que se usa en el ZIP. (El handoff proponía `invoices/<year>/<invoice_uuid>/…`; con `core.files` la ruta es del núcleo y no se discute.)
- **PDF** tal cual; aviso informativo por encima de 20 MB. **Fotos** recomprimidas en cliente (lado mayor 1600 px, WebP calidad media, sin original). Varias fotos = varios `invoice_files` `original` con `page_order` → `_p01`, `_p02`.
- **Flujo**: `stageBlob` → marcador `{"$blob": sha}` en `fields.file_id`/`args.files[].file_id` → `sync-client` sube, verifica y sustituye antes de enviar. La Edge copia `sha256/size/mime` desde `core.files`.
- **Duplicados binarios** (`uploads.duplicateOf` o mismo `sha256` en `invoice_files`): aviso «este documento ya está en FVR_…»; no bloquea.
- **Lectura**: `GET files/:id` (URL firmada 10 min). Visor PDF embebido en escritorio; en móvil, visor del sistema. Miniaturas de fotos cacheadas en IndexedDB `blobs`.
- Tablas que referencian `core.files`: `invoice_files.file_id` (FK), `exports.zip_file_id` (reservada).

---

## 9. Pantallas y navegación

**Inicio · Facturas · Compras · Gestoría** (ya en `apps/invoices/src/ui/shell.ts` con `@ikisai/ui-kit`). Proveedores, Conflictos y Rechazados cuelgan de Inicio. Modo lectura primero, estado antes que formulario, sin paneles decorativos. 390 px y 1440 px.

### 9.1 Inicio

Saludo, barra de estado del kit. Tarjetas de estado con número y acción: **Pendientes de datos**, **Pendientes de revisión** (con cuántas son `REVISAR IMPORTES`), **Sin asignar** (líneas con base sin destino), **Sin pagar** (vencidas primero). Tarjeta **trimestre en curso** (base, IVA soportado, nº facturas, «Preparar entrega»). Accesos: Proveedores, Conflictos, Rechazados, instalación. Botón flotante **«Nueva factura»** → hoja: «Subir documento» (fecha, proveedor, objeto, archivos) · «Importar JSON».

### 9.2 Facturas

Lista por `invoice_date desc` agrupada por mes; fila: nombre canónico corto o `objeto`, proveedor, fecha, total, chips (`pendiente_datos`, `REVISAR IMPORTES`, `validada` ✓, `archivada`, `anulada`, `pagada`, `sin documento`, `pendiente de sincronizar`). Buscador y filtros plegables. Sección plegable **Anuladas**.

**Ficha** (hoja completa en móvil, panel en escritorio), según la «ficha visual» del handoff:

```text
2026_10_05_(makro)_alimentos_retiro_yoga          FVR_2026_012 · pendiente de revisión
Makro · 05/10/2026 · Factura nº A-2026-0457
[ Ver original ]  [ Importar JSON ]  [ Validar ]
Base 100,00 · IVA 10,00 · IRPF 0,00 · TOTAL 110,00 (documento 110,00)   ✓ Importes comprobados | ⚠ REVISAR IMPORTES (delta 0,50)
ARTÍCULOS  Tomate 20 kg · 40,00 · IVA 10 → Food/Tomate (pendiente fase 2) · Booking/Retiro Yoga (…)
ASIGNACIÓN por línea con barra asignado / sin asignar
```

Bloques plegables: Documento (visor, páginas, añadir), Artículos (edición en sitio; con dos o más y permiso de edición, lista reordenable del kit —`createSortableList`, flechas y arrastre— que guarda `position` renumerando 0..n-1: decisión del usuario «orden manual»), Impuestos, Asignación, Pago, Fiscal (categoría, inversión, deducibilidad, periodo derivado), Importación (confianza, notas de extracción, recalculo), Historial. Acciones: Validar, Anular (motivo), Marcar pagada, Archivar/Desarchivar (owner). Todo lo bloqueado se muestra con candado y el motivo.

**Nueva factura** (aceptación V1 del usuario): el desplegable de proveedor termina en «+ Nuevo proveedor…», que abre nombre y NIF en la misma hoja; el proveedor se crea en el mismo lote que la factura y, si el NIF ya existe, se usa ese proveedor. Sin proveedores, la opción viene elegida. En cuanto hay documento aparece **«Extraer con ChatGPT»**: 1) Copiar prompt (y adjuntar en ChatGPT u otro asistente esa misma foto o PDF) y 2) Pegar JSON, que abre la importación con esos mismos documentos ya puestos. El mismo bloque aparece en la ficha junto al documento de una factura en `pendiente_datos`, e importa en esa factura. Está siempre, con o sin extracción automática.

**Importar**: la hoja empieza con «¿Cómo obtengo el JSON?» (tres pasos y el prompt de extracción del handoff copiable al portapapeles, con el schema resumido y un ejemplo) y sigue con tres pasos: (1) JSON (pegar o archivo) y documentos si aún no hay; (2) **vista previa y recalculo** (proveedor, fecha/objeto, líneas, impuestos, cuadre con deltas, avisos, categoría/inversión/deducibilidad); (3) confirmar. Cuando el JSON viene de «Extraer», la hoja lo indica, lista los avisos del modelo y muestra discretamente el **coste de la extracción** (modelo, tokens de entrada y salida, tiempo). Si el modelo no devolvió un JSON utilizable (`EXTRACTION_INVALID`: sin JSON, JSON inválido, respuesta cortada, rechazo) o el servicio no está (`EXTRACTION_UNAVAILABLE`), la hoja se abre vacía con los motivos y se puede pegar el JSON a mano.

### 9.3 Compras

Vista §6.3. Selector de rango (trimestre por defecto, mes, año, libre); pestañas **Por categoría · Por destino · Por proveedor · Artículos**; «sin asignar» siempre como primera fila si no es cero; toque → lista filtrada; «Asignar a…» en sitio (hoja con Área → Proyecto → Tarea, recientes, general; importe y cantidad). Indicador de obsolescencia por destino. Totales del filtro fijos abajo en móvil. Interruptor «solo validadas» (por defecto activo).

### 9.4 Gestoría

Selector de rango; **resumen fiscal** (§6.4) por bloques; **alertas** (pendientes, discrepancias, deducibilidad sin revisar, sin documento, vencidas); lista de **entregas** del año (código, carpeta, nº facturas, hash abreviado, estado, «desfasada» si procede) con «Descargar ZIP», «Ver manifest», «CSV», «Marcar entregada», «Archivar periodo» (owner, tras entregada). Botón **«Preparar entrega»** → `exports/accountant` (vista previa: qué entra, qué queda fuera y por qué) → confirmar → `create_export` → descarga. `reader` ve lo mismo sin botones de escritura.

### 9.6 Enlaces desde otras apps

Rutas estables de `https://invoices.ikisai.com` para enlazar desde Reservas, Cocina o Tareas (se leen al arrancar y al cambiar el hash; si no hay sesión, primero se entra y luego se abre):

| Enlace | Abre |
|---|---|
| `#/facturas/<código>` (p. ej. `#/facturas/FVR_2026_012`) | La ficha de esa factura. Es el `invoice_code` de las proyecciones. Si no está en el dispositivo, un aviso. |
| `#/facturas/<uuid>` | La ficha por id. |
| `#/compras?destino=<app>:<kind>:<id>` (p. ej. `#/compras?destino=booking:reservation:<uuid>`, `booking:event:<uuid>`, `food:ingredient:<uuid>`) | Compras › Artículos filtrado a ese destino, con el periodo que cubren sus facturas y sin limitarse a validadas: suma lo mismo que `invoices.booking_cost_projection` (todas menos las anuladas). Sin `:<id>`, todos los destinos de ese tipo. |

### 9.5 Proveedores (existe)

Se añaden `aliases`, `slug`, `default_is_investment`; en el detalle, total facturado del año y últimas facturas.

---

## 10. Offline

El handoff no exigía offline; el plan de Core sí (todas las apps). **Espejo local:** todas las tablas `invoices.*`.

**Sin red se puede:** proveedores; subir documento con fecha/proveedor/objeto (cola de blobs; vista previa del nombre canónico); importar JSON (validación de schema, recalculo y cuadre son locales con `_domain/invoices`; duplicados contra el espejo; se envía como operaciones de fila, no como `call`, para que la factura exista en el espejo desde el primer momento); editar líneas, impuestos, pago, deducibilidad, notas; anular; asignar a `general` y a destinos de Tareas **recientes** (caché local de los últimos 50); ver Facturas, Compras y resumen fiscal del rango (misma función de dominio); documentos ya cacheados. **Validar** también se encola (es un `call`), pero la UI avisa de que el servidor recalculará.

**Requiere red:** buscar destinos nuevos en Tareas, `imports/preview` del servidor (opcional), crear entrega (se encola, pero se desaconseja), descargar ZIP/CSV/manifest, documentos no cacheados.

**Pendientes, conflictos y rechazados:** chip «pendiente de sincronizar»; `code` «pendiente» hasta el recibo; `VERSION_CONFLICT` con la regla general (rebase disjunto / decisión humana, componente de conflicto del ui-kit v0.2); errores definitivos 422 de un lote encolado (`IMPORT_TOTALS…`, `TARGET_NOT_FOUND`, `ALLOCATIONS_EXCEED_LINE`, `DOMAIN_ERROR` con `sqlstate`) → **Rechazados** (`rejected()`), con el mensaje de dominio y «editar y reintentar» (`retryRejected`) o «descartar». Un adjunto que no sube (`BLOB_MISSING`, `FILE_MISMATCH`) deja la factura con «documento pendiente: reintentar / quitar».

**Rendimiento del espejo** (medido el 6 de octubre de 2026 con `tests/invoices/perf.ts`: 500 facturas, 1.500 líneas, CPU ×4 en móvil emulado): recargar las ocho tablas tarda 120–150 ms (mediana), por debajo del objetivo de 200 ms; los avisos de las distintas tablas de un mismo lote se agrupan en una sola recarga (`onAnyTable`). Si el volumen real lo supera, el siguiente paso es recargar solo la tabla afectada.

**Cierre de sesión:** `clearOnLogout: true` (las facturas son datos del negocio; un dispositivo compartido no debe conservarlas sin sesión).

---

## 11. Aceptación

Recorrido §31A del handoff (números 1–15) más el checklist A, adaptados al núcleo. Datos sintéticos.

| Nº | Escenario (31A / checklist A) | Resultado esperado |
|---|---|---|
| 1 | Login real; instalación PWA en Android y PC. | Shell con las cuatro entradas; estado «En línea · Todo sincronizado». |
| 2–3 | Subir PDF sintético indicando fecha, proveedor y objeto. | Factura `pendiente_datos`; archivo `2026_10_05_(makro)_alimentos_retiro_yoga.pdf`; nombre original conservado. |
| 3b | Subir dos imágenes como páginas de otra factura; subir otro PDF con misma fecha, empresa y objeto. | `_p01`, `_p02`; colisión resuelta con `_02` sin sobrescribir. |
| 4 | Comprobar el bucket. | Privado; `GET files/:id` exige sesión; URL firmada caduca. |
| 5–6 | Importar `04_EJEMPLO_IKISAI_INVOICE_IMPORT_V1.json` sobre la factura. | JSON validado contra el schema; líneas e impuestos creados; `pendiente_revision` con `IMPORTADA`; proveedor emparejado por NIF. |
| 5b | Importar JSON con una clave desconocida o sin `document_totals`. | `IMPORT_INVALID` con `path`; nada escrito. |
| 6b | Importar JSON con dos tipos de IVA y una retención IRPF. | Varios `tax_lines`; `calculated_total = base + iva − irpf`. |
| 7 | Importar JSON con `document_totals.total` que difiere 0,50 del recalculo. | `REVISAR IMPORTES`; delta en rojo; **no** `validada`. |
| 7b | Diferencia 0,01. | Dentro de tolerancia; delta en ámbar; `recalculation.within_tolerance = true`. |
| 8 | Corregir `source_total` (o una línea) y pulsar Validar. | `validada`; «✓ Importes comprobados». Editar después una línea → vuelve a `pendiente_revision` (`EDITADA_TRAS_VALIDAR`). |
| 8b | Edición manual completa de una factura sin JSON. | Mismo recorrido hasta `validada`. |
| 9 | Asignar una línea a un proyecto de Tareas (Área → Proyecto → Tarea). | Validado con el token del usuario; `target_label`, `path`, `target_revision`; Compras lo muestra. |
| 9b | Asignar a un proyecto que el usuario no ve en Tareas. | `TARGET_FORBIDDEN`; no se guarda. |
| 10–11 | Selectores de Booking y Food. | Deshabilitados con explicación («fase 2»), sin bloquear. |
| 12 | Dividir una línea entre dos destinos (60 % Tareas, resto general) e intentar un tercero que excede. | Primeros dos guardados; el tercero `ALLOCATIONS_EXCEED_LINE`. |
| 12b | Dividir por cantidad (20 kg → 12 + 8) e intentar 12 + 9. | `ALLOCATIONS_EXCEED_QUANTITY`. |
| 13 | Compras: rango T4, por categoría / destino / proveedor; filtros sin asignar, retiro, ingrediente. | Totales = suma de líneas listadas (prueba automática). |
| 13b | Gestoría: resumen fiscal del rango. | IVA por tasa y retenciones coinciden con `tax_lines`; alertas listan la pendiente y la discrepancia. |
| 14 | Preparar entrega del T4 con una `pendiente_revision` en el rango. | Vista previa muestra la excluida y el motivo; `GST_2026_001` creada; **ningún estado de factura cambia**. |
| 15 | Descargar ZIP; verificar con `sha256sum`. | Carpeta `IKISAI_COMPRAS_2026_T4/` con `facturas/`, `facturas_recibidas.csv`, `lineas_compra.csv`, `resumen_impuestos.csv`, `manifest.json`; hashes correctos; CSV abre en Excel con acentos y comas decimales. |
| 16 | Editar una factura incluida en la entrega entregada. | Gestoría marca la entrega «desfasada» y ofrece una nueva. |
| 17 | Marcar entregada; archivar periodo (owner); intentar editar fecha de una archivada. | `entregada`; facturas `archivada`; `INVOICE_ARCHIVED`; pago y notas sí. |
| 18 | Anular una factura con motivo. | `anulada`; sus asignaciones a la papelera; fuera de resúmenes. |
| 19 | Vaciar papelera (owner). | Borra proveedores y asignaciones; facturas, líneas, impuestos, documentos y entregas no (`never_purge`). |
| 20 | `reader` (gestoría). | Lee todo, descarga ZIP; escrituras `FORBIDDEN`, botones ocultos. |
| 21 | Historial y deshacer un cambio de pago; intentar deshacer un lote con `call`. | `undo` restaura; `UNDO_UNAVAILABLE` explicado. |

Escenarios offline en Playwright (`tests/invoices/`), sobre `smoke.spec.ts` y `fake-api.ts` ampliado (`call`, `uploads`, `read/*`, `targets/tasks`):

| Nº | Escenario |
|---|---|
| O1 | Corte de red durante «Subir documento» + «Importar JSON»: ambos lotes en cola; factura «pendiente»; al reconectar sube el PDF, verifica, envía ambos, aparece el código. |
| O2 | Recarga con cola pendiente (dos facturas, dos fotos): la cola sobrevive y se vacía en orden. |
| O3 | Conflicto disjunto (`notes` vs `payment_status`): rebase automático y aviso. |
| O4 | Conflicto solapado (`expense_category`): componente de conflicto; decisión genera comando nuevo. |
| O5 | Asignación offline a destino cacheado que ya no existe: `TARGET_NOT_FOUND` → Rechazados → «pasar a general» (`retryRejected`). |
| O6 | Subida con hash distinto simulado: lote no enviado; «documento pendiente: reintentar». |
| O7 | Compras y resumen fiscal offline coinciden con `read/invoices.items` y `read/invoices.fiscal_summary` tras sincronizar. |
| O8 | `reader` offline: lectura completa; ZIP deshabilitado sin red con explicación. |
| O9 | Cierre de sesión borra el espejo (`clearOnLogout`). |

Estado el 6 de octubre de 2026: `tests/invoices/acceptance.spec.ts` automatiza A1–A13, A18 y O1–O9 contra la app compilada y la API falsa (`fake-api.ts`, misma superficie que `invoices-api`: subidas con verificación, destinos, procedimientos mínimos); A14–A17 y A19–A21 están cubiertos por `tests/invoices/sql.test.ts` y `api.test.ts` contra PGlite (entregas, ZIP, archivar, papelera, `reader`, deshacer). Pendientes de pasar a mano sobre la app publicada: instalación PWA en Android y descarga del ZIP en el móvil.

Pruebas de dominio (`supabase/functions/_domain/invoices`, `tsx --test`): schema `ikisai.invoice.v1` (el ejemplo del handoff valida; casos inválidos), `recalculate` con tabla de redondeos y tolerancia, `normalizedFilename` (paridad con SQL en PGlite, incluidos `_pNN` y `_NN`), `fiscalSummary`, `purchaseItems`, categorías iguales a la migración.

Conformidad: `tests/core/invoices-conformance.test.ts` (sigue con `suppliers`) + pruebas propias `tests/core/invoices-domain.test.ts`: `import_v1` (ejemplo del handoff, cuadre, duplicados, tolerancia, factura existente), `validate`, `annul`, `create_export` (manifest, excluidas, inmutabilidad), triggers (`guard_*`, renombrado, vuelta a `pendiente_revision`), `check_invariants` (sobreasignación por importe y cantidad).

---

## 12. Reparto entre agentes

### Backend (SQL + Edge + dominio)

- `supabase/functions/_domain/invoices/` (`mod.ts`, `import-v1.schema.ts`, `recalculate.ts`, `filename.ts`, `summary.ts`, `validate.ts`, `errors.ts`); `packages/domain-invoices` solo reexporta.
- `supabase/migrations/2026MMDD_NNNN_invoices_model.sql` (+ `_procedures.sql` si se prefiere separar): §2, §4.2, §4.3, §3, §7.1, registros (`register_table` con `never_purge`, `allow_procedure`, `add_validate_hook`, `allow_read`).
- `supabase/functions/invoices-api`: `beforeCommit` §4.1, rutas §6, cliente de Tareas con `ctx.token`, ZIP en streaming, CSV y manifest.
- `tests/core/invoices-*.test.ts`, pruebas de dominio.

### Frontend (Vite + ui-kit)

- `apps/invoices/src/ui/`: `invoices.ts` (lista y ficha), `upload.ts`, `import.ts`, `allocations.ts`, `purchases.ts`, `accounting.ts`, `rejected.ts`; ampliación de `suppliers.ts`, `home.ts`; `app/client.ts` con todas las tablas y `clearOnLogout`; `app/files.ts` (recompresión, hash, marcadores); `app/targets.ts` (caché).
- `tests/invoices/`: `fake-api.ts` ampliado y O1–O9.

### Orden

1. **Base común** (backend, primero): dominio + migración + `beforeCommit` + conformidad. Frontend en paralelo con lista y ficha contra `fake-api.ts`.
2. Verticales en ramas `invoices/<vertical>`: **subida e importación**, **compras y destinos**, **gestoría**.
3. Fase 2 con Core: destinos Booking y Food, proyecciones §7.1, `imports/extract`.

### Peticiones

En `docs/invoices/PETICIONES.md`. Las de la primera versión están resueltas por Core (`ctx.token`, marcadores `$blob`, `core.allow_read`, `npm:fflate`, lint, snapshot de Tasks como puente, handoff disponible). Abiertas: lectura `tasks.targets` (equipo Tasks), proyecciones de Booking y Food (fase 2).

---

## 13. Facturas emitidas (propuesta, ronda 21 · pendiente de revisión de Core)

**Alcance aprobado por el usuario.** Se **registran** las facturas emitidas con otra herramienta; la app **no emite** todavía. El modelo deja preparado lo común para emitir desde la app cumpliendo Verifactu, sin la parte de Verifactu: no hay huella, encadenado, firma ni envío a la AEAT. Prioridad: después de la #138 de la V1.

**Marco legal.** El sistema que **expide** una factura es el responsable de su registro Verifactu. Las facturas registradas aquí (`origin` `manual` o `importada`) ya tienen su registro en la herramienta que las emitió. Aquí son el **libro registro de facturas expedidas**: base del IVA repercutido, del modelo 303 y de la entrega a la gestoría. Los campos Verifactu de esas facturas quedan vacíos. Solo `origin = 'app'` los rellenará, cuando se construya la emisión. Los nombres y listas cerradas de abajo siguen el diseño de registro de la AEAT y hay que **confirmarlos contra la especificación técnica vigente** antes de construir la emisión.

### 13.1 Tablas (migraciones `0205+`, schema `invoices`)

Todas con las columnas de núcleo (`id, revision, created_at, updated_at, updated_by, deleted_at`) y `never_purge = true`: un registro fiscal no se purga. Anular es un cambio de estado con motivo, como en las recibidas.

**`invoices.issued_series`**: series de numeración.

| Columna | Tipo | Notas |
|---|---|---|
| `code` | `text unique not null` | Serie tal y como aparece en la factura (`A`, `R`, `2026-A`…). |
| `description` | `text null` | «Ordinarias», «Rectificativas», «Tickets»… |
| `kind` | `text not null default 'ordinaria'` | `ordinaria` · `rectificativa` · `simplificada`. Por norma, las rectificativas van en serie propia. |
| `yearly` | `boolean not null default true` | Numeración reiniciada cada año. |
| `format` | `text not null default '{serie}-{año}-{n:4}'` | Plantilla del número **para la emisión desde la app** (reservado). |
| `active` | `boolean not null default true` | |

**`invoices.issued_invoices`**: cabecera.

| Grupo | Columnas | Notas |
|---|---|---|
| Identidad | `series_code text not null`, `number text not null`, `full_number text` generada (serie y número según formato) | `unique (series_code, number)` entre las no borradas. Al registrar, el número es el del documento; al emitir (futuro), lo asigna el procedimiento de §13.3. |
| Fechas | `issue_date date not null` (expedición), `operation_date date null` (si es distinta) | El periodo fiscal sale de `issue_date`, como en las recibidas (columnas generadas `fiscal_year`, `fiscal_quarter`). |
| Tipo | `invoice_type text not null`: `F1` completa · `F2` simplificada · `F3` sustitutiva de simplificadas · `R1`–`R5` rectificativas | Etiquetas en castellano en la app; los códigos siguen la lista de la AEAT. |
| Rectificación | `rectification_kind text null` (`S` por sustitución, `I` por diferencias), `rectified jsonb not null default '[]'` (`[{series, number, issue_date, issued_invoice_id?}]`), `rectification_reason text null`, `rectified_base numeric(14,2) null`, `rectified_quota numeric(14,2) null` | Obligatorios si `invoice_type` empieza por `R` (check). La referencia puede ser a una emitida registrada aquí (`issued_invoice_id`) o solo textual. |
| Destinatario | `recipient_name text null`, `recipient_tax_id text null`, `recipient_id_type text null` (`NIF`, o `02` NIF-IVA · `03` pasaporte · `04` documento oficial · `05` certificado de residencia · `06` otro), `recipient_country char(2) null`, `extra_recipients jsonb not null default '[]'` | En `F2` el destinatario puede faltar; en `F1` y `R*`, nombre e identificación obligatorios (check). |
| Contenido | `description text not null` (descripción de la operación), `notes text null` | |
| Importes | `base_total`, `quota_total` (IVA o IGIC repercutido), `surcharge_total` (recargo de equivalencia), `withholding_total` (IRPF y otras retenciones, en positivo), `total`, todos `numeric(14,2) not null`; `source_total numeric(14,2) null` | Recalculados desde líneas y desglose con la misma regla y tolerancia que las recibidas (`recalculate`, 0,02 €). `total = base + cuotas + recargo − retenciones`. |
| Estado | `status text not null`: `registrada` · `anulada`; `annulled_reason text null`; `review_reason text null` | Sin estados pendientes: se registra lo que ya se expidió. Si no cuadra, `review_reason = 'REVISAR IMPORTES'` y aviso, sin bloquear. |
| Origen | `origin text not null`: `manual` · `importada` · `app` (reservado); `external_tool text null`, `external_id text null`, `import_sha256 text null` | `importada` con `unique (external_tool, external_id)` para no duplicar. |
| Ingreso | `income_category text null`: `alojamiento` · `restauracion` · `actividades` · `eventos` · `otros` | Lista cerrada propuesta, a confirmar con el usuario. |
| Verifactu (reservados, vacíos) | `vf_record_kind` (`alta` · `anulacion`), `vf_hash` (huella SHA-256), `vf_previous_hash`, `vf_previous_ref jsonb` (serie, número y fecha del registro anterior), `vf_first_record boolean`, `vf_generated_at timestamptz` (fecha, hora y huso de generación del registro), `vf_status` (`pendiente` · `enviado` · `aceptado` · `aceptado_con_errores` · `rechazado`), `vf_csv` (código seguro de verificación de la respuesta), `vf_errors jsonb`, `vf_qr_url text`, `vf_system jsonb` (identificación del sistema informático) | Todos `null`. **No escribibles** por el cliente: el hook de la Edge los rechaza. Solo los escribirá el procedimiento de emisión (futuro). |
| Referencia de la otra herramienta | `external_qr_url text null`, `external_csv text null` | Opcional: QR o código de verificación que trae la factura emitida fuera, solo como referencia. |

**`invoices.issued_invoice_lines`**: `issued_invoice_id`, `position` (orden manual, como en recibidas), `description`, `quantity`, `unit`, `unit_price`, `discount_amount`, `net_amount`, `tax` (`iva` · `igic` · `ipsi` · `otros`), `vat_rate`, `vat_amount`, `surcharge_rate`, `surcharge_amount`, `gross_amount`, `notes`.

**`invoices.issued_tax_lines`**: el **desglose**, una fila por combinación de impuesto, régimen, calificación o exención y tipo. Campos: `tax` (`iva` · `igic` · `ipsi` · `otros`, o `irpf` · `otra_retencion` para retenciones), `regime_key` (clave de régimen, `01` general por defecto), `qualification` (`S1` sujeta no exenta · `S2` sujeta con inversión del sujeto pasivo · `N1` · `N2` no sujetas), `exemption` (`E1`–`E6` si exenta; excluye `qualification`), `rate`, `taxable_base`, `quota`, `surcharge_rate`, `surcharge_quota`. Las retenciones no forman parte del desglose de Verifactu, pero sí de la factura y del total.

**`invoices.issued_invoice_files`**: como `invoice_files` (documento PDF en `core.files`, verificado). Nombre canónico `AAAA_MM_DD_(cliente)_SERIE-NUMERO.pdf`; sin destinatario, `(sin_destinatario)`.

**`invoices.issued_allocations`**: vínculo con el **destino del ingreso**, normalmente una reserva o un evento de Booking. Campos: `issued_invoice_id`, `target_app` (`booking` · `general`), `target_kind` (`reservation` · `event` · `general`), `target_id`, `target_label`, `target_code`, `target_revision`, `allocated_amount`. Va **por factura**, no por línea, porque una factura de estancia suele ir entera a una reserva. Admite repartir el importe entre varias. Se resuelve con el mismo validador de destinos que las compras (`targets/booking`), con el token del usuario.

### 13.2 Reglas e invariantes

- `unique (series_code, number)` entre las vivas; un número no se reutiliza ni tras anular.
- Las rectificativas exigen `rectification_kind`, al menos una referencia en `rectified` y motivo. `R5` rectifica simplificadas.
- Importes recalculados en el hook `invoices.check_invariants`, como en las recibidas: el desglose cuadra con las líneas y el total con el desglose dentro de 0,02 €. Si no cuadra se marca `REVISAR IMPORTES`, sin bloquear el registro, porque la factura ya existe fuera.
- `vf_*` solo por procedimiento; `origin = 'app'` solo por el procedimiento de emisión (rechazado hoy con `UNSUPPORTED_IN_V1`).
- Editar una emitida registrada deja traza en el historial del núcleo. Anularla pide motivo y retira sus asignaciones. No se borra.
- **Agentes:** registrar o anular emitidas **exige aprobación** (no se marca como seguro); leerlas, no.

### 13.3 Numeración por serie

Al **registrar**, el número viene del documento y solo se comprueba que no esté repetido. Para la **emisión futura** hace falta numeración correlativa sin huecos por serie y año, asignada en la misma transacción que el alta. `core.next_code` ya usa un contador por prefijo y año que no deja huecos si se llama dentro de la transacción del alta, pero devuelve un formato fijo (`PREFIJO_AAAA_NNN`). **Petición a Core:** `core.next_number(p_prefix text, p_year int) returns int`, con el mismo contador y sin formato, para que la serie aplique su plantilla. Va en `PETICIONES.md` cuando Core apruebe esta propuesta.

### 13.4 Procedimientos y rutas

- `invoices.register_issued(p)`: alta manual o importada de una factura con líneas, desglose, documentos y asignaciones en un lote, con ids del cliente para funcionar sin red. Equivale a `import_v1` para las emitidas.
- `invoices.annul_issued(p)`: anula una emitida con motivo.
- Formato de importación `ikisai.issued_invoice.v1`, el mismo esquema que la tabla, para traer las facturas de la otra herramienta: un JSON por factura o un lote. Si la herramienta exporta CSV, un convertidor en el cliente. **Pregunta para el usuario:** qué herramienta usa para emitir y qué exporta (CSV, JSON, API).
- Lecturas: `invoices.issued_items` (ventas por periodo, categoría y destino) y ampliación de `invoices.fiscal_summary` con **IVA repercutido** por tipo y la diferencia con el soportado, que es la base del modelo 303. El cliente lo calcula con la misma función de dominio.
- Gestoría: la entrega trimestral añade la carpeta `emitidas/` con los PDF y `emitidas.csv`, con el mismo manifest y hashes.
- Proyección para Booking: `invoices.booking_income_projection` (`issued_invoice_id`, `full_number`, `issue_date`, `target_kind`, `target_id`, `allocated_amount`, `status`), registrada con `core.allow_read('booking', …, 'view')`. Así Booking muestra el **ingreso real** de cada reserva junto al coste real que ya lee.
- MCP: `invoices_register_issued` (editor, siempre con propuesta para agentes) e `invoices_sales` (lectura).

### 13.5 Pantallas (propuesta)

- **Facturas** pasa a tener dos pestañas, **Recibidas · Emitidas**, con la misma lista por mes y la misma ficha. Así no añadimos una quinta entrada a la navegación del móvil.
- **Ficha de emitida:** serie y número, tipo y rectificación, destinatario, líneas reordenables, desglose, documento, destino (reserva o evento), estado y origen. Un bloque «Verifactu» plegado dice «Registrada con otra herramienta» o, en el futuro, el estado del registro.
- **Nueva emitida:** serie (con «+ Nueva serie…» en la propia hoja, como el proveedor), número, fechas, destinatario, líneas y documento. También «Importar» para el JSON de la otra herramienta y «Extraer con ChatGPT» con un prompt de emitidas.
- **Gestoría:** resumen con IVA repercutido, soportado y diferencia por trimestre.

### 13.6 Qué queda fuera ahora (preparado, sin desarrollar)

Huella y encadenado, firma, registros de alta y de anulación de Verifactu, envío y respuesta de la AEAT, QR, declaración responsable del sistema informático y modalidad «no Verifactu». Los campos `vf_*`, `origin = 'app'`, `issued_series.format` y `core.next_number` quedan listos para que la emisión sea un procedimiento nuevo y no una migración del modelo.

### 13.7 Preguntas abiertas

1. **Usuario:** qué herramienta emite hoy las facturas y en qué formato exporta.
2. **Usuario:** si la lista de categorías de ingreso (`alojamiento`, `restauracion`, `actividades`, `eventos`, `otros`) le sirve.
3. **Core:** visto bueno a `core.next_number` (§13.3) y a la proyección de ingresos para Booking.
4. **Core y usuario:** si las emitidas van como pestaña dentro de Facturas (propuesta) o como entrada propia en la navegación.
