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
| `flow.projects` | Operación colectiva («Barra · Evento de octubre») | `name text not null`, `status text check in ('active','closed')`, `notes text` | `name`, `status`, `notes` | owner |
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
| `flow.confirm_payment` | `order_id`, `method`, `expected_revision` | Exige `status = 'open'` y al menos una línea. Copia `unit_price_cents` del catálogo vigente, calcula `total_cents`, asigna `pay_seq` = el mayor `paySeq` de los eventos `paid` del proyecto + 1 (los eventos no se borran: un número anulado no se reutiliza), inserta el `charge`, crea **una unidad por montadito** (`prepared`) con `idx` correlativo y pasa el pedido a `paid` | `ORDER_NOT_OPEN`, `ORDER_EMPTY`, `PRODUCT_INACTIVE` (sin cobrar) y `VERSION_CONFLICT` |
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
- **P-2: decidido por VG.** Anular un cobro o devolver dinero lo puede hacer el owner o quien hizo ese cobro (`paid_by`). Al resto, `FORBIDDEN` («Solo quien cobró o el encargado»). Va en la 0901.
- **P-3 (Core): aprobado.** Pull cada 3 s con la app visible.
- **P-4: decidido por VG.** Las 4 guías, la carta general y el logo van en `apps/flow/public`, en webp de 1600 px como máximo. Miniaturas por producto solo si el recorte queda limpio; si no, medallón con el código. Sin bucket. **No hay QR personal de acceso**: basta el login del kit.
- **P-5: cerrado.** La semilla crea «Barra · Evento de octubre», y el nombre es editable.

## 14. FLOW-DIR-001 (precisiones de VG del 26-10): cambios de modelo, migración `0901`

La `0900` queda tal cual: se publica con #707 y luego es inmutable. Lo siguiente va en la `0901_flow_customers`.

**Rutas (§8):** `flow.ikisai.com/` abre la **carta pública**, sin login. El área de personal va en **`/equipo`**, con el login del kit, el menú común y la PWA (`start_url` y `scope` en `/equipo/`).

**Tablas nuevas o cambiadas:**

| Tabla | Cambio |
|---|---|
| `flow.customers` (nueva) | Cliente anónimo del servicio (§1). Columnas: `project_id` FK, `number int` (único por proyecto; lo asigna el servidor al primer envío, correlativo desde 100 y sin reutilizarse), `token_hash text unique` (SHA-256 de un token aleatorio de 32 bytes que **solo vive en el navegador** del cliente; nunca se guarda el token). Lectura: personal. Escritura: solo los procedimientos públicos. `never_purge`. |
| `flow.orders` | `customer_id uuid null` FK a `customers`: el pedido enviado desde la carta, o el de caja si se asocia a un número. `parent_id uuid null` FK a `orders`: una **ampliación** (§3). |
| `flow.order_lines` | `delivered_qty int not null default 0 check (0 ≤ delivered_qty ≤ quantity)`: cantidad realmente entregada («1 de 3 aguas», §2). Sustituye a `delivery_checked`, que se elimina. El cliente la escribe también con el pedido cobrado; su historia queda en `core.changes`. |
| `flow.payments` | `kind` pasa a admitir `refund` (sustituye a `adjustment` con importe negativo). Columnas nuevas: `settled_at`, `settled_by`. Una devolución nace **pendiente** (`settled_at null`) y se cierra con `confirm_refund` cuando el dinero se ha devuelto de verdad (§3). Un `charge` positivo de ampliación es un pedido aparte con su propio `charge`. |

**Procedimientos:**

- `confirm_payment`: sin cambios. Cobrar una **ampliación** (un pedido con `parent_id`) le da su propio `pay_seq`, al final de la cola, y genera sus unidades en ese momento. La secuencia del pedido original nunca se recalcula.
- `create_extension` (nuevo): `{parent_order_id, lines}` crea la ampliación abierta, ligada al padre y a su cliente. Hasta que se cobra no genera unidades.
- `adjust_paid_order`: **solo reduce**. Primero cancela unidades pendientes. Si tiene que tocar unidades en curso o terminadas, falla con `REDUCTION_NEEDS_CONFIRMATION` y el detalle de lo afectado, salvo que llegue `confirm_started: true`. La diferencia crea un `refund` pendiente. Lo puede hacer el owner o quien cobró (P-2).
- `confirm_refund` (nuevo): `{payment_id}` cierra una devolución pendiente (`settled_at` y `settled_by`). Owner o quien cobró.
- `reverse_payment`: owner o quien cobró (P-2).
- `deliver_order`: lo pendiente es ahora «unidades sin terminar + líneas con `delivered_qty < quantity`». Mientras quede algo, el pedido sigue `paid`; cerrarlo con algo pendiente exige `confirm_exception`, como antes.
- **Escritura pública** (contrato de Core, migración core 0094): no son procedimientos. `flow-api` manda operaciones de fila con `applyPublicOperations` (actor «Flow (sistema)», lote público). La guarda solo deja, dentro de un lote público (`core.is_public_batch()`), crear el cliente (el número lo pone el trigger), crear su pedido `open`/`public` e insertar o cambiar líneas de un pedido público abierto.
- **Rutas públicas de `flow-api`** (antes del kit, `no-store` salvo la carta):
  - `GET public/menu`: la carta, con `imageKey` por producto.
  - `POST public/customer`: genera el token (32 bytes), guarda solo su SHA-256 y devuelve `{token, number}`.
  - `POST public/orders`: recibe `{lines: [{productId, quantity}]}` (50 como máximo) con la cabecera `X-Flow-Customer`, crea el pedido del cliente y devuelve `{orderId, number}`.
  - `GET public/mine`: con la cabecera, `flow_mine` (`core.allow_public_read`) devuelve solo los pedidos de ese cliente, con «n de m preparados» y la cantidad entregada por línea.
- **Imágenes de producto** (decisión de VG del 26-10): `flow.products.image_key` = `<categoria>/<slug>`. Las rutas se derivan en `_domain/flow` (`productAssets`) a `apps/flow/public/assets/<clave>/{icono.svg, medallon.svg, miniatura.webp, zoom.webp}`. Las genera `apps/flow/scripts/assets.mjs` a partir del `assets_manifest.json` de VG: saneado de SVG igual que Central, miniatura de 40 KB y zoom de 150 KB como máximo. Sin clave, medallón con el código.

**Caja (§1):** busca por número de cliente y muestra sus pedidos por cobrar, en preparación y por entregar. Se cobra el pedido que se elige; nunca otros del mismo cliente automáticamente. La ficha de entrega es un único componente, que se abre desde caja y desde Servicio y vuelve a caja con el contexto (§2).

**Cola (§5–6):** «Ir al siguiente pendiente» solo aparece si el siguiente no está a la vista. Se ven las últimas 10 hechas; las anteriores se despliegan hacia arriba en la misma lista. Cada toque se refleja al momento con «pendiente de confirmar». Solo hay una transición en vuelo por unidad. Un `UNIT_CHANGED` nunca se sobrescribe: la tarjeta muestra el estado real y un aviso localizado.

**Pendiente de Dirección o VG (no bloquea):** la prioridad de las ampliaciones al final de la cola (es la propuesta de Dirección; la implemento así), el detalle de las entregas parciales y la autoría en un puesto compartido (sesión identificada honestamente; nada de usuario común).

## 15. Flujos por evento y acceso por proyecto (navegación de VG del 26-10, migración `0902`)

- **Pantalla inicial de `/equipo`:** la lista de flujos (proyectos), con el más actual arriba: primero los activos, y entre ellos el que está en curso o el más cercano a hoy. Son tarjetas apaisadas con su portada (`renderCover` del kit). Tocar una es entrar: `#/p/<id>`, el Inicio del flujo, con el carrusel de flujos arriba (`createCoverCarousel`; deslizar cambia de flujo) y sus guías. Dentro aparece la barra inferior del shell con sus columnas y badges (`setNav`); fuera no hay barra.
- **`flow.projects`:** `booking_event_id`, `starts_on`, `ends_on` y `cover_image` (ruta de `apps/flow/public`). Las escribe el owner.
- **Acceso:** los ámbitos del núcleo, `core.memberships.scopes = {"projects": [uuid…]}`. El owner (Dirección) ve todo. El editor, el lector y el outsider ven solo sus proyectos: `flow-api` filtra cada fila con el hook `visible` (`_domain/flow/scope.ts`). La base aplica la misma regla al escribir: el trigger `flow_scope` por `updated_by`, y `flow.check_scope` en los procedimientos (`PROJECT_OUT_OF_SCOPE`). Todas las tablas llevan `project_id`; en líneas, pagos y componentes lo pone el servidor desde su padre.
- **Modo pruebas** (`flow.projects.test_mode`, VG 26-10): lo cambia el owner en el Inicio del flujo. Se cobra y se cuenta igual, pero el Cierre del día no envía ingresos a Finance (el botón lo dice). Food y la proyección para Booking sí se envían. Nada se «desfactura» en Finance.
- **Documentos del flujo** (guías del Inicio): el Inicio lee `projectDocuments(projectId)` (`apps/flow/src/app/documents.ts`). Hoy son las cuatro guías de la barra en el código; después del sábado serán archivos del proyecto (core.files, bucket de Flow), cambiando solo esa función.
- **Outsiders** (declarado para cuando VG los use; el sábado todos entran como editores): solo `unit_step` (`core.allow_outsider_procedure`) y crear o retocar tareas de Logística. Nada de cobros, ajustes, entregas ni catálogo.

## 16. Cómo se define un flujo nuevo (hoy)

Flow va a ser un generador de flujos (después del sábado, el siguiente es check-in/check-out de un evento). Sin editor todavía, esto es lo que ya es **dato** y lo que aún es **código**:

| Pieza | Hoy | Dónde |
|---|---|---|
| Proyecto (nombre, fechas, evento, portada, estado) | Dato | `flow.projects` |
| Columnas: clave, rótulo, orden y comportamiento (`inspect_confirm`, `quick_steps`, `free_task`) | Dato | `flow.columns` (la barra inferior se construye con ellas) |
| Unidades de trabajo, su estado (pendiente → en curso → hecha → pendiente), asignación y orden estable | Dato y lógica genérica | `flow.units` y `flow.unit_step` |
| Rastro de acciones | Dato | `flow.events` (los tipos de evento de la barra aún están en un `check`) |
| Qué pantalla pinta cada comportamiento | Código, agrupado por comportamiento | `apps/flow/src/ui/prep.ts` (cola con toques: `quick_steps` y `free_task`) y `orders.ts` + fichas (`inspect_confirm`) |
| Qué vista concreta usa cada columna de la barra (Caja, Servicio…) | Código | `COLUMN_VIEWS` en `ui/shell.ts`, por la clave de la columna |
| Comercio de la barra: catálogo, pedidos, líneas, pagos, clientes y sus procedimientos | Código y tablas propias de la barra | `flow.products`, `orders`, `order_lines`, `payments`, `customers` y los procedimientos de cobro y entrega |
| Guías del Inicio | Código (lista por proyecto); serán archivos del proyecto | `app/documents.ts` (`projectDocuments`) |

Para dar de alta un flujo nuevo hoy hay que crear el proyecto y sus columnas (datos). Si sus columnas usan los comportamientos genéricos con unidades sueltas (como Logística), basta con eso más una entrada en `COLUMN_VIEWS`. Lo que necesite lotes propios (como el pedido de la barra) requiere hoy un módulo específico, igual que la barra. Pendiente para el editor: los tipos de evento, las guías y las piezas de tarjeta como dato.

## 17. Integraciones: Food, Booking y Finance (migración `0903`)

- **Reflejo de la carta de Food:** el owner pulsa en Caja «Actualizar carta desde Food». La app lee `food.carta_projection` con la sesión de Flow; Food la abrió con `core.allow_read('flow', …)`. El plan (`_domain/flow/carta-sync.ts`) crea, actualiza por `source_line_id` y retira (`active = false`, nunca borra) los productos, y guarda `projects.food_menu_id`. También refleja `allergens` y `allergens_checked`, que la carta pública enseña («sin confirmar con la etiqueta»). Como es manual, durante el servicio la carta no cambia sola, y lo cobrado conserva su precio.
- **Cierre del día** (owner, en Caja): `flow.close_day` guarda `flow.day_closures.data`, una fila por proyecto y día que se sustituye al repetir. Contiene `orders`, `sales_cents`, `sales_by_method`, `reversals_cents`, `refunds_pending_cents`, `units_by_product`, `peak_hours` y `consumption`. El dinero es el movido ese día; lo vendido, con su precio cerrado; y se cumple `detail + pending = amount`.
- **Envíos** (`flow-api`, con la sesión de la persona y requestId estable por el hash del payload): `POST closures/:id/send/food` llama a `food.record_carta_sales` y `send/finance` a `invoices.record_app_entry` (en modo pruebas devuelve `skipped_test_mode` sin llamar). Si la persona no es miembro de la otra app: 403 `NEEDS_ACCESS` («Pide acceso a…»). El resultado se anota con `flow.mark_closure_sent`.
- **Booking** no recibe nada: lee `flow.booking_service_projection (event_id, day, data, updated_at)`, abierta con `core.allow_read('booking', …)`.
- **Booking** también lee qué flujos vivos tiene cada evento (tarjeta «Listo para Flow», 0922): `flow.booking_event_flows_projection (event_id, project_id, name, template_key, updated_at)`, abierta a `{reader,editor,owner}` de Booking.
- **Límite conocido** (se cierra la semana que viene): si un cobro de un día se anula al día siguiente, ese segundo día va a Finance con importe negativo y detalle vacío. Finance lo acepta porque solo cuadra el detalle cuando no está vacío, pero no ve qué productos se devolvieron.

## 18. Columna «Ingredientes» (migración `0904`)

- **Capa genérica parametrizada:** `columns.config` (`proposal`: estado previo `proposed`; `manual`: se puede crear a mano, y nace confirmada). Las unidades llevan `payload` (`item_key`, `name`, `unit`, `qty`, `to`, `from`, `moves`) y `source_ref` (idempotencia de lo generado). Los toques: propuesta → confirmada → asignada (a quien toca) → hecha → pendiente (corrección). `unit_set_qty` revisa la cantidad en propuesta o confirmada.
- **Existencias:** `flow.buffers` (mesa y nevera por ingrediente: `capacity`, `level` y `threshold_pct`, por defecto 25 %; el nivel solo lo mueven los procedimientos; capacidad y umbral, el owner) y `flow.consumption_rules` (lo que consume cada producto; las escribe solo la generación).
- **Al hacer una unidad** se aplican sus movimientos (los de su `payload` o, si es un producto, su consumo de la mesa) y se guardan en `payload.applied`. Al corregirla se revierten, con evento `stock_moved` o `stock_reverted`. Si un punto baja de su umbral, se propone reponerlo («Reponer X a mesa desde nevera», «… a nevera desde fresco»), al final de la columna, con una sola propuesta abierta por punto y sentido: si ya existe, se actualiza su cantidad.
- **Generación** (owner, botón en la columna): la app lee `food.carta_prep_totals_projection` y `food.carta_prep_projection` con la sesión de Flow, y `flow.generate_ingredient_tasks` crea los puntos, las propuestas «Preparar X para mesa / nevera» (`source_ref` por día, así que repetir no duplica) y las reglas de consumo. Lo no convertible no genera nada y se avisa. Sin la previsión de Food: «Falta la previsión en Food».
- **Cierre del día:** `data.consumption` es el consumo estimado por ingrediente (lo aplicado por los productos hechos ese día), para Food.

## 19. Enlaces con Booking y Tasks (migración `0905`)

- **Evento de Booking** (owner, en el Inicio del flujo): la app lee `booking.event_projection` con la sesión de Flow (Booking la abrió con `core.allow_read`) y guarda `booking_event_id`, `starts_on` y `ends_on`. Una reserva sin confirmar aún no tiene evento y no sale.
- **Proyecto de Tasks** (owner, una vez): `POST tasks/projects` pide a Tasks `read/tasks.targets` con la sesión de la persona y devuelve solo los abiertos (sin `system`, archivados ni borrados). Se guarda en `projects.tasks_project_id`.
- **«Pedir a Tasks»** (editor u owner, desde una tarea de Logística o de Ingredientes): `POST units/:id/tasks {type: 'task' | 'purchase', quantity?, unit?, note?}`. Llama a `requests/task` o `requests/purchase` de Tasks (contrato §39), con `external_ref` = id de la unidad (una vez por tarea) y prioridad `high` si la tarea es prioritaria. El enlace se anota con `flow.unit_link_external` en `payload.external`; a mano no se puede falsear, porque la guarda lo quita. Errores: `NO_TASKS_PROJECT`, `TASKS_PROJECT_GONE` (404 de Tasks: elegir otro), `NEEDS_ACCESS`, `PROJECT_ARCHIVED` y `EXTERNAL_REF_IN_USE`. Estado: `POST tasks/status {ids}` (Tasks no avisa).

## 20. Versiones de flujo (migración `0906`, decisión de VG del 27-10)

- **Plantilla y versión:** `projects.template_key` («barra», «checkin»…), `template_version`, `frozen` y `serves_public`. La barra del sábado es **«Barra · v1», congelada**: su configuración (columnas, `config`, comportamientos) no cambia, ni siquiera por el owner ni desde un procedimiento (`FLOW_FROZEN`), y `tests/flow` es su regresión fija. Sus datos de servicio sí siguen: pedidos, catálogo desde Food, tareas, nombre, modo pruebas y enlaces.
- **«Nueva versión del flujo»** (owner, `flow.new_version`): crea la siguiente versión de la misma plantilla. Copia columnas y `config`, catálogo con componentes, reglas de consumo, puntos de existencias vacíos, evento, carta de Food, proyecto de Tasks y portada. Nunca copia pedidos, clientes, pagos, unidades ni cierres. Nace en **modo pruebas**, ligada al mismo evento y **sin atender la carta pública**. El acceso del personal a la versión nueva se da en Central (ámbitos).
- **Carta pública:** la atiende el proyecto con `serves_public` (uno como mucho, por índice único), no «el más reciente». Se cambia en el Inicio del flujo (owner): se quita del que la tenía y se pone en el nuevo en el mismo lote.
- **Regla para lo que viene** (documentos subidos, «Comprar X» y existencias, cuenta del cliente, check-in, editor): son comportamientos y piezas nuevos que usan las versiones nuevas. El código que usa la v1 solo se amplía; si una mejora toca código compartido, va detrás de un parámetro de `config` que en la v1 queda desactivado.

## 21. Documentos y portada subidos (migración `0907`, paso 1)

- **Archivos del proyecto** en `core.files`, bucket privado `flow-media` (alta de Core): imágenes webp, jpeg y png, y PDF, de 15 MB como máximo. `flow-api` declara las subidas (`FLOW_UPLOADS`) y, como Central, comprueba en `beforeCommit` que un archivo referenciado es de Flow, está verificado y tiene el tipo de su columna (`INVALID_FILE`).
- **`flow.project_documents`** (`file_id`, `title`, `mime`, `position`; solo el owner escribe) son las guías del Inicio, en su orden. **`projects.cover_file_id`** es la portada (solo imagen). Los dos se declaran con `core.register_file_field(…, 'permanent')`.
- **Inicio del flujo** (owner): «Gestionar documentos» (subir, subir o bajar en el orden, quitar), «Cargar las guías de la barra» (la primera vez, sube las cuatro del código como documentos) y «Cambiar portada». Un PDF se abre aparte. Las URL son firmadas (10 min) y la app las guarda 8 min.
- **v1 congelada:** mientras no tenga documentos propios, sigue enseñando las guías del código. Documentos y portada son datos, no configuración, así que también se pueden cambiar en la v1.
- **«Nueva versión»** copia los documentos (los mismos archivos, sin duplicarlos) y la portada.
- **Para Central:** `flow.projects_projection` (id, name, status, starts_on, ends_on, test_mode, booking_event_id), abierta con `core.allow_read('central', …, '{owner}')` para dar accesos por proyecto.

## 22. Comportamiento «station» (puesto) y métricas (migración `0908`, paso 2)

- **Puesto:** unidad `kind = 'station'` que no se termina: un toque la ocupa (`assigned_to` = quien toca) y otro la suelta. Lo hace `unit_step`, que solo cambia para esta clase de unidad; el resto de unidades sigue igual.
- **Métrica en vivo**, calculada en el servidor: `flow.station_metrics({project_id})` (lectura registrada, con el ámbito comprobado) devuelve `{unit_id, metric, value}` para cada puesto. Las métricas son enchufables: una función `flow.metric_<clave>(project uuid, params jsonb)` por clave. La app la vuelve a pedir con cada cambio de datos y cada 20 s.
- **`bread_ahead`:** unidades de preparación de los pedidos cobrados en los últimos `lookback_min` minutos (5), como mucho `per_order_cap` por pedido (4). `rate` = unidades / ventana; `expected` = `rate` × (`warmup_min` + `lead_min`) (1 + 1); descuento por tramos según `rate` (`tiers`: hasta 2, −60 %; hasta 8, −30 %; resto, 0 %); `target` = `floor(expected × (1 − pct/100))`. Salida: `{target, rate, window, units, pct}`.
- **Textos y parámetros en la unidad** (`payload`: `metric`, `params`, `text`, `notice`, `notice_in`). El código del comportamiento no nombra productos. El owner cambia los parámetros numéricos desde la tarjeta (`flow.station_set_params`).
- **Plantilla:** `flow.template_units` (`template_key`, `min_version`, `column_key`, `kind`, `label`, `payload`). «Nueva versión» añade las que tocan a su versión. La barra desde la v2 lleva el puesto «Pan» en Logística, con «Ahora deben estar calentándose N panes · r montaditos/min» y el aviso «Pan: N calentándose» en la cabecera de Preparación. La v1 no cambia.

## 23. Gasto real y aviso de compra (migración `0909`, paso 3)

- **`flow.template_column_patches`** (`template_key`, `min_version`, `column_key`, `config_patch`): «Nueva versión» los aplica a las columnas. La barra desde la v2 lleva `fresh_stock: true` en Ingredientes; la v1 no.
- **Punto «fresco»** (con `fresh_stock`): al generar, por ingrediente, con capacidad = lo previsto en fresco por Food; empieza lleno. Reponer la nevera lo descuenta. Si baja de su umbral, se propone **«Comprar X»** (`payload.purchase = true`, al final de la columna, una sola abierta). Su botón de Tasks la pide como compra de un toque (cantidad y unidad de la propuesta). Al hacerla, fresco vuelve a su capacidad.
- La reposición genérica (`propose_restock`) **solo se amplía**: sin punto «fresco» (la v1) hace exactamente lo de antes.
- **Existencias** (`flow.stock_view({project_id})`, con el ámbito comprobado): por ingrediente, mesa, nevera y fresco (nivel y capacidad, en rojo bajo umbral) y lo consumido hoy (hora de Madrid). Se enseña en el Inicio del flujo cuando hay puntos de existencias.

## 24. Cuenta del cliente y huéspedes (migración `0910`, paso 4)

- **Solo v2**: la caja lleva `accounts: true` por plantilla (`template_column_patches`); la v1 no, y sus procedimientos solo se envuelven.
- **`flow.accounts`** (`project_id`, `customer_id?`, `holder`, `status` open|settled, `opened_by`, `settled_at`, `settled_by`, `payment_id`): solo por procedimiento. Un cliente tiene como mucho una cuenta abierta.
- **`open_account({project_id, holder?, customer_number?, account_id?})`**: a nombre de alguien o de un número de cliente (sin nombre, el corto del cliente o «Cliente N»). `ACCOUNT_ALREADY_OPEN`, `ACCOUNTS_DISABLED`.
- **`charge_to_account({order_id, account_id, expected_revision})`**: como `confirm_payment` (precio cerrado, número de cobro de la misma secuencia —evento `paid` con `method: 'account'`— y unidades), sin dinero: `pay_method = 'account'`, `account_id`.
- **`settle_account({account_id, method: cash|bizum|card, expected_revision?})`**: owner o quien la abrió (`SETTLE_FORBIDDEN`). Un pago `charge` único de la cuenta (`order_id` null, `account_id`) por la suma de sus pedidos vivos; sin pedidos, sin pago.
- Pedidos a cuenta: con la cuenta abierta, `adjust_paid_order` y `reverse_payment` fallan con `ACCOUNT_OPEN`; liquidada, se corrigen (devolución como siempre) pero no se anulan (`ACCOUNT_SETTLED`).
- **Resumen del día** (Food/Finance): lo cargado a cuenta se vende el día en que se liquida; el pago de la cuenta entra en el dinero de ese día; `sales_by_method.card` solo si hay tarjeta (Finance la recibe en `methods.card`). Con la v1, idéntico.
- **Huéspedes** (decisión (c) de Core): `assign_guest_numbers({project_id, guests: [{guest_id, display_name}]})` (owner, idempotente) crea clientes `origin = 'guest'` con un token al azar; la app lo lanza desde el Inicio leyendo `booking.flow_guests_projection` del evento.
- **`flow.portal_customer({reservation_id, guest_id})`** (lectura de Guests, `core.portal_in_scope`): `{number, carta_url, account_open}`. `carta_url = https://flow.ikisai.com/?invitacion=<cliente>.<caducidad>.<firma>` (10 min) solo si hay clave y su flujo atiende la carta; si no, `null`.
- **Firma**: HMAC-SHA256 (`flow.hmac_sha256_hex`, RFC 2104 con `sha256()` de Postgres, sin pgcrypto) sobre `<cliente>.<caducidad>` con `flow.portal_key()`: el secreto `flow_portal_key` del Vault; en pruebas, el ajuste de sesión `flow.portal_key`; sin ninguno, `null`. `portal_key()` no se concede a anon ni authenticated.
- **Canje** `POST public/invitation {invitation}` → `{token, number}`: valida (`flow_guest_link`), y el lote público rota el `token_hash` de ese cliente de huésped (el navegador anterior deja de valer). `404 INVITATION_INVALID`, `410 INVITATION_EXPIRED`. El lote público solo crea clientes `web` y de un cliente `guest` solo cambia el token.
## 25. Check-in del evento (migración `0911`, paso 5)

- **Comportamiento `guest_presence`** (`config.stage`: `arrival` | `bed` | `signature` | `departure`). Las columnas Llegada → Cama → Firma → Salida enseñan los huéspedes del evento ligado. Los datos salen de `booking.flow_guests_of({event_id})` (Booking 0486): nombre corto, cama, noches, llegada, salida y firma. Booking solo responde si el evento está en el ámbito de la persona en Flow (resolutor `flow.in_scope`, 0916). La app la lee por `GET checkin/:project/guests` cada 10 s con la pantalla visible. flow-api comprueba el ámbito del flujo y filtra por su evento, así que nadie ve los huéspedes de un evento que no es de sus flujos.
- **Plantillas**: `flow.template_columns` (`template_key`, `version`, `label_base`, `key`, `label`, `behavior`, `config`, `position`) y `create_flow({template_key, project_id, name?, booking_event_id?, starts_on?, ends_on?})`, solo owner y desde la última versión de la plantilla. Ya existe la plantilla `checkin` v1. El editor de flujos (paso 6) las ampliará.
- **Llegada y Salida**: `POST checkin/:project/guests/:guest/arrive|leave {undo?}`.
  - flow-api comprueba tres cosas: rol editor u owner, que el flujo esté en el ámbito de la persona (`flow.checkin_target`) y que el huésped sea del evento del flujo.
  - Luego llama a `booking.guest_arrive` / `booking.guest_leave` por booking-api con el token de la persona.
  - Los errores de Booking llegan tal cual: `SES_ALREADY_REGISTERED`, `GUEST_ALREADY_LEFT`, `TEAM_GUEST`. Sin acceso a Booking, `NEEDS_ACCESS`. Sin evento ligado, `NO_BOOKING_EVENT`.
- **Cama** («en su cama»): marca de Flow `flow.presence_marks`, solo por procedimiento: `mark_presence({project_id, guest_id, step: 'bed', undo?})`.
- **Firma**: solo avisa. El parte se firma en Huéspedes y la tarjeta pasa sola a hecha.
- La barra no cambia.

## 26. Cocina sin tocar el móvil y resolutor de ámbito (migración `0912`, «B»)

- **`complete_on_delivery`** en la config de Servicio. Lo lleva la v2 por plantilla. La 0912 aplica además todos los ajustes de plantilla a las versiones ya creadas y no congeladas, sin pisar lo que tengan.
- **`deliver_all({order_id, ident, expected_revision?})`**: termina las unidades de preparación que queden y entrega el pedido sin excepción.
  - Las unidades pasan por `unit_step` (pendiente → en curso → hecho), con su consumo de ingredientes y a nombre de quien entrega.
  - Las líneas quedan entregadas en su totalidad.
  - Sin la config, `INVALID_OPERATION`: la v1 entrega con `deliver_order` como siempre.
- **App**: en la ficha de entrega de la v2, con algo en cocina, aparece «Dar por hecho y entregar». En Servicio, esas tarjetas dicen «En cocina x/y». En Preparación, lo terminado desde entrega desaparece solo.
- **Resolutor de ámbito**: `flow.in_scope(actor, kind, id)`, registrado con `core.allow_scope_resolver`. Con `kind = 'booking_event'`, es verdadero si la persona tiene en su ámbito algún flujo de ese evento. Booking lo usa en `booking.flow_guests_of`.

## 27. Pan v2 (migración `0913`)

- **Métrica `bread_v2`** del puesto «Pan». Desde la 0913 la lleva la v2 por plantilla, y también el «Pan» de las versiones ya creadas y no congeladas, conservando sus parámetros. `bread_ahead` (0908) no cambia.
- **Firme**: montaditos cobrados con su unidad aún sin hacer (pendiente o en curso), multiplicados por `bread_per_unit` (1 por defecto).
- **Prevista**: ritmo × (`warmup_min` + `lead_min`), con el descuento de los tramos (`tiers`, por ritmo) aplicado solo a la prevista.
  - El ritmo son las unidades de los pedidos cobrados en `lookback_min` (5), con un máximo de `per_order_cap` (4) por pedido.
  - Se suaviza con la ventana larga `smooth_min` (15) y el peso `smooth_weight` (0,3). Sin suavizado, 7 en 5 min = 1,4/min.
- **target** = mín(`machine_capacity`, firme + ⌊prevista⌋). Devuelve `target`, `firm`, `forecast`, `rate`, `pct`, `units`, `window`, `machine_capacity` y `hysteresis`. Sin conteo manual.
- **Histéresis** (`hysteresis`, 2 panes): la app (`steadyMetrics`) solo cambia la cifra mostrada si se mueve al menos eso, o si quedaría por debajo de lo firme.
- El owner cambia los parámetros desde la tarjeta del puesto, como en la 0908.

## 28. Editor de flujos (migración `0914`)

- **Piezas**: cada columna es una pieza conocida, con comportamiento y config base fijos (`flow.piece_behavior`, `flow.piece_config`; en el dominio, `PIECES`). Opciones booleanas por pieza:

  | Pieza | Comportamiento | Opción |
  |---|---|---|
  | `order` | `inspect_confirm` | `accounts` |
  | `prep` | `quick_steps` | — |
  | `ingredients` | `quick_steps` | `fresh_stock` |
  | `service` | `inspect_confirm` | `complete_on_delivery` |
  | `logistics` | `free_task` | — |
  | `arrival`, `bed`, `signature`, `departure` | `guest_presence` | — |

  Cada pieza va una sola vez por flujo, con un máximo de 12. Las vistas son las de siempre.
- **`create_flow({project_id, template_key?, columns?: [{key, label?, options?}], name?, booking_event_id?, starts_on?, ends_on?})`**, solo owner. Sustituye al de la 0911.
  - Se crea desde una plantilla, desde columnas o con ambas; si se dan columnas, mandan ellas.
  - La versión es la siguiente de esa plantilla en ese evento.
  - Desde plantilla, se aplican los ajustes de plantilla que le toquen.
- **`save_template({project_id, template_key, label_base})`**, solo owner: guarda las columnas del flujo como versión nueva de la plantilla. Se siembra la plantilla `barra` v1 con las columnas de «Barra · v1»; `checkin` v1 ya existía. Así la barra y el check-in se reconstruyen desde el editor.
- **App** (solo owner):
  - «Nuevo flujo» (`#/nuevo`): se elige una plantilla o en blanco, el nombre y el evento de Booking.
  - «Columnas del flujo» (`#/p/<id>/editor`): nombres, orden, opciones, añadir o quitar piezas y «Guardar como plantilla». Editar es escritura normal del owner sobre `flow.columns`; la v1 congelada no cambia (`FLOW_FROZEN`).
  - La portada y los documentos se ponen en el Inicio del flujo, como hasta ahora.

## 29. Visitantes por QR (migración `0915`, FL2)

- **`flow.customers.visitor_id`** (origen `visitor`): un cliente por visitante y flujo. El flujo es el del evento de Booking, por su `event_code`, que atiende la carta pública.
- **`POST public/visitor_join {event_code}`**: ruta pública del kit, con `X-Visitor` obligatorio.
  - Crea o encuentra su cliente, por el lote público firmado por el visitante, y devuelve «Mi pedido».
  - Errores: `401 VISITOR_REQUIRED` y `404 NO_FLOW`.
- **`flow_visitor_customer({event_code})`**: lectura pública expuesta al navegador, con el `visitor_id` que pone el kit (el del cliente se descarta).
  - Devuelve `{number, carta_url, account_open, orders: [{number, status, summary, preparing}]}`.
  - Sin visitante, o si aún no se ha unido: `number` null y sin pedidos.
- **Enlaces a la carta, de huésped y de visitante**: `<cliente>.<caducidad>.<revisión>.<firma>`.
  - El canje rota el token y sube la revisión: son de un solo uso (`410 INVITATION_USED`) y caducan a los 10 min.
  - Los enlaces de huésped de tres partes (0910) valen hasta caducar.
- **Guarda del lote público**: un cliente nuevo es `web`, o `visitor` con el visitante del propio lote (`core.current_visitor()`). De un cliente de huésped o de visitante solo cambia el token.
- «Soy el 142» sigue funcionando sin visitante.

## 30. Caja profunda (migración `0917`, «C»)

- **Interruptor**: config de Caja `deep_checkout`. La v2 la lleva por plantilla, y también las versiones de barra ya creadas y no congeladas. La v1 cobra como siempre.
- **`pay_orders({order_ids, method, unify, revisions?})`**: paga varios pedidos abiertos del mismo flujo.
  - Métodos: `cash`, `bizum`, `card`, `btc_ln` y `btc_chain`.
  - Cada pedido se cobra con su número de cobro y sus unidades (`flow.charge_order`).
  - Con `unify`, un justificante para todos; sin él, uno por pedido. Sin la config, `INVALID_OPERATION`.
- **`flow.receipts`** (`method`, `total_cents`, `order_ids`, `customer_id`, `finance_status`…) y `payments.receipt_id`. Solo por procedimiento. El estado del envío (`finance_status`) lo anota flow-api con la respuesta de Finance, por el lote público del servidor, que el navegador no puede usar. La guarda solo deja cambiar ahí los campos de envío. Así nadie marca como enviado un cobro que no ha ido.
- **«Enviar a Finance»**: `POST receipts/:id/send/finance` → `invoices.record_app_entry` con `nature: 'fiscal'`, `source_ref flow:receipt:<id>` y el detalle de sus líneas. Bitcoin va como método `bitcoin`.
- **Cierre del día**: va siempre a Finance como `nature: 'process'` (VG 27-10). Excluye lo ya enviado como fiscal (`flow.fiscal_of_day`): importe, métodos y detalle. Un cobro va en un solo apunte. Lo cobrado en Bitcoin que no ha ido como fiscal sale como método `bitcoin`.
- **`flow.project_settings`** (`lightning_address`, `bitcoin_address`): escribe solo el owner, desde «Cobro con Bitcoin» en el Inicio; leen editor y owner. Las direcciones nunca van en el repo.
- **App**:
  - En Caja, «Ficha del cliente» al buscar su número: todos sus pedidos con casillas, «Pagar (n)» y «Entregar (n)».
  - En la ficha de un pedido abierto, «Pagar».
  - La pantalla de pago enseña el total en grande y desglosado, con Metálico, Bizum, Tarjeta (deshabilitada) y Bitcoin. Bitcoin muestra un QR `lightning:<dirección>` o `bitcoin:<dirección>` con `renderQr` del kit; sin conversión EUR→BTC.
  - Tras pagar: Enviar a Finance; después, Imprimir ticket abre el justificante de Finance (`https://finance.ikisai.com/#/justificante?ref=flow:receipt:<id>`, Finance #817). Enviar por correo aún no tiene función. Cerrar. Es un ticket de venta: la factura solo la genera Finance.

## 31. Recipientes y rendimiento (migración `0918`)

- **`flow.buffers`** suma `containers`, `per_container`, `prep_unit`, `purchase_unit` y `yield`.
- **`set_buffer_containers({buffer_id, containers, per_container})`**, solo owner y solo en mesa o nevera de un flujo no congelado: «3 recipientes × 8 rodajas».
  - La capacidad sale de ahí (`containers × per_container`) y regenerar no la pisa.
  - Con los dos valores null se quitan los recipientes.
  - En la app, «Recipientes» junto a Existencias, en el Inicio.
- **Generar**: guarda el rendimiento de Food (#774: `prep_unit`, `purchase_unit`, `yield`) en los puntos del ingrediente. La app pasa también `fresco`: antes no lo pasaba y en uso real el punto «fresco» de la 0909 no se creaba.
- **Reposición**:
  - Con recipientes: «Reponer mesa: 3 recipientes de Tomate (20 rodaja ≈ 2.5 unidad)», con `payload.containers`.
  - «Comprar X» con rendimiento: `ceil(necesario ÷ yield)` en `purchase_unit` («Comprar Tomate · 1 unidad»), con `payload.purchase_qty` y `purchase_unit`. Así se pide a Tasks.
  - Sin recipientes ni rendimiento, como antes.

## 32. Recorridos (migración `0919`)

- **Modelo**: `flow.definitions` (key, name), `flow.definition_versions` (version, status draft|published y `capability`, un id del catálogo del núcleo 0097) y `flow.definition_steps`.
  - Cada paso es una pregunta sobre un campo de entrada de la capacidad (`key` = ruta en el `input`: `supplier.name`), con `title`, `explain`, `essential` y `anchor` (data-feedback-id).
  - Sembrado: «Registrar compra» v1 → `register_purchase_quick` de Finance (docs/invoices/API.md §18). Tiene 8 pasos; 5 son esenciales.
- **Ejecuciones** (`flow.executions`: mode learn|run, status draft|practiced|done|discarded|error, values, result):
  - Procedimientos: `start_execution({execution_id, version_id, mode})`, `save_execution_values({execution_id, values})` y `finish_execution({execution_id, status, result?})`.
  - Solo las toca quien las hace (`EXECUTION_FINISHED` cuando ya están cerradas).
  - «practiced» solo en aprender; «done» y «error» solo en ejecutar.
  - Por sincronización solo las lee el owner.
- **Ejecutar**: la app invoca la capacidad con el kit (`POST capabilities/<id>/invoke`). La Edge llama a la API de la app dueña con el token de la persona y deja recibo en el núcleo. `requestId = flow-<ejecución>`, así que es idempotente.
- **Aprender**: hace todas las preguntas con su explicación; «Registrar» no escribe nada fuera.
- **App**: «Recorridos» (`#/recorridos`, editor y owner) con «Aprender» y «Ejecutar». Pregunta a pregunta con `createStepForm`, y al final revisión con Registrar, Corregir y Descartar. Los campos salen del `input` del catálogo.
- **Central**: `flow.journey_steps_projection` (flow_id, flow_name, version, step, app, feature_id = anclaje o capacidad, capability), con `allow_read('central', …, '{owner}')`.

## 33. Carriles (vistas intercambiables del flujo)

- En los flujos no congelados (la v2 y lo que nazca de ella), las columnas van en un tablero `createLanes` del kit (0.61), con dos vistas que se cambian con un conmutador visible:
  - Pestañas: una columna a la vista.
  - Lado a lado: scroll horizontal, y vertical dentro de cada carril. Caben unos dos carriles en un móvil en vertical y de 4 a 6 en un PC.
- La elección se recuerda en el dispositivo (`storageKey: flow-board`).
- Cada carril monta la vista de siempre de su columna, una sola vez y al verse por primera vez.
- El carril principal se refleja en la dirección (`#/p/<flujo>/<columna>`). Tocar otra columna en la barra inferior solo cambia de carril, sin volver a montar.
- La v1 congelada sigue con una columna por pantalla.

## 34. Servicio del sábado: arreglos y capacidades (migración `0920`)

- **`create_flow` desde plantilla**: la versión del flujo nunca queda por debajo de la de la plantilla. Se siembra `barra` v2 (columnas de la v1 con los ajustes de la v2) y se añaden las unidades de plantilla (el puesto «Pan»). Así, «Nuevo flujo» → Barra en un evento nuevo nace como una v2 completa.
- **Capacidades de Flow** en el catálogo del núcleo:
  - `flow.day_summary`: `POST day-summary {project_id, day}`, solo owner y con el ámbito comprobado. Devuelve el resumen del día (`flow.day_summary`).
  - `flow.logistics_task`: `POST logistics-task {requestId, project_id, label, priority?}`, editor u owner. Crea una tarea en Logística. Comprueba el rol (editor u owner) y que el proyecto esté en el ámbito de quien llama (`flow.project_access_read`, 0924; si no, `403 PROJECT_OUT_OF_SCOPE`). El id es aleatorio y es idempotente por persona y `requestId` (recibo del núcleo): repetir devuelve la misma tarea con `replayed: true`.
- **Prueba de extremo a extremo**: `tests/flow/servicio-sabado.test.ts`. Los huecos que encuentra van en `docs/flow/PETICIONES.md` (S1…).

## 35. Número de cobro y ticket hacia Finance (migración `0921`)

- «Enviar a Finance» de un justificante manda `receipt_kind: 'ticket'` (un cobro de la caja es un ticket de venta; la factura solo la hace Finance) y `receipt_number`: los números de cobro de sus pedidos, en orden, unidos con «+» («12» o «12+13»; si pasan de 64 caracteres, «12…41»).
- `flow.receipt_for_send` devuelve ese `receipt_number`.

## 36. Avisos del sábado: nada sale vacío sin decir por qué

- **Caja profunda sin direcciones de Bitcoin**: los dos métodos salen apagados con «pendiente de dirección», y una nota dice dónde se ponen (Inicio → «Cobro con Bitcoin»). Tocar no da error.
- **Generar tareas de ingredientes**: si la previsión de Food sale a cero (carta sin unidades previstas), no se llama a Flow y se explica qué poner en Food. Lo que sale sin cantidad o con aviso enseña la frase de Food (`note`, Food 1115) en una hoja que se cierra con «Entendido», no en un aviso que se va.
- **Pantalla que no se actualiza**: si el pull (cada 3 s) lleva más de un minuto sin volver y no hay otro aviso de red, sale «Esta pantalla no se actualiza desde hace N min» con «Actualizar».
- Prueba: `tests/flow/avisos.spec.ts`.

## 37. Frenos de la carta pública (FL5, migración `0923`)

- En la base de datos, solo en lotes públicos (`flow.guard_public_limits`):
  - clientes: 60 altas por minuto en un flujo;
  - pedidos públicos: 5 abiertos (sin cobrar) por cliente (`429 TOO_MANY_OPEN_ORDERS`), 6 por minuto por cliente y 120 por minuto en un flujo (`429 RATE_LIMITED`).
- En flow-api, por IP (memoria de la instancia, freno de más): 10 altas de cliente cada 10 minutos y 30 pedidos por minuto. La IP la pone el proxy de Pages en `X-Ikisai-Client-Ip` desde `CF-Connecting-IP`.
- Los mensajes de la carta dicen qué hacer («pásate por la barra antes de pedir más»).
- Prueba: `tests/flow/public-limits.test.ts`.

## 38. Identidad de servicio ante Finance y Tasks (FL1, FL2)

- Las llamadas de flow-api a Finance (`invoices-api /api/v1/commands`, `invoices.record_app_entry`: cierre del día y justificantes) y a Tasks (`requests/task`, `requests/purchase`) llevan, además del token de la persona, `X-Ikisai-Worker-Key` (`IKISAI_WORKER_KEY` del entorno de la Edge) y `X-Ikisai-Caller: flow`.
- Con eso, Finance y Tasks reservan `source_app`/`source: 'flow'` a Flow (Finance: `403 SOURCE_MISMATCH` si no coincide).
- A Food y a Booking no se les manda la clave.
