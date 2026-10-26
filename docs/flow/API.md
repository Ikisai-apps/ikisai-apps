# Flow · API y modelo de datos (puerta G2, aprobado por Core el 26-10-2026)

Referencia funcional: documento de VG «IKISAI FLOW · Documento maestro para Dirección», V1 del 26-10-2026 (canon V1; no está en el repo). Aquí, «§n» remite a ese documento y «contrato §n», a `docs/core/CONTRATO_SINCRONIZACION.md`. Primer caso: la barra del evento del 30-10 al 1-11-2026, con el sábado 31 como día principal.

## 1. Dominio y límites

Flow coordina **unidades de trabajo** en **columnas** dentro de **proyectos** (§1.1, §10). El primer proyecto es la barra: pedidos con cobro manual, montaditos que se preparan uno a uno, entrega del pedido completo (con bebidas y extras) y tareas de logística.

Dos capas (§10.1, «el flujo genérico y el pedido comercial no son lo mismo»):

- **Genérica:** proyecto, columnas (su comportamiento es dato), unidades con estado y asignación, y eventos.
- **Barra:** catálogo, pedidos, líneas, pagos. Un marco acústico futuro usaría solo la capa genérica.

Fuera de V1 (§1.3): inventario de Food, contabilidad, Booking, Tasks, TPV o Bizum automático, constructor de flujos, clientes registrados y estadísticas. No se copia nada de otras apps. Los enlaces futuros (§11.4) irán como destinos tipados (contrato §8).

## 2. Tablas sincronizables (`flow.*`)

Todas llevan las columnas del contrato §2.1 y quedan en `core.synced_tables` en la misma migración (rango **0900–0999**). Los importes se guardan en **céntimos** (`integer`). Los estados cerrados van como `check`.

| Tabla | Propósito | Columnas propias | `writable_columns` | Escriben |
|---|---|---|---|---|
| `flow.projects` | Operación colectiva («Barra · Evento de octubre») | `name text not null`, `status text check in ('active','closed')`, `notes text`, `last_pay_seq int` (último número de cobro; solo lo sube `confirm_payment`) | `name`, `status`, `notes` | owner (y `last_pay_seq`, por procedimiento) |
| `flow.columns` | Columnas del proyecto, como dato (§2.3, §10.2) | `project_id` FK, `key text` (`order`, `prep`, `service`, `logistics`), `label text`, `behavior text check in ('inspect_confirm','quick_steps','free_task')`, `position int`; único `(project_id, key)` | `label`, `position` | owner |
| `flow.products` | Catálogo de la barra (§8) | `project_id` FK, `scope text check in ('clasico','gourmet','barra')`, `code text check in ('A','B','C','D','α','β','γ','δ')`, `name`, `description`, `price_cents int check >= 0`, `active bool`, `prepared bool` (montadito: genera unidades), `position int`; **único `(project_id, scope, code)`** entre los vivos | `name`, `description`, `price_cents`, `active`, `position` (y al crear, `project_id`, `scope`, `code`, `prepared`) | owner |
| `flow.product_components` | Componentes y estación (1 Untar · 2 Colocar · 3 Dosificar · 4 Acabados) de cada montadito (§8.1–8.2) | `product_id` FK, `station int check 1..4`, `ingredient text`, `position int` | todas | owner |
| `flow.orders` | Pedido = lote (§4) | `project_id` FK, `origin text check in ('public','counter')`, `status text check in ('open','paid','delivered')`, `pay_seq int` (único por proyecto; null hasta el cobro), `paid_at`, `paid_by`, `pay_method text check in ('cash','bizum')`, `total_cents int` (al cobrar), `delivered_at`, `delivered_by`, `delivery_ident text check in ('number','qr','presence','skipped')`, `delivery_exception bool`, `notes text` | `project_id`, `origin`, `notes` | editor, owner |
| `flow.order_lines` | Líneas del pedido | `order_id` FK, `product_id` FK, `quantity int check > 0`, `unit_price_cents int` (copia al cobrar, §4 «snapshot»), `position int`, `delivery_checked bool` | `order_id`, `product_id`, `quantity`, `position`, `delivery_checked` | editor, owner (con el pedido cobrado, solo `delivery_checked`: §4) |
| `flow.payments` | Cobros y su historia (§4.6): nunca se borran ni se reescriben | `order_id` FK, `kind text check in ('charge','reversal','adjustment')`, `method text check in ('cash','bizum')`, `amount_cents int` (con signo), `note text` | — (solo procedimientos) | — |
| `flow.units` | Unidad de trabajo: un montadito o una tarea de logística (§5, §7) | `project_id` FK, `column_key text`, `kind text check in ('prep','task')`, `order_id` FK null, `line_id` FK null, `product_id` FK null, `idx int` (orden dentro del pedido), `pay_seq int` (copia del pedido, para ordenar), `label text` (tareas), `priority bool`, `status text check in ('pending','in_progress','done','cancelled')`, `assigned_to uuid`, `done_at`, `done_by` | al crear una tarea: `project_id`, `column_key`, `kind` (`task`), `label`, `priority`; después, ninguna (solo procedimientos) | editor, owner |
| `flow.events` | Rastro de lo importante (§10.3): cobro, reversión, ajuste, paso atrás de una unidad, entrega con excepción, reapertura | `project_id` FK, `kind text`, `order_id` null, `unit_id` null, `data jsonb`, `actor uuid`, `at timestamptz` | — (solo procedimientos) | — |

- Lectura: `reader`, `editor` y `owner` en todas. Todas son `never_purge`, porque en ellas está el dinero y su rastro, salvo `projects`, que también es la tabla de muestra de la conformidad completa (contrato §9). Purgar un proyecto que tiene pedidos lo impiden sus FK.
- **Guarda (trigger `flow.guard`):** las columnas de estado, número de cobro, precio cerrado y entrega, y las tablas `payments` y `events`, solo las escriben los procedimientos. Estos ponen y quitan la marca de transacción `flow.proc`; desde el cliente, `PROCEDURE_ONLY`. Con el pedido cobrado, una línea solo admite `delivery_checked` (`ORDER_NOT_OPEN`). Un pedido con cobros no se borra.
- Índices: `units (project_id, column_key, pay_seq, idx)`, `units (order_id)`, `order_lines (order_id)`, `payments (order_id)`, `events (project_id, at)` y `orders (project_id, pay_seq)`.
- **Orden estable** (§5, §10.3). En Preparación, `pay_seq` y luego `idx`. En Pedido y cobro y en Servicio, los cobrados por `pay_seq` y los abiertos por `created_at` (en Pedido y cobro van arriba los abiertos y abajo, en gris, los cobrados). En Logística, `created_at`. Nunca se ordena por estado, por `updated_at` ni por persona.
- Los cambios de precio y de disponibilidad (§8.3) quedan en `core.changes` con `before`, `after` y autor. Una venta cerrada no cambia porque su línea guarda `unit_price_cents`.
- Sin códigos humanos (`core.next_code`): el **número del pedido** que se dice en barra es `pay_seq`.

## 3. Procedimientos (`call`)

Todos en `core.allowed_procedures('flow', …)`. Escriben siempre con `core.apply_row_op` y dejan su evento en `flow.events`. Son atómicos porque `core.commit` serializa los commits de la app (`app_state for update`, contrato §4.3). El reintento con el mismo `requestId` devuelve el recibo (§15.9).

| Procedimiento | `args` | Qué hace | Errores |
|---|---|---|---|
| `flow.confirm_payment` | `order_id`, `method`, `expected_revision` | Exige `status = 'open'` y al menos una línea. Copia `unit_price_cents` del catálogo vigente, calcula `total_cents`, asigna `pay_seq = max + 1` del proyecto, inserta el `charge`, crea **una unidad por montadito** (`prepared`) con `idx` correlativo y pasa el pedido a `paid` | `ORDER_NOT_OPEN`, `ORDER_EMPTY`, `PRODUCT_INACTIVE` (sin cobrar) y `VERSION_CONFLICT` |
| `flow.adjust_paid_order` | `order_id`, `lines: [{line_id?, product_id, quantity}]`, `method`, `expected_revision` | Corrige un pedido cobrado (§4.5). Solo toca las líneas que cambian: si una línea sube, añade unidades al final con `idx` nuevo; si baja, cancela unidades de **esa** línea: primero las pendientes, luego las que están en curso y por último las terminadas. El evento `units_cancelled` dice cuáles, en qué estado estaban y quién las tenía o las había hecho. Las líneas nuevas toman el precio vigente. Inserta un `adjustment` por la diferencia. **No regenera unidades** (§10.3, §16) | `ORDER_NOT_PAID` |
| `flow.reverse_payment` | `order_id`, `reason`, `expected_revision` | Anula un cobro (§4.6): inserta un `reversal` por lo cobrado, cancela las unidades no terminadas (las terminadas se conservan) y deja el pedido en `open` **sin** `pay_seq`. El número anterior queda en el evento y en las unidades canceladas. Si se cobra otra vez, `confirm_payment` le da un **número nuevo** y va al final de la cola, porque es otra confirmación de pago. Nunca borra el `charge` | `ORDER_NOT_PAID` y `FORBIDDEN` (ver §5) |
| `flow.unit_step` | `unit_id`, `from` | Toque en una unidad (§5) o en una tarea (§7). Recorre `pending → in_progress` (siempre asignada a quien toca) `→ done` (la puede cerrar otra persona, que queda como `done_by`) `→ pending` (corrección, cualquier editor). El último paso es una **reversión** y deja evento. Si el estado ya no es `from`, falla sin cambiar nada: **solo gana un toque** (§15.12) | `UNIT_CHANGED` (con el estado actual y quién la tiene) y `UNIT_CANCELLED` |
| `flow.deliver_order` | `order_id`, `ident`, `confirm_exception`, `expected_revision` | Entrega (§6). Si faltan unidades sin terminar o líneas sin check, exige `confirm_exception = true` y registra la excepción. Con `ident = 'skipped'`, también deja evento (§15.19) | `DELIVERY_NEEDS_CONFIRMATION` (con lo que falta) y `ORDER_NOT_PAID` |
| `flow.reopen_order` | `order_id`, `reason`, `expected_revision` | Vuelve un pedido entregado a `paid`, con evento. **No toca el dinero** (§15.20) | `ORDER_NOT_DELIVERED` |

Validación en la base (`validate_hooks`) y en `beforeCommit`:

- Una línea de un pedido que no esté `open` solo admite `delivery_checked`.
- El cliente solo inserta unidades `kind = 'task'`, `status = 'pending'` y `column_key = 'logistics'`.
- El catálogo exige que `(scope, code)` sea único entre los productos vivos.

## 4. Hooks de validación

Además de lo anterior, `_domain/flow/validate.ts` comparte con el frontend el cálculo del total y los rótulos de estado y de código. El servidor recalcula siempre el total al cobrar; el del cliente solo se muestra.

## 5. Visibilidad y roles

Sin ámbitos: todas las personas ven todo el proyecto (§2.1, §9). Se usan los roles del núcleo:

- **editor:** las 6 personas. Atienden caja, preparan, entregan, crean y mueven tareas y corrigen pedidos cobrados.
- **owner:** encargado o Dirección. Edita el catálogo y los precios, y anula cobros.
- **reader:** solo mira.

Pendiente de VG (P-2 en §13): si `adjust_paid_order` con diferencia negativa (devolver dinero) y `reverse_payment` deben exigir owner. Mientras tanto se implementa con owner, y la función `flow.money_back_requires_owner()` permite relajarlo con una migración.

## 6. Rutas propias (`/api/v1/...`)

| Método y ruta | Sesión | Qué hace |
|---|---|---|
| `GET public/menu` | **ninguna** | La carta pública (§3): productos activos del proyecto activo, agrupados por `clasico`, `gourmet` y `barra`, con código, nombre, descripción, precio e imagen si la hay. Va por `core_public_read('flow_menu')` (lectura pública registrada con `core.allow_public_read`). Sin datos de pedidos ni de personas. Cacheable 30 s. Si hay más de un proyecto activo, toma el más reciente (V1 asume uno). La sirve `flow-api` antes de entregar la petición al kit (ver P-1) |

La preparación del pedido público en el nivel mínimo (§3.2) no escribe nada: la cesta vive en el navegador del cliente y se enseña en barra. El nivel «siguiente» (cesta con QR que caja recupera) queda para después del cobro.

## 7. Proyecciones y enlaces

Ninguna en V1. Más adelante, las de §11.4, como lecturas registradas.

## 8. Archivos

Sin bucket en V1. Las **imágenes** son una decisión de VG que lleva Core: 4 guías internas, la carta general y las miniaturas de producto. Mientras no esté decidida, la carta usa medallones con el código (`renderMedal` del kit) y «Ver carta solo» se pinta **a partir del catálogo**, no de una imagen. Así los precios siempre coinciden (§8.3).

## 9. Pantallas y navegación

App de personal con la cáscara común del kit y 5 pestañas: **Inicio** (solo el icono de la casa: carrusel de las 4 guías, cuando haya imágenes), **Pedido y cobro**, **Preparación**, **Servicio y entrega** y **Logística**, con badges de pendientes. Cada columna es una lista vertical estable. Lo terminado se queda en su sitio, gris, tachado y más bajo.

- Pedido y cobro y Servicio y entrega: un toque abre la ficha (`openSheet`) y las acciones son explícitas.
- Preparación y Logística: toques sucesivos (`renderTile`).
- Vista pública sin sesión en `/carta`: tres bloques, tarjetas con `− n +`, total fijo y «Ver carta solo».

## 10. Offline

El espejo local guarda las 9 tablas. Lo que toca dinero o entrega (`confirm_payment`, `adjust_paid_order`, `reverse_payment` y `deliver_order`) **exige red**: sin conexión, el botón lo dice y no hace nada. Los toques de unidades y tareas sí se encolan, pero la tarjeta se ve **pendiente de confirmar** hasta que responde el servidor (§10.3, §15.24). Si vuelve un `UNIT_CHANGED`, la tarjeta muestra el estado real y quién la tiene.

**Refresco entre móviles** (P-3, aprobado): no hay Realtime en el núcleo. En V1, un pull cada `PULL_INTERVAL_MS` (3 s, en `_domain/flow`) con la app visible, parado en segundo plano, y otro inmediato tras cada commit.

## 11. Aceptación

Criterios §15.1–15.25. Se automatizan:

- **PGlite** (`tests/flow/*.test.ts`): 7, 8 (dos cobros simultáneos, secuencias únicas), 9 (reintento), 10 (cambio de precio), 11 (ajuste que no reinicia otras líneas), 12 (dos toques sobre la misma unidad), 14, 19, 20 y 21.
- **Playwright** (`*.spec.ts`): 1, 3, 4, 5, 6, 14, 15 (repintado sin perder el toque ni el scroll), 17, 18 y 24.
- **A mano en el ensayo del viernes:** 13 y 16 (varios móviles).
- **Del despliegue:** 22, 23 y 25.

## 12. Reparto

Un solo agente (Flow), en tandas:

- **Martes:** migración `0900` (schema, tablas, registro y semilla del §8), lectura pública y carta.
- **Miércoles:** procedimientos, Pedido y cobro, Preparación.
- **Jueves:** Servicio, Logística, ensayo.

Lo mecánico (escenarios de Playwright siguiendo un patrón aprobado) puede ir a subagentes. La migración, los procedimientos y la API, no.

## 13. Preguntas y peticiones

- **P-1 (Core): aprobado.** `flow-api` atiende `public/menu` antes de pasar la petición al kit. Nada genérico en el kit por ahora.
- **P-2 (VG, por Core):** ¿anular un cobro y devolver dinero en un ajuste exigen encargado (owner)? La propuesta es que sí.
- **P-3 (Core): aprobado.** Pull cada 3 s con la app visible.
- **P-4 (VG, por Core):** las imágenes: dónde viven las guías y si hay miniaturas por producto. Ya la lleva Core.
- **P-5: cerrado.** La semilla crea «Barra · Evento de octubre», y el nombre es editable.
