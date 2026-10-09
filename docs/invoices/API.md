# Ikisai Invoices · API y modelo de datos (puerta G2)

> **Finance.** Desde la ronda 31 la app se llama **Ikisai Finance** (`finance.ikisai.com`; `invoices.ikisai.com` y `tramita.ikisai.com` redirigen). Internamente todo sigue como `invoices`: schema, app id, función `invoices-api`, rutas y este documento.

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
| `code` | `text unique not null` | `FVR_AAAA_NNN` (`core.next_code('FVR', año de invoice_date)`, o el año en curso si aún no tiene fecha), asignado por trigger en el `insert`. No escribible. |
| `supplier_id` | `uuid not null references invoices.suppliers(id)` | |
| `invoice_date` | `date` | Fecha de la factura. Origen del nombre canónico y del periodo fiscal. **Opcional desde 0223** (QA FB_2026_016): se puede crear sin ella y leerla del PDF o escribirla después. Sin fecha, el periodo fiscal queda vacío, el nombre canónico empieza por `sin_fecha`, no entra en resúmenes ni entregas por periodo y `validate` responde `INVOICE_INCOMPLETE` con `invoice_date` entre los datos que faltan. |
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

### 2.1 Facturas rectificativas recibidas (migración 0227, aprobada por Core el 8-10-2026)

Abonos y devoluciones de proveedores. Por ejemplo, una compra en Obramat (factura A) y, semanas después, una rectificativa que resta los productos devueltos.

**Modelo:**
- En `invoices.invoices`:
  - `invoice_kind` (`ordinaria` · `rectificativa`, por defecto `ordinaria`);
  - `rectifies_invoice_id` (la original);
  - `rectifies_number` (el número de la rectificada tal como lo imprime el proveedor);
  - `rectification_without_original` («no tengo la original»).
- En `invoices.invoice_lines`: `rectifies_line_id` (la línea devuelta de la original).

**Signo:**
- Una rectificativa lleva líneas, impuestos y asignaciones **negativos**: resta de la original.
- `tax_lines.amount` y `allocations.allocated_amount` ya no tienen check de signo en la fila. El hook de invariantes exige:
  - que una ordinaria no tenga impuestos negativos (`NEGATIVE_TAX_IN_ORDINARY`);
  - que cada asignación lleve el signo de su línea y no pase de su valor absoluto (`ALLOCATIONS_EXCEED_LINE`).
- Una ordinaria se comporta como siempre.

**Detección** (`detectRectification` en el dominio):
- Por el texto del documento: «rectificativa», «abono», «devolución», «nota de abono», «factura rectificada», «rectifica a la factura nº…». También por las notas de la IA o por un total negativo.
- Saca también el número rectificado.
- Si el proveedor la imprimió en positivo, se importa en negativo (`negateDocument`).
- **El contrato `ikisai.invoice.v1` no cambia.** El tipo y el número viajan en los `overrides` de `import_v1` (`invoice_kind`, `rectifies_number`).
- Quién la detecta:
  - Drive, al leer el PDF;
  - la revisión de «Leer PDF» o del JSON pegado (campos «Tipo de factura» y «Rectifica a la factura nº», editables);
  - la herramienta MCP `invoices_import_json`, con el argumento `rectification: { number }` o por el documento.

**Enlace con la original** (hook de invariantes):
- Por proveedor y número normalizado (`invoices.normalized_number`: sin espacios, puntos, guiones, barras ni mayúsculas).
- Funciona en los dos sentidos:
  - al llegar la rectificativa, se busca la original;
  - si no está, queda «pendiente de enlazar», y al llegar después una ordinaria de ese proveedor con ese número, se enlaza sola.
- A mano, desde la ficha: «Factura original», o «No tengo la original».
- Al enlazar, las líneas de la rectificativa se emparejan con las de la original de igual descripción normalizada (`rectifies_line_id`).
- La ficha de la original muestra «Rectificada por …» y «Devuelto: X €» en cada línea devuelta.

**Validar** (`invoices.validate`): una rectificativa necesita `rectifies_invoice_id` o `rectification_without_original` (si no, `INVOICE_INCOMPLETE` con `rectified_invoice`) y un total negativo o cero (si no, `rectification_sign`).

**Reparto** («Repartir como la original» en la ficha):
- `proposeRectificationAllocations` propone las mismas asignaciones que la original, en proporción y en negativo:
  - las líneas emparejadas, con las de su línea;
  - las demás, con las de toda la original.
- Se confirma antes de guardar. Así el coste de la obra, del proyecto o del retiro baja solo.

**Periodo y gestoría:**
- La rectificativa cuenta en el trimestre de **su** fecha, con importes negativos: el resumen fiscal y la entrega suman con signo.
- `export_manifest` añade a cada factura `kind` y `rectifies` (`code`, `invoice_number`, `invoice_date`, `other_period`, `without_original`).
- El CSV de recibidas añade al final las columnas `tipo` (F1 o R), `rectifica`, `fecha_original` y `original_otro_periodo`.

**En la lista:** etiqueta «Rectificativa» (o «Rectificativa sin enlazar») y filtro «Rectificativas sin enlazar».

### 2.2 Periodo de declaración (migración 0228, aprobado por Core el 9-10-2026)

La fecha de la factura no cambia; el trimestre en que se declara puede ser posterior (una factura del 2T que llega tarde).

**Modelo:**
- `invoices.invoices.declared_period` (`AAAATn`; nulo, el trimestre de su fecha), escribible.
- `declaration_date`, generada: el primer día del periodo declarado, o la fecha de la factura.

**Qué va por cada fecha:**
- Por `declaration_date`: el resumen fiscal (`fiscal_summary_for`), la entrega (`export_manifest`) y su aviso de «desactualizada» (`export_bundle`). En el dispositivo, `fiscalSummary` usa `declarationDate()`.
- Por la fecha real: Compras y los indicadores de Central.
- Un resumen por meses pone una factura atrasada en el primer mes del trimestre en que se declara.

**Asignación:**
- Hook `invoices.assign_declared_period`: una factura pendiente que se crea, o cuya fecha cambia, y cae en un trimestre **con entrega ya preparada** pasa sola al siguiente sin entrega («Atrasada (2T)»).
- Si el trimestre de su fecha ya terminó pero **no tiene entrega en la app** (lo normal: se declaró fuera), la ficha pregunta «Es del 2T: ¿la declaras en el 3T?» con un botón. Nada cambia sin confirmarlo.
- Siempre editable en «Fiscal y pago › Se declara en».

**En la entrega:** cada factura lleva `declared_period` y `late` en el manifest. El CSV de recibidas añade al final `periodo_declaracion` y `atrasada`, y conserva la fecha real.

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

### 6.7 Extracción con la app de IA del usuario, sin API de pago (ronda 29, fase 1)

El usuario no quiere pagar APIs de IA. La extracción automática por API (`imports/extract`) queda **dormida**: responde `EXTRACTION_UNAVAILABLE` sin clave y se conserva como abstracción de proveedor. En su lugar:

- **«Analizar con IA»**, en el bloque «Extraer con ChatGPT», junto al documento de «Nueva factura» y de la ficha de una factura pendiente de datos.
  - Comparte con Web Share (`canShare({files})` comprobado) **el documento** y **`ikisai_invoice_contract.txt`** (`invoiceContractText`). El contrato lleva normas (solo JSON, `null` si no se sabe, no inventar, fechas ISO, números sin símbolo) y el formato `ikisai.invoice.v1`.
  - Antes de compartir, un aviso dice que el documento va a la app que elija el usuario.
  - Si la plataforma no acepta el TXT como segundo archivo, el contrato va en `text` y además al portapapeles. Sin Web Share (escritorio), se copia y se descarga el TXT para adjuntarlo a mano: la función nunca desaparece.
  - En la ficha, el documento se lee de su URL firmada, así que hace falta red.
- **Sobre de intercambio.** El contrato pide devolver `source: {filename, sha256}` del documento. Al importar en una factura, si el sobre viene y no corresponde a ninguno de sus documentos, aparece un aviso que no bloquea. Si corresponde, se indica.
- **Lo que vuelve es no confiable.** `parseExternalResult` extrae el JSON del texto (entero, bloque ```json o primer objeto equilibrado), separa el sobre y valida el resto con el mismo esquema estricto: claves de más, tipos o importes como texto se rechazan. Después vienen la vista previa con recálculo y la confirmación de siempre.
- **Volver a Ikisai.** El manifiesto declara `share_target` (`POST /share-target`, multipart, `text` y archivos `.json` y `.txt`). El service worker guarda lo recibido (hasta 1 MB por archivo) en la caché `ikisai-invoices-share` y abre `#/facturas?compartido=1`. Facturas abre la importación sobre la factura pendiente de datos más reciente con documento, o una nueva si no hay ninguna.
  - Sin service worker activo (primera visita), el worker de Cloudflare redirige a `?compartido=0` y la app pide pegar el resultado.
  - Fallbacks que siguen: «Pegar JSON», que ahora detecta el JSON dentro de la respuesta entera, e importar archivo `.json` o `.txt`.

### 6.8 Texto de los PDF y reglas deterministas (ronda 29, fase 2)

- **«Leer PDF»**, en el mismo bloque que «Analizar con IA», en «Nueva factura» y en la ficha pendiente de datos.
  - Lee el texto con posiciones en el propio dispositivo, con **PDF.js** (`pdfjs-dist` 6.4.299). Se carga solo al pulsar el botón (import dinámico) y queda **fuera del precacheo del shell**.
  - El service worker guarda PDF.js la primera vez que se usa (caché `ikisai-invoices-ondemand`), para leer PDF también sin red después.
  - Lee hasta 10 páginas.
- **Extractor determinista** compartido (`_domain/invoices/pdf-extract.ts`, sin IA):
  - Agrupa el texto en líneas por página y altura.
  - Reconoce NIF, NIE y CIF con **dígito de control** (también con prefijo ES de NIF-IVA). Usa el proveedor conocido por NIF; si no, el primer NIF que no sea propio, y avisa si hay varios.
  - Lee la fecha de la línea «fecha» (no la de vencimiento ni la de pedido), también en formato «6 de octubre de 2026», y el número de factura por etiquetas.
  - Lee la base, el IVA por tipo con su base y cuota, la retención y el total por etiquetas en español. Detecta el IBAN con módulo 97 y lo deja en `extraction_notes`.
  - Si falta el total, se calcula y se avisa. Si falta la fecha o los importes, **no hay resultado** y se dice qué falta: nada se inventa.
  - Las líneas de la factura son una por tipo de IVA con su base, porque el detalle de artículos no se infiere del texto.
- **Procedencia por campo** (`FieldProvenance`): método (`pdf_text`, `supplier_template`, `external_ai`, `manual` u `ocr`), texto original, página, posición y confianza de 0 a 1. La importación muestra cada dato con su confianza y la línea de la que sale. El nombre de proveedor adivinado o el objeto por defecto aparecen con confianza baja o nula: nada inferido se presenta como verificado.
- **PDF sin texto** (escaneado o foto): se dice y se remite a «Analizar con IA». La fase 4 lo cubrirá con OCR. Un PDF que no se puede abrir (dañado o protegido) recibe el mismo trato.
- **Duplicado blando** (`softDuplicate`): misma fecha y mismo total (y mismo proveedor si se conoce) que otra factura no anulada. Da un aviso «Posible duplicado» sin bloquear, además del duplicado por proveedor y número de siempre.

### 6.9 Plantillas por proveedor aprendidas de confirmaciones (ronda 29, fase 3 · aprobada por Core en la ronda 33)

**Estado: construida** (PR 1/3 modelo y Edge, 2/3 motor en `_domain/invoices/supplier-templates.ts`, 3/3 app). Al validar, la app busca el texto del documento en `invoices.document_text` o, si no está, vuelve a leer el PDF. Sin red, sin PDF o sin texto, valida sin aprender: aprender nunca bloquea la validación.

**Objetivo.** Que la segunda, tercera… factura de un mismo proveedor se lea mejor que la primera, sin IA. Se aprende **solo de facturas confirmadas**: el momento de confirmar es `invoices.validate`. Nunca se aprende de una importación sin revisar ni de la propuesta de la propia plantilla.

#### Tablas (migración `0207`, schema `invoices`)

**`invoices.supplier_templates`**: sincronizable y copiada al dispositivo, porque «Leer PDF» funciona en el navegador y sin red. `never_purge = false`: una plantilla se retira, no se borra.

| Columna | Tipo | Notas |
|---|---|---|
| `supplier_id` | `uuid not null` → `suppliers` | Varias plantillas por proveedor. |
| `version` | `int not null` | `unique (supplier_id, version)`. Una versión nueva cuando cambia el formato, nunca se sobrescribe. |
| `status` | `text not null` | `aprendiendo` (menos de 2 confirmaciones), `activa` o `retirada` (la retira el owner, o se retira sola si falla de forma repetida; ver reglas). |
| `layout_tokens` | `text[] not null` | **Huella del formato**: palabras sin cifras de las 40 primeras líneas de la página 1, normalizadas (minúsculas, sin tildes) y sin repetir. Se compara por similitud (Jaccard), no por igualdad. |
| `layout_hash` | `text not null` | sha256 de `layout_tokens` ordenados, para detectar la misma huella rápido. |
| `page_size` | `jsonb null` | `{w, h}` de la página 1. |
| `fields` | `jsonb not null` | Una regla por campo (`invoice_number`, `invoice_date`, `supplier_tax_id`, `base`, `vat:<tipo>`, `withholding` y `total`): `{anchor: {text, variants[]}, relation, dx, dy, page, kind, pattern, hits, misses, last_hit_at}`. |
| `confirmations` | `int not null default 0` | Facturas confirmadas que la respaldan. |
| `uses` · `full_hits` | `int not null default 0` | Veces usada y veces en que todos sus campos coincidieron con lo confirmado. |
| `last_confirmed_invoice_id` | `uuid null` | Para trazar de dónde salió la última evidencia. |

Detalle de cada regla de `fields`:
- **`relation`:** `same_line_right` (el valor a la derecha de la etiqueta, en la misma línea), `below` (debajo, en la línea siguiente) o `column` (alineado bajo una cabecera de columna).
- **`dx` y `dy`:** desplazamiento aproximado del valor respecto a la etiqueta.
- **`kind`:** `date`, `money`, `rate`, `tax_id` o `text`.
- **`pattern`:** forma esperada del valor, por ejemplo `^A-\d{4}/\d{4}$` para el número, generalizada de los ejemplos confirmados (cifras por `\d`, longitudes fijas).

**`invoices.document_texts`** (aprobada con condiciones): el texto con posiciones ya leído de un documento. Una fila por documento: `file_id` único, `source` (`pdf_text` u `ocr`), `items jsonb` (páginas con posiciones), `char_count` y `sha256` del documento. **No se sincroniza al dispositivo** y **solo la escribe la Edge** (ruta `POST documents/:fileId/text`; el `beforeCommit` rechaza cualquier escritura del cliente). La lee la Edge o una lectura registrada bajo demanda. Se borra cuando se borra su documento (hook) o cuando desaparece el archivo (`on delete cascade` sobre `core.files`). Es texto de facturas: no se copia a otros sitios ni a registros. Ventajas:
- Al confirmar no hay que volver a leer el PDF.
- La fase 4 (OCR en la Edge) deja aquí su resultado y los mismos extractores lo usan.


#### Cómo se usa una plantilla

1. «Leer PDF» obtiene el texto y el extractor genérico (§6.8) identifica el NIF del proveedor.
2. Busca las plantillas del proveedor que no estén retiradas y elige la de huella más parecida, con un umbral de Jaccard de 0,6 o más.
3. Para cada regla localiza la etiqueta (`anchor` o una de sus variantes) y toma el valor en la posición indicada. Si cumple `kind` y `pattern`, se propone con procedencia `supplier_template` («plantilla v2, 5 facturas»). Si no, ese campo cae a la regla genérica.
4. **Confianza:** con estado `aprendiendo` se limita a 0,5 y se etiqueta «aprendiendo». Con `activa` es `min(0,95; 0,6 + 0,07 · confirmaciones) × hits / (hits + misses)` de esa regla.
5. Sin plantilla parecida (huella por debajo de 0,6), se usa solo el extractor genérico. La confirmación creará una versión nueva.

#### Cómo se aprende (al confirmar)

En el mismo lote que `call invoices.validate`, el cliente añade la operación sobre `supplier_templates`. La Edge **rechaza cualquier escritura en `supplier_templates` que no venga en un lote con `invoices.validate` de una factura de ese proveedor** (`TEMPLATE_REQUIRES_CONFIRMATION`). La excepción es retirar una plantilla, que hace el owner.

- **Primera confirmación sin plantilla parecida.**
  - Para cada valor confirmado (número, fecha, NIF, base, cuotas por tipo, retención y total), el cliente lo busca en el texto en sus formas posibles: `06/10/2026`, `6-10-26` o `6 de octubre de 2026`; `1.234,56` o `1234.56`.
  - Si aparece una sola vez, registra como ancla la etiqueta más cercana a su izquierda en la misma línea, o encima, y la relación.
  - Si aparece varias veces o ninguna, ese campo no se aprende.
  - Resultado: versión nueva en estado `aprendiendo`, con `confirmations = 1`.
- **Confirmación con plantilla parecida** (no retirada):
  - Por regla: si lo propuesto coincide con lo confirmado, `hits + 1`. Si no coincide, `misses + 1` y **no se cambia el ancla** por una sola factura anómala.
  - Si el valor está en otra posición, se añade la etiqueta nueva a `variants`.
  - Las reglas que faltaban se aprenden como en el primer caso.
  - `confirmations + 1` y `uses + 1`. Si todo coincidió, `full_hits + 1`. Con `confirmations ≥ 2` pasa a `activa`.
- **Cambio de formato:** si la huella está por debajo de 0,6 respecto a todas las versiones, se crea una **versión nueva** y la anterior se conserva. Si una regla acumula 3 fallos seguidos con huella parecida, esa regla se marca `retirada` dentro de `fields` y se aprende de nuevo a partir de la siguiente confirmación.
- **Lo que no se aprende:** importaciones sin validar, facturas validadas sin documento con texto, campos corregidos a mano que no aparecen en el texto, y lotes de agentes. Validar ya exige aprobación a un agente (§4.4), y la plantilla se escribe en ese mismo lote aprobado.

#### Pantallas

- **Importación:** los campos de plantilla muestran «plantilla v2 · 5 facturas» junto a la confianza. Los que caen a la regla genérica conservan «texto del PDF».
- **Ficha del proveedor:** bloque «Plantillas» con versión, estado, confirmaciones, aciertos completos, última vez usada, botón «Retirar» (owner) y un resumen de qué campos lee.

#### Pruebas previstas (sin servicios externos)

- **Dominio:**
  - Huella y similitud. Aprender de una confirmación: anclas y patrón. Uso con confianza según el estado.
  - Una factura anómala no rompe la plantilla. Dos formatos del mismo proveedor dan dos versiones.
  - Proveedor desconocido: solo reglas genéricas.
- **SQL:** se rechaza una plantilla sin `validate` en el lote; unicidad de versión.
- **Playwright** (PDF con texto generados en la prueba):
  - Primera factura de un proveedor: genérico y validar, con lo que se crea la plantilla en `aprendiendo`.
  - Segunda factura: validar, y la plantilla pasa a `activa`.
  - Tercera factura con otro formato de número que el genérico no lee: la plantilla lo lee con procedencia de plantilla.
  - Otro formato del mismo proveedor: versión nueva.

#### Decisiones de Core (ronda 33)

1. `invoices.document_texts` en servidor: sí, con las condiciones de arriba.
2. La escritura de plantillas va ligada a `invoices.validate` en el mismo lote. Lo impone el servidor, en el hook SQL: una plantilla solo se escribe en un lote donde una factura de ese proveedor pasa a `validada`. Hay una prueba de que una escritura suelta se rechaza.
3. Plantillas para emitidas: no por ahora.

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

### 7.4 Compras de Tasks (hecho en la ronda 34, migración 0208)

Construido: el par `tasks` / `purchase_request` (lista y resolución por `tasks.targets` con el token del usuario; etiqueta «Compras › título») y las lecturas `invoices.allocations_by_target {targetApp, targetKind, ids}` → `{rows: [{target_id, invoice_id, invoice_code, status, invoice_date, allocated_amount, allocated_quantity}]}` (sin anuladas ni borradas) e `invoices.supplier_options {q, limit ≤ 50}` → `{items: [{id, name, slug}]}`, registradas para `tasks` (y para `invoices`). Las dos devuelven vacío a quien no es miembro de Invoices. Lo que sigue es el texto original del pedido.

#### Pedido de Tasks (ronda 22, para cuando Tasks amplíe `tasks.targets`)

- **Destino `tasks` / `purchase_request`:** una solicitud de compra no alimentaria de Tasks como destino de asignación de una línea. Se resuelve con la lectura `tasks.targets` (que Tasks amplía con `kind = 'purchase_request'`) y con el token del usuario, como los demás destinos de Tareas. Cambia la lista de pares (`TARGET_KINDS`) y el check de `invoices.allocations` en una migración nueva.
- **Lectura `invoices.allocations_by_target {targetApp, targetKind, ids}`:** devuelve por id el código de factura, su estado y el importe asignado, filtrada por lo que el usuario ve en Invoices. Se registra con `core.allow_read('tasks', …)` para que Tasks muestre en cada solicitud qué se ha comprado y con qué factura.
- **Lectura `invoices.supplier_options {q, limit}`** (ronda 26): devuelve `[{id, name, slug}]` de proveedores vivos que coinciden con `q`, para elegir el proveedor preferente desde Tasks. Se registra con `core.allow_read('tasks', …)`. Se construye, con las dos anteriores, cuando Tasks empiece las compras.

### 7.5 Horas de personal de Booking (anotado, ronda 24; no construido)

Cuando Booking fusione su PR #146 existirá `booking.invoices_staff_hours_projection`, legible por Invoices con `GET /api/v1/read/booking.invoices_staff_hours_projection?where[event_id]=…`. Columnas: `assignment_id, event_id, event_code, reservation_id, reservation_code, function, staff_ref, work_date, planned_hours, actual_hours, status, revision`, sin nombres de personas. El **coste por hora por función** sería de Invoices: una tabla de tarifas por función y fecha de vigencia, y un coste de personal por evento o reserva junto al coste de compras. Se diseña y se construye cuando Core lo pida.

### 7.6 Indicadores para el panel de Dirección de Central (ronda 40, migración 0211)

Vista `invoices.central_kpi_projection`, con el contrato de `docs/central/API.md` §7.2. Está registrada con `core.allow_read('central', …, 'view')` y solo la lee la clave de servicio. Publica solo agregados: ningún proveedor, cliente ni importe de una factura concreta. «Hoy» es la fecha en hora de Madrid. Las claves mensuales cubren el mes en curso y los 12 anteriores, así que la vista tiene 29 filas.

| Clave | Etiqueta | Unidad · periodo · sentido | Fórmula |
|---|---|---|---|
| `invoices.pending_review` | Facturas recibidas por revisar | `count` · `actual` · `down` | Recibidas no borradas en `pendiente_datos` o `pendiente_revision`. |
| `invoices.unpaid` | Facturas recibidas sin pagar | `count` · `actual` · `down` | Recibidas no borradas ni anuladas con `payment_status = 'pendiente'`. |
| `invoices.unpaid_amount` | Importe recibido sin pagar | `eur` · `actual` · `down` | Suma de `calculated_total` (IVA incluido) de las mismas facturas que `invoices.unpaid`. |
| `invoices.expenses_month` | Gasto del mes (facturas validadas) | `eur` · `AAAA-MM` · `down` | Suma de `calculated_total` (IVA incluido) de las recibidas `validada` o `archivada`, por mes de `invoice_date`. Las que están por revisar no cuentan hasta validarlas. |
| `invoices.income_issued_month` | Ingresos facturados del mes (base) | `eur` · `AAAA-MM` · `up` | Suma de `base_total` (sin IVA) de las emitidas no borradas ni anuladas, y sin borradores cuando exista la emisión (§14), por mes de `issue_date`. |

Los enlaces llevan a `https://finance.ikisai.com/#/facturas` (las emitidas con `?vista=emitidas`) y el gasto a `#/gestoria`. Cambiar el significado de una clave es crear otra.

### 7.7 Portal de organizadores: el dinero del retiro (fase 3, F1 y F2; migración 0220)

Dos lecturas registradas para la app `organizers` (`core.allow_read('organizers', …, 'function', '{editor,owner}')`). El portal las llama con `read/invoices.…` y las filtra el ámbito del enlace (`core.portal_in_scope`, K1). Fuera de ámbito, con un id inválido o con una factura que no es del retiro, la respuesta es siempre `OUT_OF_SCOPE` (403).

**Facturas del retiro:** las que tienen su ingreso asignado a esa reserva de Booking (`issued_allocations`, destino `booking/reservation`), más las rectificativas emitidas de cualquiera de ellas. Nunca salen los borradores. Una anulada pierde su asignación al anularse, así que deja de salir.

**F1 · `invoices.portal_reservation_money {reservation_id}`:**
```
{ reservation_id, currency: 'EUR',
  invoices: [{ id, number, issue_date, type, purpose, rectifies: [número] | null, base, tax, withholding, total, status, collected, collected_at, has_document }],
  totals: { invoiced, collected, pending } }
```
- `status` puede ser `emitida`, `rectificada` o `registrada`.
- `collected` indica si la factura está cobrada.
- `purpose` es el concepto del cobro (migración 0221): `senal`, `saldo`, `extras`, `general` o `null` si no se indicó. El portal rotula así la factura («Señal», «Saldo», «Extras»). Es solo una etiqueta: no cambia importes ni totales.
- `totals` suma las no anuladas: facturado, cobrado y pendiente de cobro.

**F2 · `invoices.portal_invoice_document {reservation_id, issued_invoice_id}`:** devuelve `{ id, number, issue_date, status, document, files: [{ file_id, filename, mime, size }] }`.
- `document` es la copia congelada de una factura emitida desde Finance (§14.4). El portal la pinta e imprime, o la guarda en PDF, con la misma página imprimible del kit.
- `files` son los PDF guardados de una factura registrada de otra herramienta.

**Sin datos internos:** ni notas, ni revisión de importes, ni categoría de ingreso, ni herramienta de origen, ni registro VERI*FACTU, ni facturas de otras reservas.

**Lo contratado y lo cobrado** (decisión de Core, ronda 52): Booking publica lo contratado (total de la propuesta aceptada, señal requerida y vencimientos). Finance publica lo facturado y lo cobrado (F1); «pagado» sale solo de Finance. El portal calcula el saldo como contratado (Booking) − `totals.collected` (Finance).

**Pendiente fuera de Invoices:**
1. **URL firmada de un PDF guardado** (aplazada por Core en la ronda 52): una Edge con la clave de servicio tiene que firmarla con `createStorage`. La de Organizers es hoy genérica (`read/:name`). Propuesta: una ruta `portal-files` en `organizers-api` que repita la lectura F2 con la sesión del portal y firme solo un `file_id` que esa lectura devuelva. Las facturas emitidas desde Finance no la necesitan, porque el portal pinta su `document`.

### 7.8 Lo cobrado por reserva, para Booking (migración 0222)

Lectura de app, no de portal: `core.allow_read('booking', 'invoices.reservation_collected', 'function')`, con los roles por defecto de Booking. Booking la usa para su aviso «Saldo pendiente: plazo máximo vencido», que compara con lo cobrado de verdad (ronda 52).

**`invoices.reservation_collected {reservation_ids: [uuid]}`** devuelve `[{ reservation_id, invoiced, collected, last_collected_at }]`, una fila por id distinto, ordenadas por id.
- La suma es la misma que `totals` de F1 (§7.7): facturas asignadas a la reserva y sus rectificativas, que restan; sin borradores ni anuladas.
- `collected` suma las cobradas y `last_collected_at` es la fecha del último cobro (`null` si no hay ninguno).
- Una reserva sin facturas sale con ceros.
- Como mucho 500 ids por llamada. Si `reservation_ids` no es una lista o lleva un id inválido: `INVALID_OPERATION` (422).
- Solo importes y fecha: ni clientes, ni números de factura, ni datos internos.

## 8. Archivos

**Campos de archivo y recogida de huérfanos (contrato §3.9, migración 0217):** cada columna con `file_id` está declarada con su retención. Los documentos de facturas recibidas y emitidas son `legal` y nunca se borran solos. Las extracciones y el texto leído son `operational`, porque apuntan al mismo documento, que ya es `legal`. El ZIP de la gestoría es `temporary`, porque se regenera. La recogida está activada para Invoices: un huérfano espera 30 días.

**Almacenamiento por proveedor (contrato §3.9, migración 0215):** la Edge nunca llama a `/storage/v1/object…`. El ZIP de la gestoría descarga cada documento con `createStorage` del kit, usando el `storage_provider` de `core.files` que ahora devuelve `invoices.export_bundle`. El logotipo de Central se firma igual (`readUrl`, 10 minutos); su proveedor viene en `logo_provider` de la proyección de Central (#232).

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

**Fecha y objeto al importar sobre una factura ya creada** (decisión de Core, ronda 35): si lo escrito al subirla no coincide con el documento, la vista previa lo marca (`#dateDiscrepancy`, `#objectDiscrepancy`) y ofrece «Usar la del documento» o «Usar la mía» con un toque. La fecha del documento se preselecciona solo si la escrita era la de hoy por defecto, comparando con el día de creación en hora local (`importDateChoice`); si el usuario la cambió a mano, manda la suya. El objeto escrito manda siempre. Al aprender, un valor confirmado que no aparece en el documento no cuenta como fallo de la plantilla.

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

### 9.7 «Sugerencias y QA» y uso de funcionalidades (ronda 46, kit 0.18)

**Cáscara (`ui/shell.ts`):** monta `createFeedback`, `createFeedbackReview` y `createUsage` como en `packages/ui-kit/demo/adopcion.ts`. El panel de la marca de la cabecera lleva los interruptores «Señalar para comentar» y «Revisor de QA», este solo en la cuenta del dueño, y la entrada «Sugerencias y QA». No hay botón propio. Al cerrar sesión, `client.onSessionEnd` borra los borradores de feedback y el uso del dispositivo. El `<main>` lleva la pantalla actual como raíz de la ruta de etiquetas.

**Ids** (`data-feedback-id` y `data-feedback-label`): siguen la forma `invoices.<pantalla>.<sección>.<elemento>`, en minúsculas, sin acentos, con uno a cuatro niveles y sin ids de negocio. Siempre van en literal, así que el catálogo (`packages/ui-kit/scripts/feature-catalog.mjs --app invoices`) los recoge todos: 300 funciones y ningún id dinámico.
- **Pantallas:** `inicio`, `facturas` (recibidas y sus hojas), `emitidas` (lista, ficha, borrador, documento, series, asignar, CSV y registrar), `compras`, `gestoria`, `proveedores` y `conflictos`.
- **Cáscara:** `cabecera`, `navegacion` y `avisos`.
- **Cómo se marcan:** los controles propios llevan los atributos en su `el(...)`. Los bloques plegables usan `fbBlock`. Las filas de las listas del kit usan `fbRows`, que marca cada fila y excluye su nombre y su detalle. Los demás nodos del kit usan `fb(node, { feedbackId, feedbackLabel })`.

**Excluido** (`data-feedback-ignore`): ahí el gesto no se dispara y nada viaja en el reporte. Se excluyen:
- Los importes: totales, desgloses, líneas, campos de importe y resúmenes de Gestoría.
- Los NIF y los nombres de proveedores y clientes, en campos, filas y cabeceras de ficha.
- Los domicilios, las notas y los textos pegados (JSON y CSV).
- La procedencia de los datos leídos, la copia imprimible, la factura y los conflictos.

**Operaciones medidas** (`usage.run` o `usage.track`, en `app/usage.ts`):

| Pantalla | Operaciones |
|---|---|
| Facturas | `subir`, `leer_pdf`, `extraer`, `importar`, `validar`, `asignar`, `anular` |
| Emitidas | `guardar_borrador`, `emitir`, `rectificar`, `desde_reserva`, `guardar_cliente`, `registrar`, `importar_csv`, `asignar` |
| Gestoría | `generar_entrega`, `descargar`, `archivar_periodo` |

**Pruebas:**
- `tests/invoices/feedback-ids.test.ts`, estática: patrón, sin uuids ni partes dinámicas, cada id con su etiqueta, raíces conocidas y operaciones medidas.
- Recorrido en PC, en la prueba de aceptación:
  1. Interruptor del panel.
  2. Pulsación larga sin efecto con el modo apagado y sobre los importes excluidos.
  3. Formulario con la ruta «Inicio › Trimestre › Ir a Gestoría» y envío con el nodo estable.
  4. «Sugerencias y QA» con el reporte.
- Forma de los ids en todas las pantallas.

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

## 13. Facturas emitidas (ronda 21 · aprobada por Core en la ronda 22)

**Estado.** Construido el modelo y el registro manual: migración `20261006_0205_invoices_issued.sql`, dominio `_domain/invoices/issued.ts`, reglas en la Edge y pestaña «Emitidas» en la app. Tanda 14 (ronda 23): IVA repercutido en el resumen fiscal y en Gestoría, emitidas en la entrega a la gestoría (migración `0206`) y asignación a una reserva o un evento desde la ficha. Tanda 15 (ronda 26): importación desde CSV (Google Sheet) con mapeo de columnas, prompt de emitidas para ChatGPT y categorías de ingreso con IVA sugerido. Pendiente: la extracción automática de emitidas en la Edge, que llegará con la clave del proveedor.

**Alcance aprobado por el usuario.** Se **registran** las facturas emitidas con otra herramienta; la app **no emite** todavía. El modelo deja preparado lo común para emitir desde la app cumpliendo Verifactu, sin la parte de Verifactu: no hay huella, encadenado, firma ni envío a la AEAT. Prioridad: después de la #138 de la V1.

**Marco legal.** El sistema que **expide** una factura es el responsable de su registro Verifactu. Las facturas registradas aquí (`origin` `manual` o `importada`) ya tienen su registro en la herramienta que las emitió. Aquí son el **libro registro de facturas expedidas**: base del IVA repercutido, del modelo 303 y de la entrega a la gestoría. Los campos Verifactu de esas facturas quedan vacíos. Solo `origin = 'app'` los rellenará, cuando se construya la emisión. Los nombres y listas cerradas de abajo siguen el diseño de registro de la AEAT y hay que **confirmarlos contra la especificación técnica vigente** antes de construir la emisión.

### 13.1 Tablas (migraciones `0205+`, schema `invoices`)

Todas con las columnas de núcleo (`id, revision, created_at, updated_at, updated_by, deleted_at`) y `never_purge = true`: un registro fiscal no se purga. **Sin papelera** (revisión de Core): la Edge rechaza `delete` en `issued_invoices`, `issued_invoice_lines`, `issued_tax_lines` e `issued_invoice_files` con `ISSUED_NOT_DELETABLE`, y un trigger hace lo mismo en SQL. Una emitida solo se anula, con `invoices.annul_issued`. Las asignaciones del ingreso sí se pueden quitar.

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
| Identidad | `series_code text not null`, `number text not null`, `full_number text` generada (`A` + `2026-0001` → `A-2026-0001`; si el número ya empieza por la serie, el número tal cual) | `unique (upper(series_code), upper(number))` **sobre todas las filas**: ni anular ni nada libera un número. Al registrar, el número es el del documento; al emitir (futuro), lo asigna el procedimiento de §13.3. |
| Fechas | `issue_date date not null` (expedición), `operation_date date null` (si es distinta) | El periodo fiscal sale de `issue_date`, como en las recibidas (columnas generadas `fiscal_year`, `fiscal_quarter`). |
| Tipo | `invoice_type text not null`: `F1` completa · `F2` simplificada · `F3` sustitutiva de simplificadas · `R1`–`R5` rectificativas | Etiquetas en castellano en la app; los códigos siguen la lista de la AEAT. |
| Rectificación | `rectification_kind text null` (`S` por sustitución, `I` por diferencias), `rectified jsonb not null default '[]'` (`[{series, number, issue_date, issued_invoice_id?}]`), `rectification_reason text null`, `rectified_base numeric(14,2) null`, `rectified_quota numeric(14,2) null` | Obligatorios si `invoice_type` empieza por `R` (check). La referencia puede ser a una emitida registrada aquí (`issued_invoice_id`) o solo textual. |
| Destinatario | `recipient_name text null`, `recipient_tax_id text null`, `recipient_id_type text null` (`NIF`, o `02` NIF-IVA · `03` pasaporte · `04` documento oficial · `05` certificado de residencia · `06` otro), `recipient_country char(2) null`, `extra_recipients jsonb not null default '[]'` | En `F2` el destinatario puede faltar; en `F1` y `R*`, nombre e identificación obligatorios (check). |
| Contenido | `description text not null` (descripción de la operación), `notes text null` | |
| Importes | `base_total`, `quota_total` (IVA o IGIC repercutido), `surcharge_total` (recargo de equivalencia), `withholding_total` (IRPF y otras retenciones, en positivo), `total`, todos `numeric(14,2) not null`; `source_total numeric(14,2) null` | Recalculados desde líneas y desglose con la misma regla y tolerancia que las recibidas (`recalculate`, 0,02 €). `total = base + cuotas + recargo − retenciones`. |
| Estado | `status text not null`: `registrada` · `anulada`; `annulled_reason text null`; `review_reason text null` | Sin estados pendientes: se registra lo que ya se expidió. Si no cuadra, `review_reason = 'REVISAR IMPORTES'` y aviso, sin bloquear. |
| Origen | `origin text not null`: `manual` · `importada` · `app` (reservado); `external_tool text null`, `external_id text null`, `import_sha256 text null` | `importada` con `unique (external_tool, external_id)` para no duplicar. |
| Ingreso | `income_category text null`: `alojamiento` · `restauracion` · `actividades` · `eventos` · `tienda` (productos alimentarios) · `artesania` · `consultoria` (tecnológica) · `otros` | Confirmada por el usuario (ronda 26). Cada categoría tiene un **IVA sugerido** (`INCOME_CATEGORY_VAT`): alojamiento 10 %, restauración 10 %, tienda 10 %, actividades, eventos, artesanía, consultoría y otros 21 %. Es un valor de partida editable al dar de alta una línea, **no una regla fiscal**: el tipo correcto depende de la operación y lo confirma la gestoría. |
| Verifactu (reservados, vacíos) | `vf_record_kind` (`alta` · `anulacion`), `vf_hash` (huella SHA-256), `vf_previous_hash`, `vf_previous_ref jsonb` (serie, número y fecha del registro anterior), `vf_first_record boolean`, `vf_generated_at timestamptz` (fecha, hora y huso de generación del registro), `vf_status` (`pendiente` · `enviado` · `aceptado` · `aceptado_con_errores` · `rechazado`), `vf_csv` (código seguro de verificación de la respuesta), `vf_errors jsonb`, `vf_qr_url text`, `vf_system jsonb` (identificación del sistema informático) | Todos `null`. **No escribibles** por el cliente: el hook de la Edge los rechaza. Solo los escribirá el procedimiento de emisión (futuro). |
| Referencia de la otra herramienta | `external_qr_url text null`, `external_csv text null` | Opcional: QR o código de verificación que trae la factura emitida fuera, solo como referencia. |
| Emisor (ronda 37, migración `0209`) | `issuer_tax_id text null`, `issuer_name text null`, `issuer jsonb null` | Copia de la entidad de Central (`central.common_entity_projection`) **en el momento de registrar**: si después cambian los datos de la entidad, la emitida no cambia. `issuer_tax_id` e `issuer_name` son la identificación y la razón social del emisor que pide Verifactu. `issuer` guarda `entity_id`, `entity_revision`, nombre comercial, domicilio, contacto y `logo_file_id`, sin rutas de almacenamiento. **No escribibles** por el cliente (`INVALID_FIELDS`): los pone la Edge al insertar. Si la entidad no tiene datos, quedan `null` y la app avisa «Faltan los datos de la entidad en Central». |

**`invoices.issued_invoice_lines`**: `issued_invoice_id`, `position` (orden manual, como en recibidas), `description`, `quantity`, `unit`, `unit_price`, `discount_amount`, `net_amount`, `tax` (`iva` · `igic` · `ipsi` · `otros`), `vat_rate`, `vat_amount`, `surcharge_rate`, `surcharge_amount`, `gross_amount`, `notes`.

**`invoices.issued_tax_lines`**: el **desglose**, una fila por combinación de impuesto, régimen, calificación o exención y tipo. Campos: `tax` (`iva` · `igic` · `ipsi` · `otros`, o `irpf` · `otra_retencion` para retenciones), `regime_key` (clave de régimen, `01` general por defecto), `qualification` (`S1` sujeta no exenta · `S2` sujeta con inversión del sujeto pasivo · `N1` · `N2` no sujetas), `exemption` (`E1`–`E6` si exenta; excluye `qualification`), `rate`, `taxable_base`, `quota`, `surcharge_rate`, `surcharge_quota`. Las retenciones no forman parte del desglose de Verifactu, pero sí de la factura y del total.

**`invoices.issued_invoice_files`**: como `invoice_files` (documento PDF en `core.files`, verificado). Nombre canónico `AAAA_MM_DD_(cliente)_SERIE-NUMERO.pdf`; sin destinatario, `(sin_destinatario)`.

**`invoices.issued_allocations`**: vínculo con el **destino del ingreso**, normalmente una reserva o un evento de Booking. Campos: `issued_invoice_id`, `target_app` (`booking` · `general`), `target_kind` (`reservation` · `event` · `general`), `target_id`, `target_label`, `target_code`, `target_revision`, `allocated_amount`. Va **por factura**, no por línea, porque una factura de estancia suele ir entera a una reserva. Admite repartir el importe entre varias. Se resuelve con el mismo validador de destinos que las compras (`targets/booking`), con el token del usuario.

### 13.2 Reglas e invariantes

- `unique (series_code, number)` sobre todas las filas; un número no se reutiliza ni tras anular. Una anulada no se edita (`ISSUED_ANNULLED`).
- Las rectificativas exigen `rectification_kind`, al menos una referencia en `rectified` y motivo. `R5` rectifica simplificadas.
- Importes recalculados en el hook `invoices.check_invariants`, como en las recibidas: el desglose cuadra con las líneas y el total con el desglose dentro de 0,02 €. Si no cuadra se marca `REVISAR IMPORTES`, sin bloquear el registro, porque la factura ya existe fuera.
- `vf_*` solo por procedimiento; `origin = 'app'` solo por el procedimiento de emisión (rechazado hoy con `UNSUPPORTED_IN_V1`).
- Editar una emitida registrada deja traza en el historial del núcleo. Anularla pide motivo y retira sus asignaciones. No se borra.
- **Agentes:** registrar o anular emitidas **exige aprobación** (no se marca como seguro); leerlas, no.

### 13.3 Numeración por serie

Al **registrar**, el número viene del documento y solo se comprueba que no esté repetido. Para la **emisión futura** hace falta numeración correlativa sin huecos por serie y año, asignada en la misma transacción que el alta. `core.next_code` ya usa un contador por prefijo y año que no deja huecos si se llama dentro de la transacción del alta, pero devuelve un formato fijo (`PREFIJO_AAAA_NNN`). **Petición a Core:** `core.next_number(p_prefix text, p_year int) returns int`, con el mismo contador y sin formato, para que la serie aplique su plantilla. Aprobada por Core (ronda 22); Core la añade cuando se construya la emisión desde la app, que es la única que la necesita. El registro manual no la usa.

### 13.4 Procedimientos y rutas

- `invoices.register_issued(p)`: alta manual o importada de una factura con líneas, desglose, documentos y asignaciones en un lote, con ids del cliente para funcionar sin red. Equivale a `import_v1` para las emitidas.
- `invoices.annul_issued(p)`: anula una emitida con motivo.
- `invoices.take_issuer {ids}` (ronda 38, migración `0210`, owner y editor): «Tomar el emisor actual». Copia la entidad de Central en las emitidas indicadas que **no tienen emisor**, hasta 500 por llamada. Nunca sobrescribe un emisor existente y no toca las anuladas, que no se editan. La copia la pone la Edge en `args.issuer`; lo que mande el cliente se descarta. Sin datos en Central: `ENTITY_MISSING`. Devuelve `{filled: [id], skipped: [{id, reason: not_found · has_issuer · annulled}]}` y cada fila queda en el historial con quién lo hizo. En la app: botón en el aviso de la ficha y aviso en la lista («N emitidas sin emisor · Completar con los datos de Central»).
- **Importación desde CSV** (hecho, ronda 26: el usuario lleva las emitidas en un Google Sheet). Botón «Importar CSV» en Emitidas. Se pega el CSV o las filas copiadas, o se sube el archivo, con `;`, `,` o tabulador y comillas.
  - **Columnas:** la app adivina qué columna es cada campo por el nombre de la cabecera (`guessMapping`): serie, número, fechas, tipo, cliente, NIF, concepto, categoría, base, tipo y cuota de IVA, retención, total y cobrada. El usuario lo corrige en la propia hoja y el mapeo **se recuerda** por nombre de cabecera para la próxima vez.
  - **Conversión:** acepta importes y fechas en formato español. Sin columna de serie usa una por defecto, la más usada, y si la serie no existe la crea. Sin tipo, F1 con NIF y F2 sin él. Sin IVA, toma el de la categoría con aviso. Las filas con la misma serie y número forman una sola factura, una línea por tipo de IVA.
  - **Vista previa:** marca cada factura como nueva, ya registrada (no se duplica) o con errores (fecha no reconocida, F1 sin NIF, rectificativas, que se registran a mano), con avisos si el total no cuadra.
  - **Registro:** se importa en lotes con operaciones de fila (`issuedImportOperations`, también sin red), `origin = 'importada'` y `external_tool` igual a `google_sheet`. Todo en `_domain/invoices/issued-csv.ts`.
- **PDF con ChatGPT** (hecho): en «Nueva emitida», al elegir el PDF aparece «Extraer con ChatGPT». El prompt de emitidas (`ISSUED_EXTRACTION_PROMPT`) pide una línea CSV con la cabecera de la plantilla por factura (y por tipo de IVA). «Pegar CSV» abre la misma importación con el PDF adjunto y `external_tool = 'chatgpt_pdf'`. La extracción automática de emitidas en la Edge llegará con la clave del proveedor.
- **Resumen de emitidas** (hecho): lectura `invoices.issued_summary` (periodo como `fiscal_summary`) e `issuedSummary` en el dominio, con la misma forma: registradas y anuladas, base, **IVA repercutido**, recargo, retenciones y total; cuotas por impuesto y tipo; ingresos por categoría; y alertas (sin cobrar, importes por revisar, sin documento). Gestoría muestra la tarjeta «Emitidas · IVA repercutido» y «IVA del periodo» (repercutido menos soportado de las validadas, orientativo). La herramienta MCP `invoices_fiscal_summary` lo devuelve en `issued`.
- **Gestoría** (hecho, migración `0206`): el manifest añade `issued_count`, `issued_file_count`, `issued_totals` e `issued`, con registradas y anuladas para que se vea la numeración completa. Los documentos van en `emitidas/` dentro del ZIP, con su hash. Los CSV añaden `facturas_emitidas.csv`, y `resumen_impuestos.csv` suma las filas repercutidas y la diferencia. Una entrega solo con emitidas ya no es `EXPORT_EMPTY`. La entrega queda desfasada si cambia una emitida incluida o aparece una nueva del periodo. Las entregas anteriores conservan su manifest.
- **Entidad emisora** (ronda 37): `GET /api/v1/entity` (cualquier rol) devuelve `{ entity, logo_url, logo_mime }`. `entity` es la copia que se guardaría como emisor, o `null` si Central aún no tiene los datos. Se lee con `core.read('invoices', …, 'central.common_entity_projection')`. El logotipo está en el bucket privado `central-documents`: la Edge firma una URL de 10 minutos con la clave de servicio y no la guarda. La ficha de la emitida muestra el bloque «Emisor» y «Imprimir copia» abre la página imprimible del kit, marcada **«COPIA DE REGISTRO»** y con la nota de que la original la expidió otra herramienta: no es una segunda factura.
- Proyección para Booking: `invoices.booking_income_projection` (`issued_invoice_id`, `full_number`, `issue_date`, `target_kind`, `target_id`, `allocated_amount`, `status`), registrada con `core.allow_read('booking', …, 'view')`. Así Booking muestra el **ingreso real** de cada reserva junto al coste real que ya lee.
- MCP: `invoices_register_issued` (editor, siempre con propuesta para agentes) e `invoices_sales` (lectura).

### 13.5 Pantallas (propuesta)

- **Facturas** pasa a tener dos pestañas, **Recibidas · Emitidas**, con la misma lista por mes y la misma ficha. Así no añadimos una quinta entrada a la navegación del móvil.
- **Ficha de emitida:** serie y número, tipo y rectificación, destinatario, líneas reordenables, desglose, documento, destino (reserva o evento), estado y origen. Un bloque «Verifactu» plegado dice «Registrada con otra herramienta» o, en el futuro, el estado del registro.
- **Nueva emitida:** serie (con «+ Nueva serie…» en la propia hoja, como el proveedor), número, fechas, destinatario, líneas y documento. También «Importar» para el JSON de la otra herramienta y «Extraer con ChatGPT» con un prompt de emitidas.
- **Gestoría:** resumen con IVA repercutido, soportado y diferencia por trimestre.

### 13.6 Qué queda fuera ahora (preparado, sin desarrollar)

Huella y encadenado, firma, registros de alta y de anulación de Verifactu, envío y respuesta de la AEAT, QR, declaración responsable del sistema informático y modalidad «no Verifactu». Los campos `vf_*`, `origin = 'app'`, `issued_series.format` y `core.next_number` quedan listos para que la emisión sea un procedimiento nuevo y no una migración del modelo. **Actualización (ronda 40):** la emisión desde Finance está aprobada por el usuario; la propuesta está en §14.

### 13.7 Preguntas abiertas

1. **Usuario:** qué herramienta emite hoy las facturas y en qué formato exporta.
2. **Usuario:** si la lista de categorías de ingreso (`alojamiento`, `restauracion`, `actividades`, `eventos`, `otros`) le sirve.
3. **Core:** visto bueno a `core.next_number` (§13.3) y a la proyección de ingresos para Booking.
4. **Core y usuario:** si las emitidas van como pestaña dentro de Facturas (propuesta) o como entrada propia en la navegación.

## 14. Emitir facturas desde Finance (aprobada por Core en la ronda 41 · PR 1, 2 y 3 hechos)

Base: `coordinacion/ampliacion/FACTURACION.md`, aprobado por el usuario el 7-10-2026. Ikisai factura como autónomo, con una serie nueva desde la primera factura de la app. La hoja de Google deja de emitir y su serie se cierra.

Documentación oficial usada, descargada el 7-10-2026 de la sede de la AEAT (portal de desarrolladores, «Sistemas Informáticos de Facturación y Sistemas VERI*FACTU»):

| Documento | Versión | Para qué |
|---|---|---|
| Especificaciones de la huella o «hash» de los registros | 0.1.2 | Cadena de entrada, SHA-256 y ejemplos oficiales (§14.6) |
| Especificaciones técnicas del código QR de la factura | 0.5.0 | URL de cotejo, parámetros, tamaño y posición (§14.5) |
| Descripción de los servicios web | 1.0.3 | Envío y respuesta (fuera de esta fase) |
| Esquemas `SuministroLR.xsd`, `SuministroInformacion.xsd`, `RespuestaSuministro.xsd`, `EventosSIF.xsd` | tikeV1.0 | Campos de los registros de alta, anulación y evento |

Normas: Reglamento de facturación (RD 1619/2012) y Reglamento de sistemas de facturación (RD 1007/2023, con el RDL 15/2025).

### 14.1 Principios

- **El número lo pone el servidor al emitir, nunca el dispositivo.** Una factura nace como **borrador** sin número, que se edita y sincroniza sin red como cualquier fila. «Emitir» es un procedimiento que, en una sola transacción, asigna el número, fija la fecha de expedición, congela los datos, copia el emisor de Central y genera el registro de alta con su huella. Si algo falla no se emite nada, así que no quedan huecos.
- **Sin red**, «Emitir» se encola como cualquier `call`. La app muestra «Se emitirá al conectar» y el número aparece al sincronizar. Si el servidor la rechaza (por ejemplo, porque falta el NIF del destinatario), sigue en borrador con el motivo.
- **Una emitida no se edita.** Solo cambian el cobro, las notas internas, los documentos adjuntos y el destino del ingreso. Para corregirla se hace una **rectificativa**.
- **Registro VERI*FACTU desde la primera factura, sin enviar.** Se guarda cada registro de alta y de anulación con la huella encadenada. El envío lo enciende solo el owner (§14.7).
- **Registro y emisión no se mezclan.** Las emitidas registradas de otra herramienta (§13) siguen como histórico, en sus series. Una serie es o de registro o de emisión.

### 14.2 Series y numeración

`invoices.issued_series` gana `mode` (`registro` · `emision`), `closed_at` y `closed_last_number`. Las series que ya existen pasan a `registro`.

- **Series de emisión propuestas:** `F` para las ordinarias y `R` para las rectificativas, con reinicio anual. Formato `{serie}{año}-{n:4}`, que da `F2026-0001` y `R2026-0001`. Si el usuario quiere tiques, se añade `T` para las simplificadas (§14.9, pregunta 1). El código y el formato los elige el usuario en Ajustes antes de la primera emisión, y después no se cambian.
- **Contador** (hecho así en el PR 1): columnas `counter_year`, `counter_last` y `counter_last_date` de la propia serie. Solo las escribe el procedimiento de emisión, que bloquea la fila de la serie con `for update`. Así dos emisiones a la vez nunca reciben el mismo número ni dejan hueco. El contador se sincroniza, así que la app puede mostrar el próximo número. No hace falta `core.next_number` (§13.3).
- **Numeración del usuario (ronda 47, migración 0218):** es un dato de la serie, no del código.
  - **Formato:** admite `{serie}`, `{año}`, `{aa}` (año en dos cifras) y `{n}` o `{n:K}`, que rellena con ceros hasta K cifras sin recortar (`F_100_26`).
  - **Año de validez:** `valid_year` hace que la serie solo emita en ese año (`SERIES_YEAR_MISMATCH`).
  - **Comienzo:** `invoices.series_start {code, last_number, year}` (editor y owner) fija el último número ya emitido fuera de Finance. Solo vale mientras la serie no tenga emitidas (`SERIES_IN_USE`).
  - **2026:** la serie `F` con formato `{serie}_{n:2}_{aa}` y último número 2 continúa la hoja (`F_02_26` → `F_03_26`). Las rectificativas, `R_01_26`. **Sembradas por la migración 0219** con `invoices.seed_series_2026()`, que usa `core.apply_migration_operations` y deja cambio en `core.changes`. Si ya existe una serie con ese código, no hace nada. Solo se ejecuta si Invoices ya tiene miembros, como en producción; en una base recién creada para pruebas no siembra, porque el núcleo comprueba allí el cursor inicial.
  - **Ajustar:** una serie se puede ajustar, en formato y comienzo, mientras no tenga facturas emitidas, aunque ya tenga un último número puesto.
  - **2027:** se crea la serie del año (`F2027` con `{serie}-{n:4}`, que da `F2027-0001`). La app solo ofrece las series del año en curso.
  - **En «Series»:** al crear una serie se elige el formato (estándar o «como la hoja») y el último número emitido, con la siguiente a la vista. Una serie sin emitidas se puede ajustar.
- **Orden de fechas:** la fecha de expedición es la de hoy en hora de Madrid, y nunca anterior a la última emitida de la serie. Así número y fecha van siempre en el mismo orden. La fecha de la operación puede ser otra, por ejemplo la salida de una reserva.
- **Cierre de la serie de la hoja:** `invoices.close_series {code, last_number}` (owner) marca la serie como cerrada en ese número. Desde entonces no admite más emitidas, ni registradas ni importadas.
- **Formato del número:** solo caracteres ASCII imprimibles y como mucho 60, como piden el XSD y el QR.

### 14.3 Estados y procedimientos

`issued_invoices.status` añade `borrador`, `emitida` y `rectificada` a los actuales `registrada` y `anulada`. `number` admite `null` solo en borrador.

| Paso | Procedimiento | Quién | Qué hace |
|---|---|---|---|
| Borrador | filas normales | editor, owner | Cabecera, destinatario, líneas y destino. Sin número. Se puede borrar. |
| Emitir | `invoices.issue {id, expectedRevision}` | editor, owner; agentes con aprobación | Comprueba los datos obligatorios (§14.4), recalcula importes y desglose, asigna número y fecha, copia el emisor, congela y genera el registro de alta. Devuelve `{full_number, issue_date, vf_hash}`. |
| Rectificar | `invoices.rectify {id, kind, reason_code, reason, lines?}` | editor, owner | Crea un **borrador** de rectificativa en la serie `R` que apunta a la original. Se emite con `invoices.issue`. Al emitirse, la original pasa a `rectificada`. |
| Anular | `invoices.annul_issued {id, reason}` | **solo owner** | Solo para una factura que no debió emitirse y no llegó al cliente. Genera el registro de anulación. El número queda ocupado. Si la factura ya se entregó, lo correcto es rectificar. |

- **Rectificativas:** códigos `R1`–`R4` según el motivo (art. 80 de la Ley del IVA) y `R5` para simplificadas. **Por sustitución (`S`)** repite la factura completa con los datos correctos y guarda la base y la cuota rectificadas. **Por diferencias (`I`)** lleva solo la diferencia, que puede ser negativa. Propongo «por diferencias» por defecto, con las líneas de la original en negativo, para que una devolución total quede en un toque.
- **Borrar borradores:** los borradores sí se borran (`delete`). Las emitidas siguen sin papelera, como en §13.
- **Agentes:** emitir, rectificar y anular exigen siempre aprobación.

### 14.4 Datos y documento

Campos nuevos en la cabecera:
- `recipient_address jsonb`: `{line, postal_code, city, province, country}`. Es obligatoria salvo para un particular.
- `recipient_kind`: `empresa` · `profesional` · `particular`.
- `prices_include_vat boolean`, para tarifas con IVA incluido.
- `issued_at timestamptz` y `issued_by`.
- `document jsonb`: la copia congelada de todo lo que se imprime.
- `rectified_by jsonb`: las rectificativas emitidas sobre esta factura.
- `purpose`: concepto del cobro (`senal` · `saldo` · `extras` · `general`; migración 0221). Se elige en el borrador o al registrar, y se puede cambiar en una emitida, porque no se imprime ni forma parte del registro. La lista muestra una etiqueta («Señal») y el portal de organizadores la usa para rotular la factura (§7.7).

Las líneas ya tienen cantidad, unidad, precio unitario, descuento y tipo (§13.1). El desglose añade `exemption_note` para la mención de exención.

**El documento** se pinta con la página imprimible del kit a partir de `document`, así que siempre sale igual. «Descargar PDF» usa la impresión del navegador.

- **Datos obligatorios** (art. 6 del RD 1619/2012), comprobados al emitir:
  1. Serie y número, y fecha de expedición.
  2. Fecha de la operación, si es distinta.
  3. Emisor con nombre y apellidos, NIF y domicilio, tomados de Central.
  4. Destinatario con nombre o razón social, NIF y domicilio. El domicilio no hace falta para un particular.
  5. Descripción de las operaciones, con base, precio unitario sin impuesto y descuentos.
  6. Tipo de IVA y cuota de cada tipo, por separado.
  7. Menciones de exención o de inversión del sujeto pasivo, cuando proceda.
- **Simplificadas** (art. 7): no exigen los datos del destinatario. El límite es de 400 €, o de 3.000 € en hostelería y restauración (art. 4).
- **PDF en el servidor:** fuera de esta fase. Hará falta para enviar la factura por correo, con una biblioteca de PDF en la Edge.

### 14.5 Código QR y leyenda

- **URL de cotejo:** se calcula y se guarda al emitir, aunque el envío esté apagado. En producción es `https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=…&numserie=…&fecha=DD-MM-AAAA&importe=N.NN`, con los parámetros codificados en UTF-8 como URL. En pruebas, `https://prewww2.aeat.es/…`.
- **Mientras el envío esté apagado** no se imprime ni el QR ni la leyenda «VERI*FACTU». La AEAT no tendría el registro y el cotejo diría «no encontrada».
- **Con el envío encendido**, se imprimen:
  1. El texto «QR tributario:» encima del código.
  2. Un QR de 30 a 40 mm con corrección de errores de nivel M y al menos 2 mm de margen, arriba en la primera página.
  3. La leyenda «Factura verificable en la sede electrónica de la AEAT» o «VERI*FACTU» debajo.
- **Generación del QR:** en el dispositivo, con una biblioteca pequeña cargada bajo demanda, igual que PDF.js.

### 14.6 Registro VERI*FACTU (tablas)

**`invoices.vf_records`** guarda una fila por registro de alta o de anulación. Solo la escriben los procedimientos de emisión y anulación. No se edita ni se borra (`never_purge`). Todos los roles la leen.

| Grupo | Campos |
|---|---|
| Identidad | `id`, `seq bigint` (orden en la cadena, único), `record_kind` (`alta` · `anulacion`), `issued_invoice_id` |
| Datos de la huella | `issuer_tax_id`, `num_serie`, `issue_date_text` (`DD-MM-AAAA`), `invoice_type` (solo alta), `quota_total`, `amount_total` (solo alta) |
| Cadena | `first_record boolean`, `previous_hash`, `previous_ref jsonb` (NIF, número y fecha del anterior), `generated_at_text` (`FechaHoraHusoGenRegistro`: `AAAA-MM-DDThh:mm:ss+01:00` en hora de Madrid), `hash` (64 caracteres hexadecimales en mayúsculas) |
| Contenido | `payload jsonb`: el registro completo con la forma de `RegistroAlta` o `RegistroAnulacion` del XSD (desglose, destinatarios, rectificación, sistema informático), listo para el XML |
| Envío | `send_status` (`no_enviar` · `pendiente` · `enviado` · `aceptado` · `aceptado_con_errores` · `rechazado`), `sent_at`, `csv`, `errors jsonb` |

- Un disparador impide cualquier cambio salvo en los campos de envío.
- **Huella de alta:** se concatena `IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=…&TipoFactura=…&CuotaTotal=…&ImporteTotal=…&Huella=<anterior>&FechaHoraHusoGenRegistro=…`. Los valores van sin espacios al principio ni al final, y un campo vacío queda como `Nombre=`. Se aplica SHA-256 sobre UTF-8, con salida en hexadecimal y en mayúsculas.
- **Huella de anulación:** la misma cadena con `IDEmisorFacturaAnulada`, `NumSerieFacturaAnulada`, `FechaExpedicionFacturaAnulada`, `Huella` y `FechaHoraHusoGenRegistro`.
- **Dónde se calcula:** en SQL con `pgcrypto`, dentro de la transacción de la emisión. La cabeza de la cadena se bloquea, así que dos emisiones a la vez se encadenan en orden. Hay también una versión en el dominio TypeScript para comprobar y para generar el XML.
- **Pruebas:** las dos implementaciones se prueban con los **tres ejemplos oficiales** de la especificación 0.1.2, que ya he comprobado:

```
alta      3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60
alta      F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97
anulación 177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68
```

**Cómo quedó en el PR 1:** las tablas `vf_records`, `vf_events` y `vf_state` están registradas en el núcleo **sin roles de lectura ni escritura**, así que no llegan al dispositivo ni se escriben con operaciones de fila. La Edge rechaza cualquier operación sobre ellas (`VF_SERVER_ONLY`) y un disparador impide cambiarlas fuera de los procedimientos (`VF_IMMUTABLE`). La cabeza de la cadena, el interruptor y la identificación del sistema van juntos en `vf_state`, una sola fila. La app consulta el registro de una emitida con la lectura `invoices.vf_records_of {issued_invoice_id}`, que devuelve `{records: [{seq, record_kind, hash, previous_hash, generated_at_text, send_status, csv}], settings: {sending, locked_until}}`.

**`invoices.vf_events`** es el registro de eventos con su propia cadena (`HuellaEvento`). Guarda el arranque del sistema, el cambio del interruptor, las exportaciones y las incidencias. En la modalidad VERI*FACTU no es obligatorio, pero cuesta poco y deja traza del interruptor.

La identificación del sistema informático (`SistemaInformatico` del XSD) va en `vf_state`:
- El productor, que es el propio autónomo (nombre y NIF, tomados de Central).
- `NombreSistemaInformatico = "Ikisai Finance"` e `IdSistemaInformatico = "IF"`.
- La versión, que es la de la publicación de la app.
- `NumeroInstalacion`, un uuid fijo de esta instalación.
- `TipoUsoPosibleSoloVerifactu = S`, `TipoUsoPosibleMultiOT = N` e `IndicadorMultiplesOT = N`.

La **declaración responsable** va dentro de la app (Ajustes › Acerca de), redactada con los ejemplos de la AEAT, y no se presenta.

**Fuera de esta fase:** el XML, la firma, el envío por servicio web con certificado y la consulta. Todo eso parte de `payload` y de `send_status`.

### 14.7 Interruptor del owner (Ajustes)

`invoices.vf_state` guarda:
- `sending` (`apagado` · `pruebas` · `produccion`).
- `enabled_at` y `enabled_by`.
- `locked_until`, el 31-12 del año en que se encendió producción.

Lo cambia `invoices.vf_set_sending {mode, confirmation}`. **Solo el owner** puede llamarlo, y **ningún agente**, ni con aprobación.

- **`pruebas`:** envía al portal de pruebas externas de la AEAT. Sirve para ensayar cuando se acerque la fecha y se apaga cuando se quiera.
- **`produccion`:** la app pide escribir la frase «Entiendo que debo seguir enviando hasta el 31 de diciembre». Desde ese momento no se puede apagar hasta `locked_until`. Los registros con `no_enviar` del año en curso pasan a `pendiente`.
- **Apagado** (hoy): los registros nacen como `no_enviar`, y la factura no lleva ni QR ni leyenda.
- **Eventos:** cada cambio del interruptor genera un evento en `vf_events`.

### 14.8 Facturar desde una reserva (contrato con Booking, por medio de Core)

Propongo una **lectura** y no una escritura entre funciones. Booking no crea filas en Finance; Finance lee de Booking lo que necesita para el borrador.

1. **En Booking**, «Emitir factura» en la reserva abre `https://finance.ikisai.com/#/facturas?vista=emitidas&desde=booking:reservation:<id>`. Con la sesión única no pide contraseña.
2. **Finance** llama a `core.read('invoices', …, 'booking.reservation_invoice_source', {reservation_id})`, que Booking registra para `invoices`. La lectura devuelve:
   ```
   { reservation: {id, code, label, revision, check_in, check_out},
     customer: {name, tax_id, id_type, country, address: {line, postal_code, city, province, country}, kind},
     prices_include_vat: boolean,
     lines: [{ kind: 'tarifa' | 'extra', description, quantity, unit, unit_price, discount_amount, vat_rate, income_category }],
     invoiced: [{ issued_invoice_id, full_number, status, total }] }
   ```
   El campo `invoiced` sale de la proyección de ingresos que Booking ya lee (§13.4).
3. **Finance** crea un **borrador** con esas líneas y lo asigna a la reserva. Si la reserva ya tiene un borrador o una emitida no rectificada, la abre en lugar de duplicarla. El usuario revisa el borrador y lo emite.
4. **Sin red**, Finance pide conexión, porque necesita los datos actuales de la reserva.

**Cómo quedó (PR 4, ronda 45; Booking: `docs/booking/API.md` §19, migración 0444):**
- **Entrada:** el panel de Emitidas lee `desde=booking:reservation:<id>` al cargar y lo quita de la URL.
- **Factura ya existente:** si la reserva ya tiene un borrador, una emitida o una registrada asignada, la abre y lo avisa. No crea otra.
- **Si no existe:** lee la reserva, con conexión. Rellena el borrador con el cliente (nombre y tipo), el concepto («código · título»), la fecha de la operación (la salida), la categoría dominante y las líneas.
  - Categorías: `extras` y `servicios` de Booking pasan a `otros`.
  - Tipo de cliente: `particular` sigue igual. Asociación, colectivo, empresa y organizador pasan a `empresa`, que exige NIF y domicilio.
- **IVA incluido:** Booking da los precios con IVA incluido. El borrador lo marca (`prices_include_vat`) y guarda cada línea con su base y su **cuota exacta** (`vat_amount`), así que la factura suma exactamente el importe de la reserva. El editor muestra los precios con IVA y los convierte al guardar (`draftLineFromPrice`).
- **Datos fiscales:** Booking no guarda el NIF ni el domicilio fiscal. Los escribe el usuario en el borrador, y el aviso de la hoja se lo pide.
- **Asignación:** al guardar, el borrador queda asignado a la reserva (`issued_allocations`, destino `booking/reservation`) por su base.
- **`invoiced`:** Booking lo devuelve `null`. Finance lo calcula con sus propias asignaciones.
- **Directorio de clientes (hecho, ronda 46, migración 0216):** tabla sincronizada `invoices.customers`, con un NIF por país.
  - **Datos:** `name`, `tax_id` normalizado (mayúsculas, sin espacios, puntos ni barras), `id_type`, `country`, `kind` y `address`, que es el domicilio fiscal. Ningún otro dato personal.
  - **Permisos:** escriben el editor y el owner.
  - **En el borrador:** «Cliente guardado» busca por nombre, sin acentos, o por NIF. Al elegir un cliente rellena el NIF, el tipo y el domicilio. Al escribir un NIF guardado se completa lo que falte sin pisar lo escrito. Desde una reserva, si el nombre casa con un cliente guardado, se sugiere al abrir.
  - **Al emitir:** si el NIF es nuevo, se ofrece guardar el cliente. Si ya existe pero cambiaron el nombre, el tipo o el domicilio, se ofrece actualizarlo (`customerOffer`).
  - **Booking** no guarda datos fiscales. Más adelante podría enlazar el cliente.

La alternativa sería que Booking cree el borrador llamando a la Edge de Finance. La descarto porque añade escrituras entre funciones y deja un borrador sin revisar en otra app.

### 14.9 Preguntas (respondidas el 7-10-2026)

1. **Simplificadas (tiques):** no, por ahora (usuario y gestoría). Si llegan, se añade la serie `T` con sus límites.
2. **Series:** `F` y `R` con el formato `F2026-0001`, empezando en 1. **La serie de la hoja de Google no se cierra:** la gestoría confirma emitir con programa propio desde ya y con serie nueva, así que no hace falta su último número. «Cerrar serie» queda para las series de registro que el usuario quiera cerrar.
3. **QR y leyenda:** no se imprimen mientras el envío esté apagado (Core, ronda 41).
4. **Documento:** se imprime desde el navegador; el PDF del servidor, más adelante (Core, ronda 41).
5. **Lectura de Booking:** publicada (#225); Finance la usa desde el PR 4 (§14.8).
6. **Envío real:** XML, firma y certificado, cuando se acerque la fecha, junto con el interruptor (Core, rondas 41 y 43). La gestoría confirma VERI*FACTU solo cuando sea obligatorio.

### 14.10 Errores del PR 1

| Código | Cuándo |
|---|---|
| `ISSUE_REQUIRES_PROCEDURE` | Se crea una factura con número, o como registrada, en una serie de emisión; o se le pone número a un borrador. |
| `SERIES_NOT_ISSUING` | Se emite, o se crea un borrador, en una serie de registro. |
| `SERIES_KIND_MISMATCH` | El tipo de factura no corresponde a la serie: ordinarias, rectificativas o simplificadas. |
| `SERIES_CLOSED` · `SERIES_IN_USE` | La serie está cerrada, o ya ha emitido y se intenta cambiar su código, modo, formato o reinicio. |
| `ISSUE_MISSING_DATA` | Faltan datos obligatorios. `details.missing` los lista: `lines`, `recipient_name`, `recipient_tax_id`, `recipient_address`, `rectified`, `rectification_kind` o `rectification_reason`. |
| `ENTITY_MISSING` | Central no tiene los datos del emisor, o le falta el domicilio. |
| `ISSUED_NOT_DRAFT` · `ISSUED_IS_DRAFT` | Se emite algo que no es borrador, o se anula un borrador, que se borra. |
| `ISSUED_FROZEN` | Se cambia una emitida o sus líneas o su desglose. Solo cambian el cobro, las notas y la categoría. |
| `ISSUE_DATE_ORDER` | La serie ya tiene una factura con fecha posterior a hoy. |
| `VF_SERVER_ONLY` · `VF_IMMUTABLE` | Alguien intenta escribir o cambiar el registro VERI*FACTU. |

### 14.11 Plan de PR

1. **Modelo y emisión (hecho):** migración `0212` (series de emisión con su contador, estados, borradores, congelado, y resúmenes y entregas que cuentan las emitidas y no los borradores) y `0213` (`vf_records`, `vf_events`, `vf_state`, huella y QR en SQL), `invoices.issue`, `invoices.close_series`, la anulación de una emitida con su registro y pruebas con los ejemplos oficiales en SQL y en TypeScript (`_domain/invoices/verifactu.ts`).
2. **App (hecho, `apps/invoices/src/ui/issuing.ts`):**
   - «Nueva factura» crea un borrador. Lleva el destinatario con su tipo, el NIF y el domicilio, el concepto, la fecha de la operación, la categoría y líneas con cantidad, precio sin IVA y tipo.
   - La ficha del borrador permite editar, ver la vista previa marcada «BORRADOR · SIN VALOR», borrar y «Emitir». Antes de emitir avisa de los datos que faltan y dice qué número recibirá.
   - La emitida se ve congelada. «Factura (PDF)» pinta la factura desde `document`, sin QR ni leyenda, porque el envío está apagado.
   - «Series» crea las series de emisión `F` y `R` con el formato `{serie}{año}-{n:4}`. El owner puede cerrar las series de registro. También muestra el estado del registro VERI*FACTU.
   - «Registrar emitida» solo ofrece series de registro abiertas.
   - **El interruptor no se ha construido.** Encender «producción» obliga a enviar hasta el 31-12, y el envío (XML, firma y certificado) aún no existe. La pantalla muestra el estado, apagado, y se activará junto con el envío.
3. **Rectificativas (hecho, migración `0214`):**
   - `invoices.rectify {id, kind = I | S, reason_code = R1–R4, reason}` (editor y owner) crea un **borrador** en la serie de rectificativas. Solo vale para una emitida o rectificada desde Finance; si no, devuelve `RECTIFY_NOT_ISSUED`. Si no hay serie de rectificativas devuelve `SERIES_MISSING`. Una simplificada se rectifica con `R5`.
   - **Por diferencias:** copia las líneas en negativo.
   - **Por sustitución:** las copia en positivo para corregirlas y guarda la base y la cuota rectificadas.
   - En `rectified` queda la original con su id, número y fecha. El destinatario se copia.
   - **Al emitir la rectificativa,** la original pasa a `rectificada` y anota la rectificativa en `rectified_by`. Sigue congelada y se puede volver a rectificar.
   - El registro de alta lleva `TipoRectificativa`, las facturas rectificadas y, si es por sustitución, `ImporteRectificacion`.
   - **Base negativa:** la regla del ingreso asignado ahora solo aplica si hay algo asignado, porque una rectificativa por diferencias tiene base negativa.
   - **En la app:** «Rectificar» en la ficha de una emitida pide el tipo, la causa y el motivo. El borrador conserva su tipo y su serie y explica qué rectifica. La factura impresa dice de qué factura es rectificativa, con el motivo.
   - **Anulación:** la anulación del owner con su registro ya estaba en el PR 1.
4. **Desde Booking (hecho, ronda 45):** ver «Cómo quedó» en §14.8. El editor admite además descuento por línea y «Precios con IVA incluido» en cualquier factura.

## 15. Facturas recibidas por Google Drive (fase 4 · migración 0224 · aprobada por Core el 8-10-2026)

**Qué hace:** el usuario, la gestoría o un proveedor (por reenvío) deja PDF en la carpeta **«Entrada»** de la unidad compartida «Ikisai · Lectura de facturas». Finance los importa solos como facturas recibidas, leídas si el PDF tiene texto. **Validar sigue siendo cosa de una persona.**

**Configuración:**
- Secretos de la Edge: `GOOGLE_SERVICE_ACCOUNT_JSON` (cuenta de servicio, firma común `createGoogleTokenSource` del kit) e `INVOICES_DRIVE_ID` (id de la unidad compartida).
- Sin ellos, la integración queda apagada (`not_configured`).
- **Solo la Drive API**, gratuita dentro de su cuota. Ningún servicio de pago de Google.

**Disparo:**
- `core.schedule_tick('invoices', 'drive/tick', '*/15 * * * *', 'invoices.drive_has_work')`, que llama a `POST /api/v1/worker/drive/tick` (clave de worker).
- La sonda no puede ver Drive desde SQL. Decide por tiempo (14 minutos desde la última búsqueda), por lo que quedó pendiente (`more`) o porque el owner pulsó «Buscar ahora» (`POST /api/v1/drive/run`, solo owner).
- Cada tick procesa como mucho **5 archivos**.
- Un tick sin archivos hace **una sola llamada** a Drive: los ids de las carpetas se guardan en `drive_state`.
- `drive_runs.api_calls` registra las llamadas de cada ejecución.

**Carpetas:** «Entrada», «Importadas», «Duplicadas» y «Con errores», dentro de `INVOICES_DRIVE_ID`. Mover es cambiar el padre. **Nunca se borra ni se manda a la papelera nada.**
- `INVOICES_DRIVE_ID` puede ser una **unidad compartida** o una **carpeta de un usuario compartida con la cuenta de servicio** (así está en producción desde el 9-10-2026).
- Se busca y se lista con `corpora=allDrives`, que vale para las dos.
- En una unidad compartida, las subcarpetas que falten se crean.
- En la carpeta de un usuario **no se pueden crear**: la cuenta de servicio no tiene cuota de almacenamiento. Si falta «Importadas», «Duplicadas» o «Con errores», el tick termina en `blocked` con el aviso «Crea en tu carpeta de Drive estas subcarpetas: …», visible en Inicio para el owner.
- Sin «Entrada», los PDF sueltos en la raíz cuentan como entrada (las subcarpetas nunca se listan como archivos).

**Por cada archivo de «Entrada»:**
1. **Ya registrado** (`drive_imports.drive_file_id`, un tick que murió antes de moverlo): solo se mueve.
2. **Documento de Google, más de 15 MB o sin cabecera `%PDF`:** va a «Con errores» con el motivo.
3. **Mismos bytes** que el documento de otra factura viva: va a «Duplicadas».
4. **Lectura** como «Leer PDF» (PDF.js en la Edge, plantillas del proveedor y reglas). PDF dañado o protegido: «Con errores».
   - Si sale un documento completo y ya está importado (misma huella, o mismo proveedor y número), va a «Duplicadas».
   - Mismo proveedor, fecha y total solo cuenta como duplicado si el documento no trae número.
5. **Un solo lote con la cuenta de servicio `drive`** («Drive (sistema)», editor en Finance), con los hooks de Finance:
   - factura en «Pendiente de datos», sin fecha (0223), con el proveedor provisional «Sin identificar (Drive)» (`slug` `sin_identificar`), objeto sacado del nombre del archivo, `drive_file_id` y `drive_url`;
   - su documento (archivo verificado en el almacenamiento);
   - si se leyó, `import_v1` sobre esa misma factura, que queda en «Pendiente de revisión» con su proveedor real.
   - Un PDF escaneado, o uno que no se lee del todo, se queda en «Pendiente de datos». Se completa con «Leer PDF», la IA o la sesión de Claude (§15.1).
6. Se guarda el texto del documento (para aprender la plantilla al validar) y el archivo va a «Importadas».

Cuando no se lee del todo, el motivo (`drive_imports.reason`, visible para el owner) dice qué faltó y la forma del texto (páginas con texto, fragmentos y caracteres), nunca su contenido.

**Volver a leer** (`POST /api/v1/drive/reread`, solo owner; botón en la tarjeta de Drive de Inicio): lee otra vez, con el lector actual, el documento guardado de cada borrador de Drive en «Pendiente de datos» (10 por llamada). Si ahora sale entero, lo completa en su sitio con `import_v1` (origen `pdf_text`). Devuelve, por factura, qué sacó o qué faltó, con la forma del texto.

**Formatos que lee sin IA** (además de «etiqueta e importe en la misma línea»):
- pies en tabla: cabecera con base, % o tipo de IVA, cuota, retención y total, y debajo una fila de cifras por tipo de IVA (columnas emparejadas por posición);
- varias etiquetas en una línea;
- la fecha que sigue a «Fecha» aunque la línea tenga vencimiento;
- «Número:» o «Nº:» suelto;
- NIF con puntos, guiones, espacios o prefijo ES;
- el NIF del cliente (línea «Cliente», «Destinatario» o «Facturar a») no se toma por el del proveedor;
- sin nombre junto al NIF, la razón social de la cabecera (S.L., S.A., S.L.U., S. Coop.).
- tablas por columnas o, si una celda de cabecera lleva varias etiquetas («Total SI (EUR) Total IVA Total TTI»), por orden. Las filas se suman por tipo de IVA (líneas de factura), y una fila igual a la suma de las anteriores cierra la tabla. Las fechas de las filas no cuentan como importes, y «Importe» a secas es el de cada línea;
- base y total con otras etiquetas: «Precio sin IVA», «Total SI», «sin impuestos»; «Precio Incl. IVA», «TTI», «IVA incluido»;
- «FACTURA 108-0007-…» sin «nº», y números con guion bajo;
- con un CIF de sociedad y un NIF de persona (el cliente autónomo), gana el CIF. El nombre sale del trozo de la línea con la forma jurídica, como en un pie legal.

**Volver a leer** deja rastro: antes de abrir cada PDF, el motivo pasa a «Relectura (lector vN): en curso.», y al terminar, a «Relectura (lector vN): leída/sin leer. …». Si la app no recibe respuesta, abre una hoja «No se pudo volver a leer» con el motivo (`#rereadError`).

**Relectura automática (0229).** `READER_VERSION` en `drive.ts` es la versión del lector; súbela con cada mejora de `pdf-extract.ts`. Cada archivo de Drive guarda con qué versión se leyó (`drive_imports.reader_version`), y el estado, la última versión que ha corrido (`drive_state.reader_version`). Con el presupuesto de 5 por tick que sobre tras «Entrada», el tick vuelve a leer los borradores de Drive en «Pendiente de datos» leídos con una versión anterior o sin versión (acción de sistema `invoices.drive_stale`). La sonda `drive_has_work` despierta al planificador mientras queden. El resultado del tick añade `reread` y `reread_read`. Una relectura solo completa borradores en «Pendiente de datos» y nunca pisa una factura ya revisada.

### 15.1 bis Lectura parcial (fase 0 de REVISION_LECTOR, 9-10-2026)

Un PDF con texto nunca termina sin información. `extractFromPdfText` devuelve, además de `ok`/`document`:
- `read`: `no_text` · `partial` · `sufficient`;
- `found` (`PartialInvoice`): proveedor, NIF, número, fecha, base, IVA por tipo, retención, total e IBAN encontrados, aunque falte algo esencial. La base deducida solo del total, sin ningún IVA, no cuenta como encontrada;
- `stats`: páginas, fragmentos y caracteres.

Ayudantes: `readingText(items)` (texto legible por líneas y páginas, para verlo y copiarlo), `readingMessage(extraction)` (mensaje honesto: «Este PDF no contiene texto legible…» frente a «He leído el PDF (…) y encontrado proveedor y total, pero no he identificado la fecha»), `foundLabels` y `missingLabels`.

**Drive y «Volver a leer».** Con una lectura parcial, `partialFillOperations` rellena el borrador en «Pendiente de datos». Solo toca lo vacío:
- el proveedor provisional, por un NIF válido (el existente, o uno nuevo con nombre y NIF);
- el número, la fecha y el total del documento, si están vacíos;
- los importes (líneas e impuestos), solo si se identificó la base. Con importes, la factura pasa a «Pendiente de revisión», como siempre.

El resumen va a `import_meta.reading` (`read`, `found`, `missing`, `stats`, plantilla, `reader_version`, `filled`), sin texto del documento. Solo puede escribirlo la cuenta de sistema `drive` (sesión `service:drive`); las demás siguen sin poder escribir `import_meta`. El motivo del registro de Drive es el mensaje honesto.

**Precedencia (mínima).** Una relectura que ya da la factura completa conserva el número y la fecha escritos por una persona: los distintos de los que rellenó la lectura, según `reading.filled` (`keepHumanFields`). También respeta el proveedor ya puesto en el borrador.

**En la app** (`ui/reading.ts`):
- **«Leer PDF» con lectura parcial.** En la ficha, abre «Rellenar a mano» con lo leído. En «Nueva factura», rellena lo vacío del formulario: proveedor por NIF (o alta), fecha, número, total y objeto desde el nombre del archivo. En los dos casos, arriba aparecen el mensaje, los campos (valor o «Falta») y el plegable «Texto leído» con «Copiar texto».
- **Ficha de una pendiente con PDF:** bloque «Lectura del documento». Va abierto en «Pendiente de datos». Usa el texto guardado o lee el PDF en el dispositivo, y la cabecera resume `import_meta.reading`.
- **«Subir varias»:** un PDF con texto que no llega a factura completa queda como «Lectura parcial: complétala», con lo encontrado rellenado y el mensaje. Solo un PDF sin texto dice «no contiene texto legible».

**Fase 1 · núcleo único en el servidor (9-10-2026).** `readAndFill(items, invoice, …)`, en `partial-read.ts`, lee con plantillas y reglas y prepara el relleno.

- **Quién lo usa:** Drive y la relectura (con `partialFillOperations`), y la ruta `POST documents/:fileId/text` cuando el cuerpo lleva `fill: true`.
- **Qué rellena la ruta:** solo el borrador en «Pendiente de datos» cuyo documento original subió quien manda el texto (`core.files.created_by`). Lo hace con la cuenta de sistema `lector` (0090, sesión `service:lector`), la única con `drive` que puede escribir `import_meta.reading`.
- **Respuesta:** `fill: { filled, reason?, invoice_id, read, fields, missing, message, duplicate_of? }`. Motivos: `NO_DRAFT`, `NOT_PENDING` y `DUPLICATE` (mismo proveedor y número que otra factura viva: no se rellena, y el mensaje dice cuál es).
- **Sin `fill`** solo guarda el texto. Es lo que hace «Leer PDF», porque la persona revisa lo leído en la vista previa o en «Rellenar a mano»; rellenar a la vez daría conflicto de revisión.

**Precedencia por nivel.** `reading.filled[campo] = { value, level }`, con nivel `plantilla` (plantilla con confianza ≥ 0,8), `regla` (≥ 0,6) o `inferencia`. Una lectura automática escribe un campo si está vacío, o si lo rellenó antes la lectura con menos nivel y sigue igual. Lo que cambió una persona, o la importación confirmada, manda. El formato de la fase 0 (`{campo: valor}`) cuenta como inferencia. El número no se escribe si duplicaría otra factura del mismo proveedor (`duplicateOf`).

**Fase 1 · lectura automática al subir (PR 2).** En «Nueva factura», elegir el PDF ya lo lee, en el worker de PDF.js. Límites: 15 MB y 8 s (`READ_LIMITS`); se leen las 8 primeras y las 2 últimas páginas si hay más de 10, porque los totales suelen ir al final. Nunca cambia de pantalla sola:
- con lectura completa, rellena el formulario y ofrece «Importar lo leído» (la vista previa de siempre);
- con lectura parcial o sin texto, rellena lo que haya y lo explica.

Con documento, el proveedor y el objeto no son obligatorios: la factura queda en «Pendiente de datos», con el proveedor provisional y el objeto sacado del nombre del archivo.

Medición (CPU 4×, 390 px; prueba «medición» con `IKISAI_MEASURE=1`): de 1 a 30 páginas, unos 0,6 s; 15 MB, sin ninguna tarea larga en el hilo de la interfaz.

**Nueva factura con varios archivos (9-10-2026).** Con más de un archivo, la hoja pregunta «¿Son páginas de una misma factura o facturas distintas?»:
- **«Facturas distintas»** cierra la hoja y abre «Subir varias» con esos archivos: una factura por archivo, con lectura automática;
- **«Páginas de una misma factura»** lee el primer PDF **con texto** y adjunta todos los archivos a una sola factura.

Sin elegir, no se guarda. «Leer PDF» usa el primer PDF, no el primer archivo.

**Fase 1 · el texto al servidor (PR 3).** Lo leído en el dispositivo al subir («Subir varias» y «Nueva factura») se guarda por SHA-256 del documento en este dispositivo (`app/text-queue.ts`, `localStorage`, como mucho 20 documentos y 4.000 fragmentos cada uno). Cuando el documento está subido (también al volver la red), se manda a `POST documents/:id/text` con `fill: true`. El servidor rellena lo que falte del borrador con `readAndFill` (importes si había base, el resumen `import_meta.reading`) y no pisa nada.

Los envíos se reintentan mientras haya algo pendiente. Un rechazo definitivo (4xx) se descarta, y lo que no llega a subirse en 7 días también. Al cerrar sesión, la cola se borra.

### 15.2 Primera factura de cada proveedor: con IA o a mano (9-10-2026)

**La plantilla se aprende al validar, venga de donde venga el dato.** `validateWithLearning` toma los valores confirmados de la factura (IA, a mano o reglas) y `learnFromConfirmation` los busca en el texto del PDF (guardado en `document_texts`). Así aprende la etiqueta o la posición de número, fecha, base, IVA, total y retención. Desde ese momento, la lectura (Drive, «Leer PDF», «Subir varias») usa la plantilla de ese proveedor en cuanto reconoce su NIF en el documento. Hace falta que el PDF tenga texto y que el valor validado aparezca impreso; pasa a «activa» tras 2 confirmaciones.

En la ficha de una factura en «Pendiente de datos»:
- **«Leer con IA»** es el botón principal si el proveedor no tiene plantilla (o es el provisional de Drive). Ofrece:
  - ChatGPT en el móvil: comparte el PDF y las instrucciones; el JSON vuelve compartido o pegado;
  - Claude en el ordenador: el mensaje para Claude Code, listo para copiar.
- **«Rellenar a mano»:** proveedor por NIF (elige el existente o lo da de alta), número, fecha, base por tipo de IVA (la cuota se calcula y se puede corregir), retención y total del documento, con el cuadre en vivo, y la categoría.
  - «Guardar» deja la factura en «Pendiente de revisión».
  - «Guardar y validar» valida en el mismo lote y aprende la plantilla.

La ficha del proveedor dice desde cuándo tiene plantilla, o «Sin plantilla todavía» con el flujo recomendado.

**Lo mismo desde el dispositivo («Subir varias» en Facturas):** cada archivo elegido es una factura.
- PDF con los mismos bytes que el documento de otra factura viva: duplicada, no se sube.
- PDF con texto: se lee con plantillas y reglas (rectificativa si lo es) y se importa en «Pendiente de revisión». Si el contenido ya está importado, duplicada.
- Foto, escaneado o lectura incompleta: «Pendiente de datos», con el documento y el proveedor provisional.
- Funciona sin red: los documentos y los lotes esperan en la cola del dispositivo.

**Compartir con Finance desde otra app** (Gmail, WhatsApp, Archivos…, en el móvil con la PWA instalada):
- El `share_target` del manifest acepta PDF e imágenes, además del JSON o el texto de la IA.
- El service worker guarda las facturas recibidas (hasta 20, de 15 MB como mucho cada una) en la caché `ikisai-invoices-share` y abre `#/facturas?compartido=docs`.
- La app las recoge una vez (`takeSharedDocuments`), las borra de la caché y las sube como «Subir varias», sin más pasos.
- Si solo llega texto (el resultado de la IA), sigue el camino de siempre: `?compartido=1` abre la importación.

**Modelo (0224):**
- `invoices.invoices.drive_file_id` (único) y `drive_url`.
- Tablas internas sin roles: `drive_state`, `drive_imports` y `drive_runs`.
- Acciones de sistema `invoices.drive_seen`, `drive_record` y `drive_finish` (roles vacíos).
- Lectura `invoices.drive_status` (solo owner): estado, últimas ejecuciones y últimos archivos con motivo.

**En la app:**
- Tarjeta «Desde Google Drive» en Inicio: por revisar y sin leer. El owner ve además la última búsqueda, el estado, los últimos archivos sin importar y «Buscar ahora».
- Filtro «Llegadas por Drive, sin validar» en la lista.
- «Origen: llegó por Google Drive · abrir el original» en la ficha.

**Aviso en Tasks › Gestiones:** origen `invoices`, por `POST worker/requests/task` de `tasks-api` con la clave de worker. La cuenta `drive` es editora en Tasks (#419).
- Tras un tick que importa algo, un aviso al día (`external_ref: drive:AAAA-MM-DD`, `kind: invoices.drive_review`, prioridad normal). Dice cuántas facturas de Drive quedan por revisar y validar (leídas y sin leer) y enlaza a `#/facturas?filtro=drive`. Si se repite el mismo día, Tasks actualiza el recuento.
- Si Drive queda bloqueado, `drive:blocked` (`invoices.drive_blocked`, prioridad alta) con el motivo.
- Sin `IKISAI_WORKER_KEY`, o si Tasks lo rechaza, no se avisa y el tick sigue.

### 15.1 Completar los borradores con una sesión de Claude (migración 0226)

Lo que Drive no lee del todo (PDF escaneado o con datos que faltan) queda en «Pendiente de datos». Una sesión de Claude Code del usuario (suscripción propia, sin coste por API) lo completa por la MCP de Finance:

**Conexión:**
- En Inicio, «Leer con Claude › Conectar Claude» (solo owner) crea una clave de agente **editor** (`POST agents`, nunca owner).
- Muestra una sola vez el comando `claude mcp add --transport http ikisai-finance https://finance.ikisai.com/api/v1/mcp --header "Authorization: Bearer ika_…"`.
- Se revoca en Central › Accesos › Agentes.

**Herramientas MCP:**
- **`invoices_pending_drafts`** (editor): facturas en `pendiente_datos` (por defecto solo las de Drive), las más antiguas primero, como mucho 20. Para cada una: `invoice_id`, código, objeto, `drive_url` y documentos con **URL firmada de 10 minutos**. Devuelve también `how_to_complete` y `json_schema` (`ikisai.invoice.v1`).
- **`invoices_import_json`** con `invoice_id`: completa ese borrador sin crear otro. `import_v1` admite `pendiente_datos` con `source = manual`, que es como quedan las de Drive.
  - Argumento nuevo `provenance` (`{ campo: { confidence 0–1, text, page } }`), validado: como mucho 40 campos y textos de 300 caracteres.
  - Queda en la factura con origen **`ia`**.
- Un agente no puede validar: la factura queda en «Pendiente de revisión».

**`import_v1` (0226)** guarda `args.origin` (`pdf_text` · `ia` · `api` · `json`) y `args.provenance` en `import_meta`:
- Drive guarda `pdf_text` con la procedencia de la lectura.
- La herramienta MCP guarda `ia`.
- La ficha muestra en «Importación» quién la leyó y de dónde sale cada dato, con su confianza.

## 16. «Mi nombre» de los artículos y «Se deja en su trimestre» (9-10-2026)

### 16.1 «Mi nombre» (0230)
- **`invoice_lines.label`** (hasta 120 caracteres): el nombre propio del usuario. La descripción de la factura no se toca y es la que va a la gestoría (CSV y manifest). **`label_source`** (`manual` o `recordado`) lo pone un disparador; el cliente no lo escribe.
- **Dónde se ve:** en la ficha, el «Mi nombre» y debajo «En la factura: …»; también en la asignación, en Compras y en la proyección de stock para Food (`line_description`). Booking no recibe descripciones.
- **Memoria por proveedor (`invoices.item_labels`):**
  - clave `cod:<código>` si la descripción empieza por un código (letras y cifras), o `txt:<descripción normalizada>`;
  - se aprende al **validar** (hook `invoices.learn_item_labels`);
  - se aplica sola al **insertar** una línea del mismo proveedor y clave, venga de donde venga (importación, a mano, Drive, lote, relectura), como «recordado»;
  - el cliente solo corrige `label` o borra una entrada; crearla, no.
- **Editar «Mi nombre»** también en una factura validada: cambiar solo `label` no la devuelve a «Pendiente de revisión» (`invoices.label_only_change` en `check_invariants`).

### 16.2 FB_2026_024 · «Se deja en su trimestre» (0231)
Para una factura atrasada que la gestoría ya tiene: `delivered_elsewhere = true` y `declared_period` = el trimestre de su fecha.
- No se mueve al trimestre en curso ni vuelve a preguntar.
- No entra en las entregas que se preparen en la app (`export_manifest`) ni las deja desactualizadas (`export_bundle.stale`).
- El resumen fiscal de su trimestre la sigue contando.
- En la ficha: el botón está en el aviso «Es del 2T…» y en el de «Atrasada»; después aparece el aviso «Ya pasada a la gestoría», con «Deshacer».

### 16.3 Artículos aprendidos (9-10-2026)
- **Al validar** una factura con artículos (al menos dos, que no sean las líneas genéricas «Base al X % según documento»), `learnItemsFromConfirmation` localiza en el PDF la tabla: la fila de cabecera (sus palabras) y las columnas de descripción, cantidad, precio e importe (posición de las celdas). La guarda en la plantilla del proveedor, en `fields.__items`.
- **En la siguiente factura** del proveedor, `applyItemTable` lee las filas desde la cabecera hasta los totales («Base imponible», «Total», «IVA»…). Une la descripción que sigue en otra línea y repite en cada página donde vuelva a salir la cabecera. Las filas salen como líneas, con procedencia `supplier_template` (`provenance.lines`, «Artículos» en la vista previa).
- **Los totales no se tocan.** Si las filas no suman la base (±0,02 €) o hay varios tipos de IVA, se quedan las líneas por tipo de IVA, con un aviso.
- **Aciertos y fallos**, como en las demás reglas: una factura rara no cambia la tabla; tres fallos seguidos la retiran y la siguiente validación aprende otra. Un documento sin tabla no cuenta como fallo.
- **Huella estable:** la huella del formato de las plantillas nuevas no incluye las líneas con importes (las filas de artículos cambian de una factura a otra). Al elegir, se compara con la huella completa y con la estable, y vale la mejor, así que las plantillas antiguas siguen funcionando.

### 16.4 Plantillas sin depender del NIF (fase 2, 9-10-2026)
Si el NIF del documento no es de un proveedor conocido, `rankTemplates` puntúa las plantillas **activas** de todos los proveedores:
- 0,5 · huella del formato (la mejor entre la completa y la estable);
- 0,2 · etiquetas de sus reglas que aparecen en el documento;
- 0,2 · nombre del proveedor en el texto;
- 0,1 · NIF (aquí, 0).

Gana la primera si llega a 0,7 y saca al menos 0,1 a la segunda. La plantilla aporta sus campos como siempre.

El proveedor que sale así lleva un aviso («reconocido por el formato de sus facturas, no por su NIF: revísalo»). Si el documento no trae nombre, lo pone la plantilla con procedencia `supplier_template` y confianza 0,5. Nunca se da de alta un proveedor solo por parecido. Sin NIF ni nombre, el formato solo no basta.
### 16.5 Aprendizaje de las plantillas (fase 2, 9-10-2026)
Ya era así:
- solo se aprende al **validar**, de lo confirmado;
- un valor confirmado que no está impreso no cuenta como fallo;
- una factura rara no cambia la etiqueta (se guarda como variante);
- tres fallos seguidos retiran la regla;
- un formato que no se parece a ninguno crea una versión nueva.

**Nuevo:** una regla también se retira si falla mucho aunque no sea seguido (más del 40 % de fallos tras 5 usos). Las reglas que aciertan siguen.

### 16.6 Corpus real del lector (fase 2, 9-10-2026; excepción aprobada por Core)
- **Dónde:** las facturas reales viven solo en el bucket privado `test-corpus` de producción (sin políticas RLS: solo entra la clave de servicio), cada una como `<id>.pdf` más `<id>.expected.json`. Los campos del esperado son `supplier_tax_id`, `invoice_number`, `invoice_date`, `base`, `vat` (suma de cuotas), `withholding` y `total`. En el repositorio no hay nada real.
- **Subir**, en local, con `private/cloud-credentials.json`:

  ```
  python tests/invoices/corpus/corpus.py upload 001 factura.pdf esperado.json
  ```

  Para listarlas: `… corpus.py list`.
- **Job** `.github/workflows/invoices-corpus.yml`, nocturno y manual, nunca en un PR:
  - descarga el corpus una vez, con la clave de servicio pedida a la API de gestión con `SUPABASE_ACCESS_TOKEN`, enmascarada y solo en memoria;
  - `tests/invoices/corpus/run.ts` lo lee con el mismo PDF.js y el mismo lector que la Edge;
  - en el resumen del job escribe **solo acierto o fallo por campo y documento**;
  - borra los documentos al terminar;
  - sale en rojo si falla algún campo.
- **Cada fallo real**, además, se convierte en una copia sintética con el mismo diseño en `pdf-real.test.ts`, que corre en la CI.

### 16.7 La IA completa solo lo que falta (fase 3, 9-10-2026)
- **ChatGPT y otras apps («Leer con IA» › «Compartir con ChatGPT»):** antes de compartir, Finance lee el PDF (el texto guardado o en el dispositivo). Lo encontrado va en el contrato (`invoiceContractText(source, known)`), en la sección «DATOS YA LEÍDOS POR FINANCE» (`knownFieldsText`): los valores y lo que falta. La IA los comprueba en el documento, los conserva salvo error evidente, dice en `extraction_notes` si alguno no coincide y completa solo lo demás. El JSON de vuelta sigue siendo un `ikisai.invoice.v1` completo y se revisa en la vista previa, como siempre.
- **Claude por MCP (`invoices_pending_drafts`):** cada borrador lleva:
  - `already`: lo que ya tiene (proveedor si no es el provisional, número, fecha y total), porque lo leyó Finance o lo escribió una persona;
  - `reading`: `read` y `missing`, de `import_meta.reading`.

  `how_to_complete` y el mensaje para Claude piden respetar `already` y completar `reading.missing`.

### 16.8 «Validar» nunca falla en silencio (incidencia del usuario, 9-10-2026)
- **Antes de enviar**, la ficha comprueba lo mismo que `invoices.validate` (`validationMissing`, en `validation-check.ts`): fecha, categoría de gasto, documento original, artículos o IVA, rectificativa enlazada y con signo, y cuadre dentro de la tolerancia.
  - Arriba de la ficha, un aviso: «Revisa los datos: se guardan solos al cambiarlos. Falta: …», con cada punto como enlace que abre el bloque, lleva al campo y lo resalta. Sin nada pendiente dice «Todo listo para validar».
  - «Validar» queda con `aria-disabled` y su motivo: si se pulsa, no envía nada y explica qué falta.
  - «Fiscal y pago» se abre solo si falta algo suyo.
- **Si aun así el servidor rechaza** (por ejemplo, otro dispositivo cambió algo), `app/rejections.ts` traduce el motivo (`validationRejectionText`: «No se pudo validar FVR_…: falta la categoría de gasto») y descarta solo ese lote. Un intento de validar fallido no deja «1 rechazado». Al arrancar, la app limpia los que hubiera.
- **Categoría por defecto:** la importación ya usaba la del proveedor. Ahora, al validar, la categoría pasa a ser la del proveedor si no tenía ninguna (sin pisarla), y la lectura automática la pone al reconocer al proveedor por NIF.

### 16.9 «Validar» sin chocar con uno mismo (incidencia del usuario, 9-10-2026, tras #449)
- **El problema:** elegir la categoría y pulsar «Validar» al instante mandaba la validación con la revisión de antes del acuse del cambio → `VERSION_CONFLICT` contra el propio cambio.
- **Arreglo, en la ficha:**
  - «Validar» deja que el último cambio entre en la cola y, con red, espera (hasta 8 s) a que el servidor lo confirme;
  - vuelve a comprobar lo que falta con el espejo de ese momento y valida con la revisión fresca;
  - sin red, o si los cambios siguen pendientes, la validación sale sin `expectedRevision`: los cambios propios van antes en la cola.
- **Si aun así hay conflicto:** las validaciones se anotan en el dispositivo (`ikisai.invoices.validateRequests`). Un conflicto de una validación anotada contra un cambio propio se descarta y se vuelve a validar solo con la revisión nueva. Uno parecido sin anotar (como el que tenía el usuario) se descarta con el aviso de repetir la acción: el servidor ya tiene sus datos.
- **Pantalla de conflictos (kit 0.28.0):**
  - el nombre es legible: «código · proveedor» en facturas y el nombre en proveedores, nunca el id;
  - dice quién lo cambió (`currentUserId`);
  - la cabecera usa `conflictIntro` en lugar del «Otra persona cambió lo mismo que tú» fijo;
  - los campos de factura tienen etiqueta.

