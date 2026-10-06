# Ikisai Invoices · API y modelo de datos (puerta G2)

Fecha: 6 de octubre de 2026. Autor: equipo Invoices (agente de backend). Estado: **borrador para revisión de Core**. Sigue `docs/core/PLANTILLA_API_APP.md`; el contrato `docs/core/CONTRATO_SINCRONIZACION.md` es normativo y aquí no se repite.

> **Aviso sobre las fuentes.** La carpeta del handoff `C:\Users\34606\Documents\Ikisai\App\CORE_IKISAI_APPS_V3` no existe en este PC (buscada en Documentos, Descargas y Escritorio). Este documento se ha escrito a partir del mensaje de arranque de Core (que resume §24A y §31A), de `docs/core/PLAN.md` §5, del contrato, de las migraciones y la Edge ya publicadas, y de los criterios fiscales de C08 (`Doc_C08_Finanzas_Criterios_fiscales_y_cierre.md`, `C08.md`). La forma del JSON `ikisai.invoice.v1` (§3.1) es una **propuesta** que Core debe cotejar con `03_IKISAI_INVOICE_IMPORT_V1.schema.json` y `04_EJEMPLO…json`; donde difieran, manda el esquema del handoff y se ajusta este documento antes de la primera migración.

---

## 1. Dominio y límites

**Qué resuelve.** Registro de **facturas recibidas** (compras y gastos del negocio): proveedor, documento original (PDF o foto), líneas, impuestos, categoría de gasto cerrada, marca de inversión, periodo fiscal derivado, pago, y **asignación** del gasto a destinos de otras apps (proyecto o tarea de Tasks; en fase 2, evento de Booking y menú o lista de compra de Food) o a «general». Produce las dos lecturas que necesita el usuario: **Compras** (qué se ha comprado, para qué, qué falta por asignar o pagar) y **Gestoría** (resumen fiscal por trimestre y ZIP con las facturas renombradas y un manifest con hashes).

**Entrada principal en V1.** Importación del JSON `ikisai.invoice.v1` que el usuario obtiene de ChatGPT con el prompt del handoff (`05_PROMPT_EXTRACCION_FACTURA.md`), pegado o cargado en la app, más el PDF o la foto del original. La extracción automática desde la Edge queda como puerta de V2 (§6, ruta `imports/extract`, no implementada).

**Qué no hace.**
- No es contabilidad oficial ni sustituye a la gestoría (criterio C08 §1): prepara, ordena y entrega.
- No emite facturas. La columna `kind` admite `issued` para no forzar una migración futura, pero la Edge rechaza `issued` en V1.
- No registra movimientos de tesorería ni conciliación bancaria (`movimientos` de C08 queda fuera). Solo guarda el estado de pago de cada factura.
- No gestiona stock ni costes de retiro: eso lo hacen Food y Booking leyendo lo que Invoices publica (§7).

**Datos de otras apps.** Los destinos de asignación son enlaces tipados (§7). No se copia nada de Tasks, Booking ni Food como fuente de verdad: se guarda `target_id`, `target_code`, un `target_label` de cortesía y `target_revision` para detectar obsolescencia por comparación.

**Papelera.** Las facturas y sus documentos **no se borran**: se anulan (`status = 'annulled'`) y se conservan. `suppliers`, `allocations` y las líneas de una factura en `draft` sí admiten borrado lógico y papelera.

---

## 2. Tablas sincronizables (`invoices.*`)

Todas llevan las columnas del contrato §2.1 (`id, revision, created_at, updated_at, updated_by, deleted_at`) y se registran con `core.register_table` en la misma migración. Importes en `numeric(12,2)` salvo donde se indica; moneda `EUR` en V1 (la columna existe para no bloquear el futuro). Todas las fechas son `date` (sin hora) salvo las de auditoría.

Roles: lectura `{reader, editor, owner}`, escritura `{editor, owner}` en todas. La gestoría puede darse de alta como `reader`: ve Facturas, Compras y Gestoría y descarga ZIP, pero no escribe.

### 2.1 `invoices.suppliers` (existe; se amplía)

Ya creada en `20261006_0002_invoices_suppliers.sql`. La migración de G2 añade:

| Columna | Tipo | Notas |
|---|---|---|
| `aliases` | `text[] not null default '{}'` | Nombres alternativos que aparecen en facturas («MAKRO ESPAÑA S.A.», «Makro Alcorcón») para el emparejamiento de la importación. Máximo 20, cada uno ≤ 200. |
| `default_is_investment` | `boolean not null default false` | Sugerencia al registrar. |
| `country` | `char(2) null` | ISO 3166-1; `ES` por defecto en la UI. |

`writable_columns`: `name, tax_id, default_category, default_is_investment, aliases, country, notes`.

Índice adicional: `suppliers_tax_id_idx unique (upper(tax_id)) where deleted_at is null and tax_id is not null` (dos proveedores vivos no comparten NIF).

### 2.2 `invoices.invoices`

| Columna | Tipo | Restricciones |
|---|---|---|
| `code` | `text unique not null` | `FVR_AAAA_NNN` vía `core.next_code('FVR', año de issue_date)`. Lo asigna siempre el servidor (procedimiento o trigger de inserción, §2.9); no es escribible. |
| `kind` | `text not null default 'received'` | `check (kind in ('received','issued'))`. V1: solo `received` (lo impone la Edge). |
| `supplier_id` | `uuid not null references invoices.suppliers(id)` | |
| `invoice_number` | `text not null` | Número del proveedor, tal cual aparece (≤ 64). |
| `issue_date` | `date not null` | Fecha de emisión. Origen del periodo fiscal. |
| `operation_date` | `date null` | Fecha de operación si difiere. |
| `due_date` | `date null` | Vencimiento. |
| `currency` | `char(3) not null default 'EUR'` | `check (currency = 'EUR')` en V1. |
| `subtotal` | `numeric(12,2) not null` | Base imponible total (suma de bases de `tax_lines`). |
| `tax_total` | `numeric(12,2) not null default 0` | IVA + recargo de equivalencia. |
| `withholding_total` | `numeric(12,2) not null default 0` | Retenciones (IRPF), en positivo. |
| `total` | `numeric(12,2) not null` | Total a pagar: `subtotal + tax_total - withholding_total` ± 0,02. |
| `expense_category` | `text not null` | Lista cerrada (§2.10). |
| `is_investment` | `boolean not null default false` | Separación explotación / inversión (C08 §7.2). Si `true`, `expense_category` suele ser `inversiones` pero no se obliga (una compra de maquinaria puede ir en `mantenimiento` con `is_investment = true`). |
| `deductible` | `text not null default 'si'` | `check (deductible in ('si','no','parcial','no_aplica'))` (C08 §15). |
| `status` | `text not null default 'draft'` | `check (status in ('draft','registered','exported','annulled'))`. §2.11. |
| `annulled_reason` | `text null` | Obligatorio cuando `status = 'annulled'`. |
| `payment_status` | `text not null default 'pending'` | `check (payment_status in ('pending','paid'))`. |
| `payment_method` | `text null` | `check (payment_method in ('transferencia','tarjeta','efectivo','bizum','domiciliacion','otro'))` (lista C08). |
| `paid_at` | `date null` | Obligatorio si `payment_status = 'paid'`. |
| `source` | `text not null default 'manual'` | `check (source in ('manual','import_v1'))`. |
| `import_sha256` | `text null` | SHA-256 del JSON importado (idempotencia humana: «esta factura ya se importó»). |
| `import_meta` | `jsonb null` | Metadatos de la extracción (modelo, confianza, avisos, deltas de redondeo). Solo lectura para la UI; lo escribe el procedimiento. |
| `fiscal_year` | `int generated always as (extract(year from issue_date)::int) stored` | **Periodo fiscal derivado.** |
| `fiscal_quarter` | `int generated always as (extract(quarter from issue_date)::int) stored` | |
| `fiscal_period` | `text generated always as (extract(year from issue_date)::int || 'T' || extract(quarter from issue_date)::int) stored` | `2026T1`. |
| `notes` | `text null` | |

`writable_columns`: `kind, supplier_id, invoice_number, issue_date, operation_date, due_date, currency, subtotal, tax_total, withholding_total, total, expense_category, is_investment, deductible, status, annulled_reason, payment_status, payment_method, paid_at, source, import_sha256, notes`. (`code`, `import_meta` y las columnas generadas no son escribibles; `import_meta` solo lo rellena `invoices.import_v1`.)

`never_purge = true`.

Índices: `invoices_supplier_number_uq unique (supplier_id, lower(invoice_number)) where deleted_at is null and status <> 'annulled'` (detección de duplicados); `invoices_issue_date_idx (issue_date desc)`; `invoices_period_idx (fiscal_year, fiscal_quarter)`; `invoices_status_idx (status, payment_status)`.

Triggers propios (§4.2): `invoices.guard_invoice` (bloquea borrado lógico, columnas cerradas en `exported`, coherencia de anulación y pago) y `invoices.assign_code` (asigna `code` en el `insert` si viene nulo).

### 2.3 `invoices.invoice_files`

Documentos de una factura. El binario vive en Storage (`purchase-documents`) y su registro en `core.files`; aquí solo la referencia. Por la regla «un archivo toca un solo schema» no hay FK a `core.files`: la Edge comprueba en `beforeCommit` que `file_id` existe, es de la app `invoices` y está `verified` (`core_file_get`).

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `file_id` | `uuid not null` | Id en `core.files`. Único por factura: `unique (invoice_id, file_id)`. |
| `role` | `text not null default 'original'` | `check (role in ('original','photo','attachment'))`. Una factura tiene como máximo un `original` vivo (índice único parcial). |
| `canonical_name` | `text not null` | Nombre canónico (§2.12), calculado por el servidor. No escribible. |
| `filename` | `text not null` | Nombre con el que se subió (≤ 255). |
| `mime` | `text not null` | `application/pdf`, `image/webp`, `image/jpeg`, `image/png`. |
| `size` | `bigint not null check (size >= 0)` | |
| `sha256` | `text not null check (sha256 ~ '^[0-9a-f]{64}$')` | Copiado de `core.files` por la Edge al validar; es el hash que va al manifest de gestoría. |
| `page_count` | `int null` | Si el cliente lo conoce. |
| `position` | `int not null default 0` | |

`writable_columns`: `invoice_id, file_id, role, filename, mime, size, sha256, page_count, position`. `never_purge = true`. Borrado lógico permitido solo mientras la factura esté en `draft` (trigger `invoices.guard_file`); después, un documento equivocado se sustituye añadiendo otro y degradando el anterior a `attachment`.

### 2.4 `invoices.invoice_lines`

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `position` | `int not null` | `unique (invoice_id, position) deferrable initially deferred`. |
| `description` | `text not null check (length(description) between 1 and 500)` | |
| `product_ref` | `text null` | Código o referencia del proveedor (≤ 64). Lo usará Food en V2 para entradas de stock. |
| `quantity` | `numeric(12,3) not null default 1` | |
| `unit` | `text null` | `ud`, `kg`, `l`, `h`, … libre (≤ 16). |
| `unit_price` | `numeric(12,4) not null` | Precio unitario sin IVA. |
| `discount_pct` | `numeric(5,2) not null default 0 check (discount_pct between 0 and 100)` | |
| `tax_rate` | `numeric(5,2) not null` | `check (tax_rate in (0, 4, 10, 21))`; `0` cubre exento y no sujeto. |
| `line_base` | `numeric(12,2) not null` | `round(quantity × unit_price × (1 − discount_pct/100), 2)`. Lo calcula el dominio; el hook de validación comprueba ±0,01 por línea. |
| `expense_category` | `text null` | Sobrescribe la de la factura para esta línea (lista cerrada). |
| `is_investment` | `boolean null` | Sobrescribe la de la factura. |
| `notes` | `text null` | |

`writable_columns`: todas las anteriores. Sin `never_purge` (una línea se puede borrar mientras la factura esté en `draft`; después lo bloquea `invoices.guard_line`).

### 2.5 `invoices.tax_lines`

Desglose fiscal por tipo, tal como lo imprime la factura.

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `position` | `int not null` | |
| `kind` | `text not null` | `check (kind in ('iva','recargo_equivalencia','retencion_irpf','exento','no_sujeto'))`. |
| `rate` | `numeric(5,2) not null` | Para `iva`: 0, 4, 10, 21. Para `exento` / `no_sujeto`: 0. |
| `base` | `numeric(12,2) not null` | |
| `amount` | `numeric(12,2) not null default 0` | En positivo; el signo lo da `kind` (`retencion_irpf` resta). |

`writable_columns`: `invoice_id, position, kind, rate, base, amount`. Restricción: `unique (invoice_id, kind, rate) where deleted_at is null`.

### 2.6 `invoices.allocations`

Asignación del gasto a destinos. Una factura puede tener varias asignaciones (por factura entera o por línea). Lo que no está asignado aparece en Compras como «sin destino».

| Columna | Tipo | Restricciones |
|---|---|---|
| `invoice_id` | `uuid not null references invoices.invoices(id)` | |
| `invoice_line_id` | `uuid null references invoices.invoice_lines(id)` | Si se asigna una línea concreta. |
| `target_app` | `text not null` | `check (target_app in ('general','tasks','booking','food'))`. |
| `target_kind` | `text null` | `tasks`: `project` \| `task`. `booking`: `event`. `food`: `menu` \| `shopping_list`. `general`: `null`. `check` por pares (§4.2). |
| `target_id` | `uuid null` | Id en la app destino. Obligatorio salvo `general`. |
| `target_code` | `text null` | Código humano del destino (`EVT_2026_004`) si lo tiene. |
| `target_label` | `text not null` | Texto de cortesía mostrado sin red (nombre del proyecto, título del evento). Se refresca al validar. |
| `target_revision` | `bigint null` | Revisión del destino cuando se validó. Obsolescencia por comparación (§7.3). |
| `amount` | `numeric(12,2) not null check (amount > 0)` | Base imponible asignada (sin IVA). |
| `notes` | `text null` | |

`writable_columns`: todas las anteriores. Borrado lógico permitido siempre (asignar mal no es un hecho fiscal). Índices: `(invoice_id)`, `(target_app, target_kind, target_id) where deleted_at is null`.

Invariante (hook §4.3): `sum(amount)` de las asignaciones vivas de una factura ≤ `subtotal` + 0,02.

### 2.7 `invoices.exports`

Entregas a la gestoría. Cada fila congela un conjunto de facturas y su manifest.

| Columna | Tipo | Restricciones |
|---|---|---|
| `code` | `text unique not null` | `GST_AAAA_NNN` vía `core.next_code('GST', año)`. Servidor. |
| `period_kind` | `text not null` | `check (period_kind in ('quarter','month','custom'))`. |
| `fiscal_year` | `int not null` | |
| `fiscal_quarter` | `int null check (fiscal_quarter between 1 and 4)` | Obligatorio si `quarter`. |
| `fiscal_month` | `int null check (fiscal_month between 1 and 12)` | Obligatorio si `month`. |
| `from_date`, `to_date` | `date not null` | Derivadas del periodo o libres en `custom`. |
| `status` | `text not null default 'ready'` | `check (status in ('ready','delivered','superseded'))`. `superseded` cuando una entrega posterior del mismo periodo la sustituye (por una factura anulada o añadida tarde). |
| `invoice_count` | `int not null` | |
| `totals` | `jsonb not null` | Resumen fiscal del conjunto (misma forma que `fiscal/summary`, §6.4). |
| `manifest` | `jsonb not null` | §6.5. Inmutable. |
| `manifest_sha256` | `text not null` | SHA-256 del manifest canónico (JSON con claves ordenadas). Es la huella de la entrega. |
| `delivered_at` | `timestamptz null` | |
| `delivered_to` | `text null` | Texto libre («correo a la gestoría 7-4-2026»). |
| `notes` | `text null` | |

`writable_columns`: `status, delivered_at, delivered_to, notes` (el resto lo escribe `invoices.create_export`). `never_purge = true`. Sin borrado lógico (trigger).

### 2.8 `invoices.export_items`

| Columna | Tipo | Restricciones |
|---|---|---|
| `export_id` | `uuid not null references invoices.exports(id)` | |
| `invoice_id` | `uuid not null references invoices.invoices(id)` | `unique (export_id, invoice_id)`. |
| `invoice_code` | `text not null` | Copia en el momento de la entrega. |
| `file_id` | `uuid null` | Documento `original` incluido (puede faltar: la factura va en el manifest marcada `missing_file`). |
| `canonical_name` | `text null` | Nombre dentro del ZIP. |
| `sha256` | `text null` | Hash del documento incluido. |
| `invoice_revision` | `bigint not null` | Revisión de la factura al exportar. |

`writable_columns`: ninguna escribible por el cliente (`'{}'`); solo `invoices.create_export`. `never_purge = true`.

### 2.9 Códigos humanos

Prefijos que registra Invoices: **`FVR`** (factura recibida; coincide con C08) y **`GST`** (entrega a gestoría). `FVE` queda reservado para facturas emitidas (no en V1). El año de la secuencia es el de `issue_date` (no el de registro): una factura de diciembre registrada en enero se numera en el año anterior.

### 2.10 Categorías de gasto (cerradas)

Misma lista que `suppliers.default_category` y que C08, sin las categorías de ingreso:

`compras` · `suministros` · `mantenimiento` · `inversiones` · `canon_concesion` · `seguros` · `personal` · `fiscalidad` · `otros`.

Se define una vez como `invoices.expense_category_values()` (función SQL inmutable que devuelve el array) y se usa en los `check` de las tres columnas; el dominio TypeScript exporta la misma lista (`EXPENSE_CATEGORIES`) y una prueba la compara con la de la migración.

### 2.11 Estados de factura

```
draft ──(completa y cuadra)──▶ registered ──(entrega gestoría)──▶ exported
  │                                 │                                 │
  └──────── annulled ◀──────────────┴─────────────────────────────────┘
```

| Estado | Significado | Qué se puede editar |
|---|---|---|
| `draft` | Registrada a mano o importada con avisos; puede no cuadrar. | Todo. Líneas, impuestos y documentos se pueden borrar. |
| `registered` | Totales coherentes (§4.3), proveedor y documento original presentes. Es el estado normal. | Todo salvo borrar documentos; cambios de importes relanzan la validación. |
| `exported` | Incluida en una entrega `GST_…`. | Solo `payment_status, payment_method, paid_at, notes`, asignaciones y adjuntos (`role = 'attachment'`). Cualquier otra columna → `INVOICE_LOCKED 409`. |
| `annulled` | Anulada (error, duplicado, abono). Se conserva y sale de los resúmenes. | Solo `notes`. Si estaba `exported`, la entrega pasa a `superseded` y hay que generar otra. |

Transiciones permitidas: `draft → registered`, `registered → draft` (solo si no hay entrega), `registered → exported` (solo por `invoices.create_export`), `draft|registered|exported → annulled` (con `annulled_reason`). Nada vuelve de `annulled`.

### 2.12 Nombre canónico de archivo

Lo calcula el servidor (`invoices.canonical_name(invoice, file)`) y lo replica el dominio TypeScript con la misma función (prueba de paridad en `tests/core`):

```
<issue_date>__<code>__<supplier_slug>__<invoice_number_slug>[__<n>].<ext>
2026-03-14__FVR_2026_012__makro__a-2026-0457.pdf
```

Reglas: `slug` = minúsculas, sin acentos (`unaccent` no está garantizado: tabla propia de sustituciones ASCII en SQL y TS), `[^a-z0-9]+ → -`, recortado a 40 caracteres, sin guiones en los extremos; `ext` = por `mime` (`pdf`, `webp`, `jpg`, `png`), nunca del nombre original; `__<n>` solo para el segundo y siguientes documentos de la misma factura (`photo` o `attachment`), empezando en 2. La fecha delante ordena cronológicamente cualquier carpeta; el código evita colisiones.

---

## 3. Procedimientos (`call`)

Todos son `security definer`, ejecutables solo por `service_role`, registrados con `core.allow_procedure('invoices', …)` y escriben **exclusivamente** vía `core.apply_row_op(app, actor, role, requestId, cursor, op)` para que cada fila quede en `core.changes` con su revisión. Reciben el `jsonb` que construye `core.commit`: `{app, actor, role, requestId, cursor, args}`.

### 3.1 `invoices.import_v1(p jsonb)`

Importación transaccional de un documento `ikisai.invoice.v1`. Es la operación principal de V1.

**`args`**

```json
{
  "document": { "...": "JSON ikisai.invoice.v1 tal cual lo produjo la extracción" },
  "document_sha256": "hex64",
  "ids": { "invoice": "uuid", "lines": ["uuid", "…"], "tax_lines": ["uuid", "…"], "file": "uuid|null", "supplier": "uuid|null" },
  "supplier": { "mode": "existing|create", "id": "uuid|null" },
  "file": { "file_id": "uuid", "filename": "Factura Makro.pdf", "mime": "application/pdf", "size": 123456, "sha256": "hex64", "page_count": 2 } ,
  "overrides": { "expense_category": "compras", "is_investment": false, "deductible": "si", "notes": "…" },
  "accept_declared_totals": false
}
```

Los `ids` los genera el cliente (uuid v4) para que el reintento sea idempotente también a nivel de fila (el recibo de `core.commit` ya cubre el lote). `file` es opcional (se puede importar y adjuntar el PDF más tarde); si viene, la Edge ya ha comprobado el archivo en `beforeCommit` (§4.1).

**Forma propuesta del documento `ikisai.invoice.v1`** (a cotejar con el esquema del handoff):

```json
{
  "schema": "ikisai.invoice.v1",
  "supplier": { "name": "MAKRO ESPAÑA S.A.", "tax_id": "A28647451", "address": "…", "country": "ES" },
  "invoice": { "number": "A-2026-0457", "issue_date": "2026-03-14", "operation_date": null, "due_date": "2026-04-13", "currency": "EUR" },
  "lines": [
    { "description": "Tomate pera", "product_ref": "123", "quantity": 20, "unit": "kg", "unit_price": 1.85, "discount_pct": 0, "tax_rate": 4 }
  ],
  "taxes": [
    { "kind": "iva", "rate": 4, "base": 37.00, "amount": 1.48 },
    { "kind": "iva", "rate": 10, "base": 120.00, "amount": 12.00 }
  ],
  "totals": { "subtotal": 157.00, "tax_total": 13.48, "withholding_total": 0, "total": 170.48 },
  "suggested": { "expense_category": "compras", "is_investment": false },
  "extraction": { "model": "…", "confidence": 0.93, "warnings": ["…"] }
}
```

**Pasos (una transacción; cualquier fallo deshace todo):**

1. **Esquema.** `document.schema = 'ikisai.invoice.v1'`; campos obligatorios presentes y con tipo (fechas ISO, números finitos con ≤ 4 decimales en `unit_price`, ≤ 3 en `quantity`); `currency = 'EUR'`; `lines` 1..500; `taxes` 0..8. Error → `IMPORT_INVALID 422 {path, reason}`.
2. **Proveedor.** `mode = 'existing'` → la fila `supplier.id` existe y no está borrada; `mode = 'create'` → `apply_row_op insert` en `suppliers` con `ids.supplier`, `name`, `tax_id`, `country`, `aliases = [document.supplier.name]` si difiere del nombre. Si ya existe un proveedor vivo con ese `tax_id` → `SUPPLIER_TAX_ID_EXISTS 409 {supplier_id}` (el cliente debe pasar a `existing`).
3. **Duplicado.** Existe factura viva no anulada con mismo `supplier_id` y `lower(invoice_number)` → `DUPLICATE_INVOICE 409 {invoice_id, code}`. Existe una con el mismo `import_sha256` → `DUPLICATE_IMPORT 409 {invoice_id, code}`.
4. **Recalculo.** Por línea: `line_base = round(q × p × (1 − d/100), 2)`. Agrupa por `tax_rate`: `calc_base[r] = Σ line_base`, `calc_amount[r] = round(calc_base[r] × r/100, 2)`. `calc_subtotal = Σ calc_base`; `calc_tax = Σ calc_amount + Σ recargo declarado`; `calc_total = calc_subtotal + calc_tax − withholding`.
5. **Tolerancia 0,02 €.** Compara contra `document.taxes` (por tipo) y `document.totals`:
   - Toda diferencia absoluta ≤ **0,02** → se aceptan las cifras **declaradas** (las que imprimió el proveedor mandan) y las diferencias se anotan en `import_meta.rounding = {subtotal, tax_total, total, by_rate}`.
   - Alguna diferencia > 0,02 y `accept_declared_totals = false` → `IMPORT_TOTALS_MISMATCH 422 {calculated, declared, deltas}`. La UI muestra ambos y ofrece corregir líneas o aceptar lo declarado.
   - Alguna diferencia > 0,02 y `accept_declared_totals = true` → se guardan las cifras declaradas, la factura queda en **`draft`** con `import_meta.needs_review = true` y el motivo. No pasa a `registered` hasta que alguien cuadre las líneas o lo confirme a mano.
   - Si `document.taxes` está vacío, se construye desde el recalculo.
6. **Inserción** vía `apply_row_op`: `invoices` (`source = 'import_v1'`, `import_sha256`, `status = 'registered'` si cuadra y hay `file`, si no `draft`; categoría e inversión de `overrides` → `suggested` → `supplier.default_*` → `otros`/`false`), `invoice_lines` (posición = orden del JSON), `tax_lines`, `invoice_files` (`role = 'original'`) si viene `file`. Después, un `update` directo de `import_meta` (no es columna escribible por el cliente; el procedimiento la escribe con `update` SQL dentro de la misma transacción antes del `apply_row_op` final… ver nota).
   > Nota de implementación: para que `import_meta` quede en el `after` de `core.changes`, el procedimiento la fija con `set_config('invoices.import_meta', …)` y el trigger `assign_code` la copia en el `insert`. Alternativa más simple si Core lo prefiere: hacer `import_meta` escribible y que la Edge la borre de cualquier operación que no sea `call`. Se decide en revisión.
7. **Código.** `code = core.next_code('FVR', extract(year from issue_date))` en el trigger de inserción.
8. **Resultado**: `{invoice_id, code, status, supplier_id, canonical_name|null, warnings[], rounding}`.

El hook `invoices.validate` (§4.3) se ejecuta igualmente al final del lote.

### 3.2 `invoices.register(p jsonb)`

Paso `draft → registered` con comprobación completa (totales, proveedor, documento original presente). `args = {invoice_id, expectedRevision}`. Devuelve la factura. Errores: `INVOICE_INCOMPLETE 422 {missing: [...]}`, `INVOICE_TOTALS_MISMATCH 422`. (Podría hacerse con un `update` de `status`, pero el procedimiento da un mensaje de error útil en vez de un fallo genérico del hook.)

### 3.3 `invoices.annul(p jsonb)`

`args = {invoice_id, expectedRevision, reason}`. Pone `status = 'annulled'`, `annulled_reason`; borra lógicamente sus `allocations` vivas (vía `apply_row_op delete`); si estaba en una entrega `ready|delivered`, marca la entrega `superseded` (`apply_row_op update`). Devuelve `{invoice, superseded_export_id|null}`.

### 3.4 `invoices.create_export(p jsonb)`

`args = {export_id, period_kind, fiscal_year, fiscal_quarter|fiscal_month|from_date,to_date, include_drafts: false}`. Selecciona las facturas `registered` (y `exported` ya entregadas en una entrega `superseded` del mismo periodo) con `issue_date` en el rango; para cada una toma el documento `original` vivo (o la marca `missing_file`), calcula `canonical_name`, construye `manifest` y `totals` (§6.5), inserta `exports` + `export_items` y pasa cada factura a `exported`, todo vía `apply_row_op`. Si hay facturas en `draft` en el periodo y `include_drafts = false` → `EXPORT_HAS_DRAFTS 422 {invoice_ids}` (la UI pide registrarlas o anularlas). Si no hay facturas → `EXPORT_EMPTY 422`. Si ya existe una entrega `ready|delivered` para el mismo periodo exacto → `EXPORT_EXISTS 409 {export_id}` (hay que anular alguna factura, que la pase a `superseded`, o usar `custom`). Devuelve `{export_id, code, invoice_count, manifest_sha256}`. Rol mínimo: `editor`.

### 3.5 `invoices.mark_delivered(p jsonb)`

`args = {export_id, expectedRevision, delivered_to}` → `status = 'delivered'`, `delivered_at = now()`. Trivial pero se mantiene como `call` para que la transición quede nombrada en el historial. Alternativa: `update` normal; se decide en revisión.

---

## 4. Hooks de validación

### 4.1 `beforeCommit` (Edge, `supabase/functions/invoices-api/app.ts`, usando `packages/domain-invoices`)

Para cada operación:

- **Tipos y obligatorios** de cada tabla con los esquemas del dominio (mismos que usa el cliente offline). Mensajes en español con `field`.
- `invoices.invoices`: `kind = 'received'` (`UNSUPPORTED_IN_V1 422`); `currency = 'EUR'`; `delete` → `INVOICE_NOT_DELETABLE 422` (usar `annul`); `status = 'exported'` o `'annulled'` por `update` directo → `INVALID_TRANSITION 422` (solo procedimientos); `paid_at` obligatorio con `paid`.
- `invoices.invoice_files`: `insert` → `core_file_get(file_id)` debe devolver `app = 'invoices'`, `status = 'verified'`, `mime` admitido; copia `sha256`, `size`, `mime` del registro al `fields` (el cliente no decide los hashes). `delete` → `INVOICE_FILE_LOCKED 422` salvo factura en `draft` (comprobado por el trigger; aquí se da el mensaje).
- `invoices.allocations`: pares `target_app`/`target_kind` válidos; `target_id` obligatorio salvo `general`; `target_app in ('booking','food')` → `TARGET_APP_NOT_AVAILABLE 422` mientras no existan las proyecciones de fase 2 (bandera `TARGETS_ENABLED` en la Edge); `target_app = 'tasks'` → **validación contra la API de Tareas con el token del usuario** (§7.2): `GET {TASKS_API}/api/v1/targets/:kind/:id` con el bearer de la petición. Si responde 200 → se rellenan `target_label`, `target_code`, `target_revision` en `fields`; 404 → `TARGET_NOT_FOUND 422`; 403 → `TARGET_FORBIDDEN 422`; red/5xx → `TARGET_UNAVAILABLE 503` (el comando se queda en la cola del cliente y se reintenta).
- `call invoices.import_v1`: valida el documento con el esquema TS antes de llegar a SQL (mismo código que el cliente); si viene `file`, mismo chequeo que en `invoice_files`.
- `call invoices.create_export`: solo `editor|owner`; rangos de fechas coherentes.

### 4.2 Triggers (`invoices.*`, en la migración)

Protegen invariantes aunque alguien llame a `core.commit` sin pasar por la Edge:

- `invoices.assign_code` (`before insert` en `invoices` y `exports`): `code := core.next_code(prefijo, año)` si `code is null`.
- `invoices.guard_invoice` (`before update` en `invoices`): `deleted_at` pasa de nulo a no nulo → `core.fail('INVOICE_NOT_DELETABLE', 422)`; fila en `exported` y cambia una columna fuera de `{payment_status, payment_method, paid_at, notes, status(→annulled), annulled_reason}` → `INVOICE_LOCKED 409`; fila en `annulled` y cambia algo distinto de `notes` → `INVOICE_ANNULLED 409`; `status = 'annulled'` sin `annulled_reason` → `ANNUL_REASON_REQUIRED 422`; `payment_status = 'paid'` sin `paid_at` → `PAID_AT_REQUIRED 422`; transición no permitida (§2.11) → `INVALID_TRANSITION 422`.
- `invoices.guard_line` / `guard_tax_line` / `guard_file` (`before insert or update`): la factura padre no está en `exported|annulled` (salvo `invoice_files` con `role = 'attachment'`), y borrado lógico solo con padre en `draft` → `INVOICE_LOCKED 409` / `INVOICE_FILE_LOCKED 422`.
- `invoices.guard_export` (`before update` en `exports`): `deleted_at` → `EXPORT_NOT_DELETABLE 422`; `manifest`, `totals`, `invoice_count`, periodo inmutables → `EXPORT_IMMUTABLE 409`.
- `check` de pares en `allocations`: `(target_app = 'general' and target_kind is null and target_id is null) or (target_app = 'tasks' and target_kind in ('project','task') and target_id is not null) or (target_app = 'booking' and target_kind = 'event' and target_id is not null) or (target_app = 'food' and target_kind in ('menu','shopping_list') and target_id is not null)`.

### 4.3 `validate_hooks` SQL: `invoices.validate(p jsonb)`

Registrado con `core.add_validate_hook('invoices', 'invoices.validate')`. Se ejecuta al final de cada lote y comprueba solo las facturas tocadas en la transacción: las que tienen `updated_at = now()` o alguna línea, impuesto, documento o asignación con `updated_at = now()` (dentro de una transacción `now()` es constante y `core.touch_revision` lo usa). Para cada una:

1. Si `status in ('registered','exported')`:
   - cada línea viva: `|line_base − round(q×p×(1−d/100),2)| ≤ 0,01` → si no, `LINE_BASE_MISMATCH 422 {line_id}`;
   - `|Σ tax_lines.base (iva/exento/no_sujeto) − subtotal| ≤ 0,02` → `SUBTOTAL_MISMATCH`;
   - `|Σ iva.amount + Σ recargo.amount − tax_total| ≤ 0,02` → `TAX_MISMATCH`;
   - `|Σ retencion.amount − withholding_total| ≤ 0,02` → `WITHHOLDING_MISMATCH`;
   - `|subtotal + tax_total − withholding_total − total| ≤ 0,02` → `TOTAL_MISMATCH`;
   - si hay líneas vivas: `|Σ line_base − subtotal| ≤ 0,02` → `LINES_MISMATCH` (se permite factura sin líneas: solo desglose fiscal, típico de suministros);
   - existe un `invoice_files` vivo con `role = 'original'` → si no, `ORIGINAL_FILE_REQUIRED` (solo al entrar en `registered`; una `registered` antigua sin original se tolera, pero Gestoría la marca).
2. Siempre: `Σ allocations.amount vivas ≤ subtotal + 0,02` → `ALLOCATIONS_EXCEED_SUBTOTAL 422 {invoice_id, allocated, subtotal}`; una asignación con `invoice_line_id` no excede `line_base` de su línea → `ALLOCATION_EXCEEDS_LINE 422`.
3. `tax_lines` vivas sin duplicar `(kind, rate)`.

Los códigos se lanzan con `core.fail(code, 422, details)` y llegan al cliente como `{error:{code,message,details}}`.

---

## 5. Visibilidad

Invoices **no tiene ámbitos**: `memberships.scopes` es `null` y no se define el hook `visible`. La visibilidad es la membresía (`reader`, `editor`, `owner`). Si algún día la gestoría no debe ver notas internas, se añadirá una proyección, no ámbitos.

---

## 6. Rutas propias (`/api/v1/...`)

Las rutas del núcleo (`bootstrap`, `snapshot`, `changes`, `commands`, `history`, `uploads`, `files`, `trash/purge`, `members`, `me`, `auth/*`, `health`) las da `_kit`. Las propias:

| Método y ruta | Entrada | Salida | Errores | Rol |
|---|---|---|---|---|
| `GET dashboard` | — | `{cursor, counts:{drafts, unallocated, unpaid, pending_exports}, last_export, current_period:{year, quarter, totals}}` | — | reader |
| `POST imports/preview` | `{document, supplier?: {mode,id}, overrides?}` | Normalización y recalculo **sin escribir**: `{document_sha256, supplier_matches:[{id,name,tax_id,score}], duplicate:{invoice_id,code}|null, calculated, declared, deltas, within_tolerance, proposed:{expense_category,is_investment,status}, canonical_name_preview, warnings}` | `IMPORT_INVALID 422` | editor |
| `POST imports/extract` | `{file_id}` | **Reservada V2** (extracción desde la Edge). Responde `NOT_IMPLEMENTED 501` en V1. | | editor |
| `GET targets/tasks?q=&kind=` | búsqueda | Proxy a la API de Tareas con el token del usuario (§7.2): `{items:[{kind, id, code, label, parent_label, revision}]}` | `TARGET_UNAVAILABLE 503`, `TARGET_APP_NOT_AVAILABLE 422` | editor |
| `GET targets/tasks/:kind/:id` | — | `{kind, id, code, label, revision, archived}` | `TARGET_NOT_FOUND 404` | reader |
| `GET targets/booking?q=` · `GET targets/food?q=` | — | Fase 2 (proyecciones). `TARGET_APP_NOT_AVAILABLE 422` en V1. | | reader |
| `GET fiscal/summary?year=&quarter=` (o `&month=`) | — | §6.4. Mismo cálculo que hace el cliente offline con `domain-invoices`; esta ruta existe para agentes y para la gestoría sin app instalada. | `INVALID_FILTER 422` | reader |
| `GET purchases?year=&quarter=&status=&target=` | filtros | Lista de Compras (§6.3) paginada, para agentes; la app la calcula en local. | | reader |
| `GET exports` | — | `{items:[export…]}` (también están en el espejo) | | reader |
| `GET exports/:id/manifest.json` | — | El manifest tal cual (`Content-Disposition: attachment`) | `NOT_FOUND` | reader |
| `GET exports/:id/download` | — | **ZIP en streaming** (§6.5). `Content-Type: application/zip`, nombre `GST_2026_002__2026T1.zip`. | `EXPORT_FILE_MISSING 409` si algún documento ya no está en Storage (el manifest dice cuál) | reader |

Las escrituras (`import_v1`, `register`, `annul`, `create_export`, `mark_delivered`) van siempre por `POST commands` como `call`, nunca por rutas propias, para que el cliente offline las encole igual que el resto.

### 6.1 Importación: flujo completo

1. El usuario pega el JSON (o lo carga como archivo) y elige PDF/foto.
2. Cliente: valida con `domain-invoices`, recalcula, muestra el cuadre (declarado vs calculado, deltas), propone proveedor (por `tax_id`, luego por `aliases`/nombre normalizado) y categoría. Con red, además llama a `imports/preview` para el chequeo de duplicados en servidor; sin red, busca duplicados en el espejo local.
3. Al confirmar: `stageBlob(pdf)` (o foto recomprimida), `commit([{op:'call', procedure:'invoices.import_v1', args}], {blobs:[blob]})`. El cliente offline sube el blob (`uploads` → PUT → `verify`) antes de enviar el comando, como manda el contrato §6.2; `args.file.file_id` lo resuelve el cliente al conocer el id del ticket (el `sync-client` sustituye el marcador `{"$blob": "<sha256>"}` por el `file_id` verificado — **petición a Core**, §12).
4. La factura aparece en la lista como «pendiente de sincronizar» con los datos locales; el `code` se muestra como «pendiente» hasta que llega el recibo.

### 6.2 Tareas como destino: flujo

Desde una factura o línea: «Asignar a…» → `general` o `Tasks` → buscador (`targets/tasks?q=`) con los últimos destinos usados en caché local → al elegir, `insert` en `allocations` con `target_label` del resultado. Sin red: solo se puede elegir entre destinos cacheados (últimos 50) o `general`; la validación real ocurre en `beforeCommit` al sincronizar. Si entonces falla (`TARGET_NOT_FOUND`), el comando pasa a la lista de conflictos con la opción «cambiar destino» o «pasar a general».

### 6.3 Compras (lectura compuesta)

Por factura viva no anulada: código, fecha, proveedor, categoría, inversión, `subtotal`, `total`, `payment_status`, asignado (`Σ allocations`), sin asignar (`subtotal − asignado`), destinos (chips `target_app/label`), documento (sí/no), estado. Filtros: periodo, proveedor, categoría, inversión, «sin destino», «sin pagar», «sin documento», destino concreto. Agrupaciones: por categoría, por destino, por proveedor. Totales del filtro (base y total). Se calcula con `summarizePurchases(rows, filters)` del dominio sobre el espejo local; la ruta `purchases` ejecuta la misma función en la Edge sobre `core_snapshot_table`.

### 6.4 Resumen fiscal

`fiscalSummary(invoices, taxLines, period)` del dominio:

```json
{
  "period": { "kind": "quarter", "year": 2026, "quarter": 1, "from": "2026-01-01", "to": "2026-03-31" },
  "invoice_count": 42, "draft_count": 1, "annulled_count": 2, "missing_file_count": 0,
  "by_rate": [ { "kind": "iva", "rate": 21, "base": 1200.00, "amount": 252.00 }, { "kind": "iva", "rate": 10, "base": 800.00, "amount": 80.00 }, { "kind": "exento", "rate": 0, "base": 150.00, "amount": 0 } ],
  "withholdings": 0.00,
  "subtotal": 2150.00, "tax_total": 332.00, "total": 2482.00,
  "deductible": { "si": 2400.00, "no": 82.00, "parcial": 0, "no_aplica": 0 },
  "by_category": [ { "expense_category": "compras", "is_investment": false, "subtotal": 1500.00, "tax_total": 150.00, "total": 1650.00, "count": 20 } ],
  "investment": { "subtotal": 500.00, "total": 605.00, "count": 2 },
  "operating": { "subtotal": 1650.00, "total": 1877.00, "count": 40 },
  "unpaid": { "count": 3, "total": 420.00 },
  "exports": [ { "id": "…", "code": "GST_2026_001", "status": "delivered", "invoice_count": 40 } ]
}
```

Solo facturas `registered|exported` (las `draft` y `annulled` se cuentan aparte). Es «IVA soportado» del periodo; el devengado no existe en Invoices V1.

### 6.5 ZIP de gestoría y manifest

`invoices.create_export` congela el conjunto; `GET exports/:id/download` genera el ZIP **bajo demanda y en streaming** desde Storage (los documentos son inmutables y están verificados por hash), sin guardar el ZIP ni cargarlo entero en memoria de la Edge (`fflate` en modo `Zip` + `ZipPassThrough`, sin compresión para PDF e imágenes). Si en el futuro conviene archivar el ZIP, se sube con `uploads` y se guarda `file_id` en `exports` (columna reservada `zip_file_id uuid null`).

Contenido del ZIP `GST_2026_002__2026T1.zip`:

```
manifest.json
manifest.csv                 (una fila por factura, separador ';', UTF-8 con BOM, para Excel)
resumen_fiscal.json          (= totals)
facturas/
  2026-01-07__FVR_2026_001__iberdrola__0012345678.pdf
  2026-01-12__FVR_2026_002__makro__a-2026-0031.pdf
  2026-01-12__FVR_2026_002__makro__a-2026-0031__2.jpg   (adjuntos y fotos)
```

`manifest.json` (claves ordenadas, es lo que se hashea en `manifest_sha256`):

```json
{
  "schema": "ikisai.invoices.export.v1",
  "export": { "code": "GST_2026_002", "period": {...}, "created_at": "…", "created_by": "nombre visible", "app_release": "v0.2.0" },
  "totals": { "...": "§6.4" },
  "invoices": [
    { "code": "FVR_2026_001", "supplier": { "name": "…", "tax_id": "…" }, "invoice_number": "…", "issue_date": "2026-01-07",
      "expense_category": "suministros", "is_investment": false, "deductible": "si",
      "subtotal": 100.00, "tax_total": 21.00, "withholding_total": 0, "total": 121.00,
      "taxes": [ { "kind": "iva", "rate": 21, "base": 100.00, "amount": 21.00 } ],
      "payment": { "status": "paid", "method": "domiciliacion", "paid_at": "2026-01-20" },
      "files": [ { "name": "facturas/2026-01-07__FVR_2026_001__iberdrola__0012345678.pdf", "role": "original", "sha256": "hex64", "size": 83211, "mime": "application/pdf" } ],
      "missing_file": false, "invoice_revision": 4 }
  ],
  "integrity": { "algorithm": "sha256", "file_count": 41, "note": "Cada hash es el SHA-256 del archivo incluido; el manifest_sha256 de la entrega es el SHA-256 de este documento sin la clave integrity.manifest_sha256." }
}
```

El cliente, al descargar, puede comprobar los hashes con Web Crypto y mostrar «entrega íntegra». La gestoría recibe el ZIP por el canal que el usuario quiera; la app registra `delivered_to` con `mark_delivered`.

---

## 7. Proyecciones y enlaces

### 7.1 Lo que publica Invoices (para fase 2)

- `invoices.booking_cost_projection` (`event_id, allocation_id, invoice_code, issue_date, supplier_name, expense_category, is_investment, amount, allocation_revision`): coste asignado por evento, sin notas ni documentos. La lee `booking-api` para «coste por retiro».
- `invoices.food_stock_projection` (`invoice_id, invoice_code, issue_date, supplier_name, line_id, description, product_ref, quantity, unit, unit_price, line_base, tax_rate, line_revision`): líneas de facturas `registered|exported` con categoría `compras`, para que Food cree `stock_entries`. Sin importes de la factura completa.

Ambas sin datos personales (el NIF de una empresa no es dato personal, pero igualmente no se expone en las proyecciones). Las crea la migración de Invoices; cómo las consulta la otra Edge lo decide Core (§12).

### 7.2 Destinos que consume

| `target_app` | `target_kind` | Cómo se valida | Fase |
|---|---|---|---|
| `general` | `null` | Sin validación. | V1 |
| `tasks` | `project`, `task` | API de Tareas con el **token del usuario**: la Edge reenvía el bearer de la petición a `GET {TASKS_API_BASE}/api/v1/targets/:kind/:id` (o la ruta equivalente que publique `docs/tasks/API.md`; se pide que exista una ruta de resolución de destino que devuelva `{id, code?, label, parent_label?, revision, archived}` y una búsqueda `targets?q=`). El usuario solo puede asignar a lo que él mismo ve en Tareas. `TASKS_API_BASE` es `https://tasks.ikisai.com` en producción y la función `tasks-api` directa en QA. | V1 |
| `booking` | `event` | Proyección `booking.food_event_projection` (ya normativa en el contrato §8, tiene `event_id, event_code, title, start_date, end_date, event_revision`); basta para Invoices, no hace falta una proyección nueva. | Fase 2 |
| `food` | `menu`, `shopping_list` | Proyección a pedir a Food (`food.invoices_menu_projection` con `menu_id, code, title, event_code, menu_revision`). | Fase 2 |

### 7.3 Obsolescencia

No hay flags `stale`. La UI compara `allocations.target_revision` con la revisión actual que devuelve `targets/…/:id` (o la proyección) y muestra «el destino cambió» con botón «revisar»; si el destino está archivado o no existe, «destino desaparecido», con opción de pasar a `general`. Comprobación en segundo plano al abrir Compras con red, nunca en el pull.

---

## 8. Archivos

- **Bucket:** `purchase-documents` (privado, 52 428 800 bytes por archivo). Tipos: `application/pdf`, `image/webp`, `image/jpeg`, `image/png` (ya configurado en `invoices-api`).
- **PDF:** sin límite propio; se encola tal cual. Se muestra el tamaño antes de subir y se avisa por encima de 20 MB.
- **Fotos:** recomprimidas en el cliente a lado mayor 1600 px, WebP calidad media, **sin conservar el original** (contrato §11.3). Varias fotos de una misma factura son varios `invoice_files` con `role = 'photo'`; la primera foto pasa a `original` si no hay PDF.
- **Flujo:** `stageBlob` → al reconectar `uploads` → `PUT` firmado → `uploads/:id/verify` → comando que referencia el `file_id`. El cliente guarda el `sha256` del blob y lo muestra; la Edge copia `sha256/size/mime` desde `core.files` al validar el `insert` (el hash que vale es el verificado por el servidor).
- **Duplicados:** si `uploads` devuelve `duplicateOf`, la UI avisa «este documento ya está en la factura FVR_…» (busca `invoice_files.file_id = duplicateOf`) y permite seguir (una misma factura puede llegar dos veces por error: el chequeo de `invoice_number` lo cazará).
- **Lectura:** `GET files/:id` (URL firmada 10 minutos). Visor PDF embebido en escritorio; en móvil abre en el visor del sistema. Las miniaturas de fotos se cachean en el cliente (IndexedDB `blobs` ya existente o caché del SW con límite 50 MB).
- **Tablas que referencian `core.files`:** `invoice_files.file_id` (y la columna reservada `exports.zip_file_id`).

---

## 9. Pantallas y navegación

Cuatro entradas en la barra (ya existen como marcadores en `apps/invoices/src/ui/shell.ts`): **Inicio · Facturas · Compras · Gestoría**. Proveedores y Conflictos siguen colgando de Inicio. Canon: modo lectura primero, estado antes que formulario, sin paneles decorativos. Móvil 390 px y escritorio 1440 px.

### 9.1 Inicio

Lectura: saludo, estado de sincronización (ya existe), y tres tarjetas de estado con número y acción: **Por registrar** (`draft`), **Sin destino** (facturas con base sin asignar), **Sin pagar** (con vencimiento más próximo); tarjeta del **trimestre en curso** (base, IVA soportado, nº facturas, botón «Preparar entrega»); acceso a Proveedores, Conflictos e instalación. Acción principal: botón flotante **«Nueva factura»** → hoja con dos opciones: «Pegar JSON de extracción» e «Introducir a mano».

### 9.2 Facturas

Lectura: lista ordenada por `issue_date desc`, agrupada por mes, cada fila: código (o «pendiente»), proveedor, número, fecha, total, chips de estado (`draft`/`registered`/`exported`/`annulled`, `pagada`, `sin documento`, `pendiente de sincronizar`). Buscador (proveedor, número, código, importe) y filtros plegables (periodo, estado, pago, categoría, inversión). Sección plegable **Anuladas**.

Detalle (hoja completa en móvil, panel lateral en escritorio): cabecera con código, proveedor, fechas, totales y estado; bloques plegables **Documento** (visor / miniaturas, añadir foto o PDF), **Líneas** (tabla, edición en sitio en `draft`/`registered`), **Impuestos** (desglose), **Asignación** (lista de destinos con importes y barra «asignado / sin asignar», botón «Asignar a…»), **Pago** (estado, método, fecha), **Fiscal** (categoría, inversión, deducible, periodo derivado, solo lectura del periodo), **Importación** (si `source = 'import_v1'`: confianza, avisos, deltas de redondeo), **Historial** (lotes de `history` que tocan la factura). Acciones: Registrar, Anular (con motivo), Marcar pagada. En `exported` todo lo bloqueado se muestra con candado y el código de la entrega.

Importar: pantalla de tres pasos en una sola hoja: (1) JSON pegado o archivo + documento, (2) **cuadre** (tabla declarado vs calculado con deltas en rojo si > 0,02; proveedor propuesto o nuevo; categoría e inversión), (3) confirmar → vuelve al detalle.

### 9.3 Compras

Lectura: la vista §6.3. Selector de periodo arriba (trimestre por defecto, mes o año), pestañas **Por categoría · Por destino · Por proveedor · Lista**; en cada agrupación, filas con base, total y nº de facturas, y «sin destino» siempre visible como primera fila cuando no es cero. Toque en una fila → lista filtrada. Edición: desde una factura de la lista, «Asignar a…» en sitio (hoja de destinos con buscador de Tareas, destinos recientes y `general`). Indicador de obsolescencia por destino (§7.3). Totales del filtro fijos abajo en móvil.

### 9.4 Gestoría

Lectura: selector de periodo; **resumen fiscal** (§6.4) en bloques: por tipo de IVA, deducibilidad, explotación vs inversión, por categoría; **avisos** que impiden o afean la entrega (borradores, facturas sin documento, sin pagar vencidas); lista de **entregas** (`exports`) del año con estado, nº de facturas, `manifest_sha256` abreviado y acciones «Descargar ZIP», «Ver manifest», «Marcar entregada», y «Sustituir» cuando está `superseded`. Botón **«Preparar entrega del periodo»** → confirmación con el recuento y la lista de lo que entra → `create_export` → descarga. Para `reader` (gestoría): la misma pantalla sin botones de escritura.

### 9.5 Proveedores (existe)

Se añaden `aliases`, `default_is_investment`, `country` al formulario y, en el detalle, el total facturado del año y las últimas facturas.

---

## 10. Offline

**Espejo local:** todas las tablas `invoices.*` (`suppliers, invoices, invoice_files, invoice_lines, tax_lines, allocations, exports, export_items`). El volumen esperado (cientos de facturas al año, miles de líneas) cabe sin paginación especial.

**Sin red se puede:** crear y editar proveedores; registrar una factura a mano; importar un JSON (validación, recalculo y cuadre son locales con `domain-invoices`; el chequeo de duplicados usa el espejo); adjuntar PDF y fotos (cola de blobs; la foto se recomprime al momento); asignar a `general` y a destinos de Tareas **recientes** (caché local de los últimos 50 destinos resueltos); marcar pagada; anular; ver Facturas, Compras y el resumen fiscal del periodo (todo se calcula en local); ver los documentos ya cacheados.

**Requiere red:** buscar destinos nuevos en Tareas, crear una entrega (`create_export` se encola, pero la UI lo desaconseja: «se creará al reconectar»; el ZIP solo se descarga con red), descargar ZIP y manifest, ver documentos no cacheados, `imports/preview` del servidor.

**Pendientes y conflictos:** filas con chip «pendiente de sincronizar» (ya existe el patrón); el `code` aparece como «pendiente» hasta el recibo; en el detalle, aviso «los totales se validarán al sincronizar». Errores 422 del servidor en un comando encolado (p. ej. `IMPORT_TOTALS_MISMATCH` porque alguien cambió el proveedor, o `TARGET_NOT_FOUND`) se muestran en Conflictos con el mensaje de dominio y las acciones «editar y reintentar» / «descartar». Los `VERSION_CONFLICT` siguen la regla general (rebase de campos disjuntos; decisión humana si se solapan). Un `annul` contra una factura ya en `exported` por otra persona pide confirmación explícita porque supersede la entrega.

**Adjuntos:** si la subida falla (hash distinto, archivo demasiado grande), el comando que la referencia no se envía y la factura muestra «documento pendiente: reintentar / quitar».

---

## 11. Aceptación

Recorrido de aceptación (letra A del checklist del handoff, adaptada; Core debe cotejarla con `07_CHECKLIST_ACEPTACION.md` A). Todo con datos sintéticos (proveedores y NIF inventados, PDF generados).

| Nº | Escenario | Resultado esperado |
|---|---|---|
| A1 | Login, instalación como PWA en Android y PC. | Shell con las cuatro entradas; estado «En línea · Todo sincronizado». |
| A2 | Importar JSON v1 válido con PDF (cuadra exacto). | Vista de cuadre sin deltas; al confirmar, factura `registered`, código `FVR_2026_001`, documento con nombre canónico correcto, proveedor creado con `aliases`. |
| A3 | Importar JSON con redondeo de 0,01 en una base. | Cuadre muestra delta ≤ 0,02 en ámbar; se aceptan cifras declaradas; `import_meta.rounding` recoge la diferencia. |
| A4 | Importar JSON con total que no cuadra en 0,50. | `IMPORT_TOTALS_MISMATCH`; la UI ofrece «corregir líneas» o «aceptar lo declarado» → queda en `draft` con «necesita revisión». |
| A5 | Importar dos veces la misma factura (mismo proveedor y número). | `DUPLICATE_INVOICE` con enlace a la existente. |
| A6 | Proveedor con NIF ya existente pero nombre distinto en el JSON. | Se propone el existente; al confirmar, el nuevo nombre se añade a `aliases`. |
| A7 | Factura a mano (suministro, sin líneas, solo desglose IVA 21). | Pasa a `registered` al tener documento y cuadre; periodo fiscal derivado correcto. |
| A8 | Foto de ticket desde el móvil. | Recomprimida (≤ 300 KB aprox.), subida, `role = 'original'`, visible en escritorio. |
| A9 | Asignar 60 % de la base a un proyecto de Tareas y el resto a `general`. | Buscador de Tareas con el token del usuario; `target_label` y `target_revision` guardados; Compras muestra «sin destino» = 0. |
| A10 | Intentar asignar más que la base. | `ALLOCATIONS_EXCEED_SUBTOTAL` con mensaje en español. |
| A11 | Asignar a un proyecto al que el usuario no tiene acceso en Tareas (sesión de otro usuario). | `TARGET_FORBIDDEN`; no se guarda. |
| A12 | Compras del trimestre: por categoría, por destino, por proveedor; filtros «sin destino» y «sin pagar». | Totales coinciden con la suma de las facturas listadas (prueba automática). |
| A13 | Gestoría: resumen fiscal del T1. | Bases e IVA por tipo coinciden con `tax_lines`; explotación vs inversión; deducibilidad. |
| A14 | Preparar entrega del T1 con un borrador pendiente. | `EXPORT_HAS_DRAFTS` con la lista; tras registrar o anular, se crea `GST_2026_001`, facturas pasan a `exported`. |
| A15 | Descargar ZIP y manifest; verificar hashes con una herramienta externa (`sha256sum`). | Nombres canónicos, hashes correctos, `manifest.csv` abre en Excel con acentos correctos. |
| A16 | Editar `issue_date` de una factura `exported`. | `INVOICE_LOCKED`; `notes` y pago sí se editan. |
| A17 | Anular una factura `exported`. | Confirmación explícita; factura `annulled`, entrega pasa a `superseded`; Gestoría ofrece «Sustituir» → nueva `GST_2026_002` sin la anulada. |
| A18 | Marcar entrega como entregada con texto. | `delivered_at`, `delivered_to`; historial muestra el lote. |
| A19 | Vaciar papelera como `owner`. | Borra proveedores y asignaciones en papelera; facturas y documentos no (`never_purge`). |
| A20 | `reader` (gestoría): entra, ve Gestoría y descarga ZIP; intenta editar. | Descarga correcta; escrituras `FORBIDDEN`, botones ocultos. |
| A21 | Historial y deshacer un cambio de pago. | `undo` restaura; deshacer un lote con `call` → `UNDO_UNAVAILABLE` explicado. |

Escenarios offline automatizados en Playwright (`tests/invoices/`), sobre el patrón existente de `smoke.spec.ts` y `fake-api.ts` (que se amplía para `call`, `uploads` y `targets/tasks`):

| Nº | Escenario |
|---|---|
| O1 | Corte de red durante la importación: JSON + PDF quedan en cola; la factura aparece «pendiente»; al reconectar sube el PDF, verifica, envía `import_v1`, y aparece el código. |
| O2 | Recarga con cola pendiente (dos facturas, una foto): la cola sobrevive; se vacía en orden al reconectar. |
| O3 | Conflicto disjunto: A cambia `notes`, B cambia `payment_status` offline → rebase automático y aviso discreto. |
| O4 | Conflicto solapado: ambos cambian `expense_category` → decisión humana; la decisión genera un comando nuevo. |
| O5 | Asignación offline a destino cacheado que ha desaparecido: al sincronizar, `TARGET_NOT_FOUND` → Conflictos → «pasar a general». |
| O6 | Subida fallida (hash distinto simulado): el comando no se envía; «documento pendiente: reintentar». |
| O7 | Compras y resumen fiscal offline coinciden con los del servidor tras sincronizar (misma función de dominio). |
| O8 | `reader` offline: lectura completa, sin botones de escritura; ZIP deshabilitado sin red con explicación. |

Pruebas de dominio (`packages/domain-invoices`, `tsx --test`): recalculo y tolerancia (tabla de casos con redondeos), nombre canónico (paridad con la función SQL usando PGlite), `fiscalSummary` y `summarizePurchases` sobre fixtures sintéticos, validación del esquema `ikisai.invoice.v1` (casos válidos e inválidos), lista de categorías igual a la de la migración.

Conformidad: `tests/core/invoices-conformance.test.ts` sigue pasando con `invoices.suppliers`; se añade una segunda ejecución sobre `invoices.allocations` (tabla con FK) y pruebas propias en `tests/core/invoices-domain.test.ts` para `import_v1` (cuadre, duplicados, tolerancia), `create_export` (bloqueo, superseded), triggers de bloqueo y el hook `invoices.validate`.

---

## 12. Reparto entre agentes

### Backend (SQL + Edge + dominio)

- `supabase/migrations/2026MMDD_000N_invoices_model.sql`: ampliación de `suppliers`, tablas §2.2–§2.8, funciones `expense_category_values`, `slugify`, `canonical_name`, triggers §4.2, hook `invoices.validate`, procedimientos §3, proyecciones §7.1, `register_table` de cada tabla con `never_purge` donde toca, `allow_procedure` y `add_validate_hook`. Una sola migración si Core lo prefiere, o dos (`_model` y `_procedures`).
- `packages/domain-invoices`: tipos de fila, esquemas de validación (ligeros, sin dependencias), `EXPENSE_CATEGORIES`, `recalculate(document)`, `compareWithTolerance`, `canonicalName`, `slugify`, `fiscalSummary`, `summarizePurchases`, `validateImportDocument`, mensajes de error en español por código.
- `supabase/functions/invoices-api`: `beforeCommit` completo (§4.1), rutas §6, cliente de la API de Tareas con el bearer del usuario, generación del ZIP en streaming, manifest y CSV.
- `tests/core/invoices-*.test.ts` y pruebas de dominio.

### Frontend (Vite + UI)

- `apps/invoices/src/ui/`: `invoices.ts` (lista y detalle), `import.ts` (tres pasos), `allocations.ts` (hoja de destinos), `purchases.ts`, `accounting.ts` (Gestoría), ampliación de `suppliers.ts` y `home.ts`; `app/client.ts` con todas las tablas; `app/files.ts` (recompresión de fotos, hash, cola); `app/targets.ts` (caché de destinos).
- Consume `@ikisai/ui-kit` cuando el agente UI publique la primera entrega; hasta entonces, `styles/tokens.css` provisional.
- `tests/invoices/`: ampliación de `fake-api.ts` y escenarios O1–O8.

### Orden y verticales

1. **Base común** (backend primero, una semana): migración + dominio + `beforeCommit` + conformidad. El frontend empieza en paralelo con la lista y el detalle de facturas usando `fake-api.ts` ampliado.
2. Después, por verticales, cada una con su rama `invoices/<vertical>`:
   - **Importación y documentos** (`import_v1`, cuadre, fotos, visor).
   - **Compras y destinos** (asignaciones, Tareas con token, caché de destinos, vista Compras).
   - **Gestoría** (resumen fiscal, `create_export`, ZIP y manifest, `reader`).
3. Fase 2 (con Core): destinos Booking y Food, proyecciones §7.1 y extracción desde la Edge.

### Peticiones a Core (se anotan en `docs/core/PETICIONES.md`)

1. **Bearer en `RequestContext`:** `beforeCommit` necesita el token del usuario para validar destinos de Tareas (§4.1, §7.2). Hoy `Identity` tiene `id, email, sessionId` y el hook no recibe la `Request`. Se pide `ctx.token` (o `ctx.request`).
2. **Sustitución de blobs en `call`:** el `sync-client` sube los blobs antes del comando, pero los `args` de un `call` necesitan el `file_id` verificado. Se pide que el cliente sustituya marcadores `{"$blob":"<sha256>"}` dentro de `fields` y `args` por el `file_id` (y, si es útil, `{"$blobMeta":"<sha256>"}` por `{file_id, sha256, size, mime}`).
3. **Lectura de proyecciones ajenas** desde una Edge (fase 2): un wrapper `public.core_projection(app, view, filters)` o un registro `core.register_projection` con allow-list; necesario para que `invoices-api` lea `booking.food_event_projection` y para que `booking-api`/`food-api` lean las de §7.1.
4. **`fflate` en la Edge:** confirmar que importar una dependencia npm (`npm:fflate`) en `invoices-api` es aceptable para el script de despliegue (sube archivos sueltos; el import remoto lo resuelve Deno al desplegar).
5. **Lint de migraciones:** confirmar que las funciones y triggers propios del schema `invoices` que llaman a `core.fail`, `core.next_code` y `core.apply_row_op` pasan el lint (están en `CORE_HELPERS`), y que las columnas generadas no rompen `jsonb_populate_record` en `apply_row_op` (no se insertan porque no son escribibles; se pide una prueba en `test-kit`).
6. **Ruta de destinos en Tasks:** coordinar con el equipo Tasks que `docs/tasks/API.md` incluya `GET targets?q=&kind=` y `GET targets/:kind/:id` (o equivalente) devolviendo `{id, code?, label, parent_label?, revision, archived}` respetando los ámbitos del usuario.
7. **Handoff V3:** la carpeta no está en este PC; se pide el zip (o su ruta) para cotejar §3.1 (esquema del JSON), §2.12 (nombre canónico) y §11 (checklist A).
