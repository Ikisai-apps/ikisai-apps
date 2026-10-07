# Ikisai Core · Contrato del núcleo de sincronización (v0.1, borrador para aprobación)

Fecha: 5 de octubre de 2026. Autor: agente Core. Alcance: las cuatro apps (`tasks`, `invoices`, `booking`, `food`).

Este documento es normativo para cualquier agente que construya una app sobre el núcleo. Lo que aquí no está permitido no se hace sin una misión coordinada por Core. Las palabras **debe / no debe / puede** se usan en sentido estricto.

---

## 1. Objetivo

Que cualquier app de Ikisai pueda: leer y editar sin red, sincronizar al reconectar sin duplicar ni pisar cambios ajenos, mostrar conflictos de forma explícita, deshacer, y hacerlo con tablas relacionales normales que admitan índices, restricciones y SQL.

No es objetivo: edición simultánea en tiempo real, CRDT, ni fusión semántica automática más allá de campos disjuntos.

---

## 2. Convenciones de datos

### 2.1 Tabla sincronizable

Toda tabla que el cliente pueda leer o escribir vía el núcleo **debe** tener:

```sql
id          uuid primary key default gen_random_uuid(),
revision    bigint not null default 1,
created_at  timestamptz not null default now(),
updated_at  timestamptz not null default now(),
updated_by  uuid null references auth.users(id),
deleted_at  timestamptz null
```

Opcionales recomendados: `code text unique` (código humano), `position numeric` (orden manual), `notes text`.

Reglas:

- `revision` la incrementa el trigger `core.touch_revision()` en cada `UPDATE`. Nadie la escribe a mano.
- El borrado es lógico: `deleted_at`. No hay purga automática. El `DELETE` físico solo ocurre por la acción «Vaciar papelera» del `owner` (implementada en `core.purge_deleted(app, tables[])`) o por `core.purge_row_history` a petición de Core (§11). Las tablas marcadas `never_purge` en `core.synced_tables` (facturas y sus documentos) quedan excluidas.
- Atributos en columnas tipadas. Se admite una columna `extra jsonb` para campos verdaderamente libres; no para evitar una migración.
- Las FK a otras tablas del **mismo schema** son obligatorias donde haya relación. Las FK a `booking.events` desde `food.*` están permitidas (misma base, mismo repo). Entre el resto de schemas, enlaces tipados (§8).
- Las vistas de proyección para otras apps se llaman `<schema>.<destino>_<objeto>_projection` y no exponen datos personales.

### 2.2 Registro de tablas

```sql
core.synced_tables(
  app text, schema_name text, table_name text,
  writable_columns text[],          -- lista blanca para insert/update
  readable_roles text[] default '{reader,editor,owner}',
  writable_roles text[] default '{editor,owner}',
  primary key(app, schema_name, table_name))
```

Una tabla no registrada no se puede leer ni escribir vía el núcleo. La migración que crea la tabla **debe** registrarla.

### 2.3 Códigos humanos

```sql
core.code_sequences(prefix text, year int, last int, primary key(prefix, year))
core.next_code(prefix text, year int) returns text   -- 'RSV_2026_001'
```

Transaccional, sin huecos salvo rollback, sin carreras (bloqueo de fila). Prefijos reservados: `RSV EVT HSP FVR` y los que registre cada app en su `docs/<app>/API.md`.

---

## 3. Tablas del núcleo

```sql
core.apps(id text primary key, name text, domain text)           -- tasks, invoices, booking, food

core.profiles(user_id uuid primary key references auth.users,
  display_name text, kind text check (kind in ('human','agent')),
  revision bigint, created_at, updated_at)

core.memberships(app text references core.apps, user_id uuid references auth.users,
  role text check (role in ('reader','editor','owner')),
  scopes jsonb null,                 -- opaco para core; lo interpreta la app (Tareas: áreas/proyectos)
  revision bigint, created_at, updated_at, primary key(app, user_id))

core.app_state(app text primary key, cursor bigint not null default 0)

core.changes(app text, cursor bigint, seq int,                    -- seq: orden dentro del lote
  committed_at timestamptz, actor_id uuid, request_id text,
  schema_name text, table_name text, row_id uuid,
  op text check (op in ('insert','update','delete','restore','call')),
  revision bigint, before jsonb, after jsonb,
  primary key(app, cursor, seq))

core.receipts(app text, actor_id uuid, request_id text,
  digest text, cursor bigint, result jsonb, created_at timestamptz,
  primary key(app, actor_id, request_id))
```

### 3.1 Agentes de IA (migración `0040`, diseño en `docs/tasks/AGENTES.md`)

- **Identidad:** un agente es un usuario Auth sintético con `profiles.kind = 'agent'` y pertenencias normales (`reader` o `editor`, nunca `owner`). Se autentica con `Authorization: Bearer ika_…` (43 caracteres base64url); `core.agent_keys` guarda solo el sha256. La clave es del agente, no de una app: revocarla lo corta en todas. Sin sesión: `auth/logout` y `auth/password` responden 403.
- **Riesgo:** un lote de un agente exige aprobación si tiene algún `delete`, algún `call` a un procedimiento no marcado seguro (`core.allow_procedure(app, proc, p_agent_confirmation => false)`), toca **10 o más filas** (`core.apps.bulk_threshold`, configurable por app) o lo pide el hook `agentRisk(operations, ctx) → { required?, reasons?, affectedEstimate? }` de la app. `undo` pasa por la misma regla. Las acciones `invoke` no marcadas seguras (`core.allow_read(..., 'action', roles, false)`) responden 428 a un agente.
- **Propuestas:** `POST proposals {requestId, operations}` (agente editor) ensaya el lote con `core.commit_preview` (sin escribir) y lo deja `pending` **24 horas** con el resumen antes/después; 422 `CONFIRMATION_NOT_NEEDED` si no hace falta. Un owner **humano** aprueba o rechaza (`POST proposals/:id/approve|reject`); aprobar vuelve a ensayar y, si el lote ya no encaja, la propuesta queda rechazada y se responde 409 `PROPOSAL_UNAVAILABLE`. Aprobar no ejecuta: el agente envía exactamente ese lote con `POST commands {requestId, operations, confirmationId}` y `core.commit` comprueba requestId, digest, estado y caducidad y la consume en la misma transacción; si no, 428 `CONFIRMATION_REQUIRED {risk, proposalStatus, mismatch}`. Reintentar un lote aplicado devuelve el recibo.
- **Claves y registro:** `GET/POST agents`, `DELETE agents/:keyId[?onlyMembership=1]` (owner humano; la clave se muestra una vez) y `GET access-log?before=&limit=` (owner). `core.access_events` registra emisión y revocación de claves, cambios de pertenencia y el ciclo de las propuestas. Revocar una clave revoca sus propuestas abiertas.
- **`core.commit_preview(app, actor, operations)`** es pieza general: cualquier app puede usarla para previsualizar un lote (importaciones, «¿qué pasaría si…?»).
- Pendiente: hook `describeChange` para resúmenes legibles.

### 3.2 MCP

`POST /api/v1/mcp` en cada app (JSON-RPC 2.0 sobre HTTP, respuesta JSON; versiones `2025-11-25`, `2025-06-18`, `2025-03-26`; `initialize`, `ping`, `tools/list`, `tools/call`, notificaciones con 202 y lotes). Misma autenticación que la API (clave `ika_` o sesión). Herramientas genéricas: `<app>_snapshot`, `_changes`, `_history`, `_read`, `_commit`, `_prepare_batch` (solo agentes), `_proposals`, `_undo_plan`, `_undo`, `_invoke`; se anuncian según el rol (un lector no ve las de escritura). Cada app añade las suyas con `AppConfig.mcpTools: McpTool[]` (`{name, description, inputSchema, minRole?, annotations?, handler(args, ctx, kit)}`; `kit.commit`, `kit.prepare`, `kit.read`, `kit.snapshot` pasan por el mismo camino que la API: hooks, riesgo, propuestas). Los errores de una herramienta vuelven como resultado con `isError: true` y el `Fault` en `structuredContent`. La aprobación de propuestas no se expone por MCP.

Permisos: `revoke all` a `public`, `anon`, `authenticated` en todo `core.*`; `grant` solo a `service_role`. RLS activado en todas las tablas de todos los schemas con política de denegación por defecto.

---

### 3.3 Catálogo de apps y lanzador

`core.apps` lleva `kind` (`internal` | `portal`), `sort`, `alias_domain` (el nombre en español que redirige: cuida, acoge, papeaki, tramita…) y `description`. `GET /api/v1/apps` (cualquier app, con sesión) devuelve `{items: [{id, name, domain, aliasDomain, kind, description, role}], current}` con las apps a las que la cuenta tiene acceso, en el orden del lanzador. El lanzador del kit (icono superior izquierdo) se pinta con esa lista y abre el dominio principal de cada app; no detecta si la PWA está instalada.

### 3.4 Sesión única entre apps

Entrar con contraseña en cualquier app emite un **pase** del núcleo (32 bytes aleatorios; en `core.sso_passes` solo su sha256, 30 días con caducidad deslizante) en la cookie `ikisai_sso` (`HttpOnly; Secure; SameSite=Lax; Path=/api/v1/auth; Domain=.ikisai.com`, o del host fuera de ikisai.com). El `_worker.js` de cada app reenvía ese pase a la Edge **solo** en `/api/v1/auth/*`, como cabecera `X-Ikisai-Sso` (ninguna otra cookie llega a la Edge). Otra app sin sesión llama a `POST /api/v1/auth/sso` (lo hace `sync-client` 0.3 en `start()`; `sso: false` lo desactiva): si el pase vale y la cuenta tiene acceso a esa app, la Edge crea una **sesión de Supabase nueva e independiente** (enlace mágico generado y verificado en el servidor, sin correo); si no, `401 NO_SSO` (y borra la cookie) o `403 NO_MEMBERSHIP`. **No se comparte ninguna sesión de Supabase entre apps**: sus tokens de refresco son de un solo uso. `auth/logout` revoca el pase del dispositivo y borra la cookie (`{everywhere: true}` revoca todos los pases y cierra todas las sesiones); `auth/password` revoca todos los pases y emite uno nuevo para el dispositivo.

- **«¿Has olvidado tu contraseña?»:**
  - `GET auth/config` → `{passwordRecovery}` dice a la app si debe ofrecer el enlace.
  - `POST auth/recover {email}` responde siempre `{sent: true}`, exista o no la cuenta.
  - El correo lleva a `https://<app>/?token_hash=…&type=recovery`, con un enlace de un solo uso que caduca en una hora.
  - `POST auth/reset {tokenHash, password}` fija la contraseña, cierra las demás sesiones, revoca los pases y emite uno nuevo.
  - Se enciende con `IKISAI_PASSWORD_RECOVERY=1` cuando Auth tenga el correo propio (Workspace). Mientras tanto responde `503 RECOVERY_DISABLED`.

### 3.5 Administración común (base de Central)

La app `central` (Ikisai Central, `central.ikisai.com`, alias `encarna.ikisai.com`) administra el ecosistema: quien es `owner` de `central` (y no es agente) puede, en **todas** las apps, ver cuentas y accesos (`GET admin/accounts`), dar, cambiar o quitar accesos (`POST admin/memberships {app, userId, role | null, scopes?, displayName?}`), dar de alta personas con contraseña temporal y accesos iniciales (`POST admin/invite`), ver y revocar agentes (`GET admin/agents`, `DELETE admin/agents/:keyId`) y leer el registro de accesos de todas o de una (`GET admin/access-log?app=&before=&limit=`). Además, por cuenta: contraseña temporal nueva (`POST admin/accounts/:userId/password`) y desactivar o reactivar (`POST admin/accounts/:userId/disable|enable`; bloquea el acceso a todas las apps sin borrar nada y revoca sus pases). `admin/accounts` incluye `disabled` y `memberships[].updatedAt`. Las rutas solo existen en la función que monta `createApp({ admin: true })`. Protecciones: ninguna app se queda sin propietario humano (`LAST_OWNER`), el administrador no puede quitarse ni degradarse en `central` (`CURRENT_ACCOUNT`), ningún agente es owner ni tiene acceso a `central`. Cada app sigue gestionando sus propios miembros como hasta ahora.

### 3.6 Portales externos: enlaces personales y ámbitos

Diseño acordado con el usuario en `coordinacion/ampliacion/PORTALES.md`. Las apps `organizers` (Ikisai Organizers, `organizers.ikisai.com`, alias `organiza`) y `guests` (Ikisai Guests, `guests.ikisai.com`, alias `ven`) son `kind = 'portal'`. Un organizador o huésped es un usuario de Auth (con su correo real si se conoce, así repite cuenta en el siguiente retiro; si no, una cuenta interna `p-…@portales.ikisai.com`) con pertenencia `editor` al portal y `scopes = {grants: [{reservation_id} | {reservation_id, guest_id}]}`.

- **Emisión** (`createApp({ portalIssuer: true })`, en Booking y Organizers): `POST portal-links {app, scope, person: {name, email?}, label?}` → `{linkId, userId, scope, validUntil, url, shownOnce}` con `url = https://<portal>/i/<token>` (32 bytes; en `core.portal_links` solo el sha256). Booking (editor u owner) emite enlaces de organizador y de huésped; un organizador solo de huésped y solo de sus reservas. `GET portal-links?reservation=`, `POST portal-links/:id/revoke`, `POST portal-links/:id/extend {until}` (ampliar: solo el personal de Booking).
- **Caducidad dinámica:** la app dueña del dato registra un procedimiento con `core.allow_portal_resolver(portal, 'schema.fn')`, `fn(p_scope jsonb) returns timestamptz`, que el núcleo consulta en cada canje (Booking: fin de la reserva más un margen). Si la fecha se mueve, el enlace se amplía o reduce solo; la ampliación manual manda si es posterior.
- **Canje** (cualquier portal): `POST auth/link {token}` → sesión propia de Supabase (como la sesión única) y pase común; `401 LINK_INVALID` (no existe o revocado) o `401 LINK_EXPIRED {validUntil}`.
- En los portales, `members` solo devuelve al propio miembro salvo al owner.
- Pendiente: cuenta permanente (Google y código por correo) y lecturas/escrituras de Booking filtradas por ámbito con procedencia por campo.

- **Cuentas sin duplicados (migración `0078`).** Al emitir un enlace se reutiliza la cuenta de la misma persona: por correo (buscado en la base) o, en huéspedes, por su reserva y su `guest_id`. Con `replace: true`, los enlaces anteriores de ese huésped se revocan en la misma operación. En `sync-client` 0.5, `loginWithLink(token)` canjea el enlace. `GET auth/config` añade `permanentAccount` (se enciende con `IKISAI_PORTAL_ACCOUNTS=1` cuando haya Workspace).
- **Escrituras de un portal en la app dueña.** Una acción de la app dueña registrada para el portal (`core.allow_read('<portal>', '<app>.fn', 'action', '{editor}')`) comprueba el ámbito del actor (`scopes.grants`) y escribe con `core.apply_portal_operations('<app>', ops)`. Es un lote propio de la app dueña, con cursor, hooks de validación y `core.changes`, así que el personal lo recibe por la sincronización normal. Solo funciona dentro de una acción invocada desde un portal por un miembro editor de ese portal. Admite operaciones de fila, no `call`, con un máximo de 100. `updated_by` es el usuario del portal. No genera recibo: la idempotencia la da `expectedRevision`. Al volver, el contexto (`core.app`, `core.role`) es otra vez el del portal.
- **Escrituras de sistema (migración `0076`).** Una acción que lanza el planificador (`worker/<schema>.<fn>`, sin actor y con rol `system`) escribe filas de su propia app con `core.apply_system_operations('<app>', ops)`. Es un lote con cursor, hooks y `core.changes`, cuyo actor es la cuenta de servicio de la app (créala antes con `ensureServiceActor(supabase, '<app>')`). Así, la anonimización llega a los dispositivos y borran su copia. Admite operaciones de fila, no `call`, hasta 500. Una persona no puede usar esta vía.
- **Siembra desde migraciones (migración `0077`).** Una migración de app que crea filas sincronizadas usa `core.apply_migration_operations('<app>', 'migration:<id>', ops)`. Es un lote propio con cursor, hooks y `core.changes`, sin actor y con rol owner, para que llegue a los dispositivos ya sincronizados. Admite operaciones de fila, hasta 500, y la Edge no puede llamarla.
- **Revocar por ámbito.** `core.portal_revoke_scope('<portal>', 'guest_id' | 'reservation_id', valor)` revoca los enlaces con ese ámbito y quita el permiso de las pertenencias, de modo que una sesión ya abierta también lo pierde. Devuelve cuántos enlaces revocó.

### 3.7 Feedback y QA transversal (migración `0066`, diseño en `coordinacion/ampliacion/FEEDBACK.md`)

- **Rutas en todas las apps y portales** (las monta el kit): `feedback/uploads` (+ `verify`, bucket privado `feedback-media`, solo imágenes de hasta 2 MB, también para lectores), `POST feedback`, `GET feedback` (`status=open|pending_verify|verified|dismissed|all`, `node`, `app`, `mine`, `pin`), `GET feedback/tree`, `GET feedback/:id` (uuid o código `FB_AAAA_NNN`) y `POST feedback/:id/support|verify|reopen|dismiss`. Forma y límites en FEEDBACK.md §7.
- **Idempotencia:** `id` lo genera el cliente; la huella cubre lo que escribe el usuario, no el contexto, de modo que un reintento sin red devuelve el mismo reporte (`replayed: true`) y un id reutilizado con otro texto da `409 IDEMPOTENCY_REUSE`.
- **Contexto con lista blanca** en la Edge (`cleanContext`): versión, ruta saneada, dispositivo, en línea, rol, estado de sincronización, últimos 5 errores, últimos 5 fallos HTTP y últimos 10 pasos como nodo. Se descarta todo lo demás. Máximo 8 KB.
- **Destino determinista:** aplicación → `qa` (sin tarea); espacio → `operations` (tarea en Tasks); evento de huésped → `organizer`; evento de organizador → `operations`.
- **Visibilidad:**
  - Los reportes internos los ve cualquier miembro de una app interna.
  - Los de portales los ven quien informa, el editor u owner de Booking, quien trabaja la tarea enlazada y, en los de evento, el organizador de esa reserva.
  - Gestionan el editor u owner de la app de origen y el owner de Central. Verifica además quien lo informó.
  - Fuera de ámbito: `404 OUT_OF_SCOPE`.
- **Ciclo:**
  - Un reporte pasa a `pending_verify` cuando su código aparece en una versión publicada (`core.feedback_mark_released`) o cuando su última tarea está hecha.
  - El pin (`pin=true`) lo ven quien lo informó y el owner de Central.
  - «Sigue fallando» (`reopen`) vuelve a `open` y, si había tarea, pide otra con `sequence + 1`.
- **Enrutado:**
  - `core.feedback_routing_claim` y `core.feedback_routing_result` para el worker. La petición a Tasks no lleva datos personales.
  - `core.feedback_task_status` copia el estado de las tareas.
- **Límites:** 30 reportes al día por persona (`429 FEEDBACK_RATE_LIMITED`), 3 imágenes, 4000 caracteres.
- **Conservación:** los reportes de portales se borran 12 meses después de cerrarse (pg_cron diario).
- **Identidades de servicio (migración `0067`):** perfil `kind = 'service'` con `service_name`. La cuenta de Auth la crea el kit bajo demanda, sin contraseña utilizable. Sus accesos los fija `core.service_grants`; hoy solo existe `feedback`, con rol `editor` en `tasks`. `core.service_actor('feedback')` devuelve su id, y Tasks escribe con `core.commit` como ese actor.
- **Worker del feedback:** `central-api` lo monta con `feedbackWorker: true` en `worker/feedback/tick`. pg_cron lo despierta cada 5 minutos, solo si hay reportes por enrutar o tareas abiertas. Llama a `tasks-api` en `worker/requests/task` y `worker/requests/status`, con la clave de worker.
- **Publicación:** `release.yml` (trabajo `feedback`) busca códigos `FB_…` en los commits publicados y llama a `core.feedback_mark_released`.
- **Script local:** `scripts/feedback_pull.py` vuelca los reportes internos abiertos en `coordinacion/<app>/QA.md`. Lo lanza Core cuando el usuario lo pide.
- **Filtro y modo «Revisor de QA» (migración `0069`):**
  - Los reportes de aplicación entran con `reviewStatus = 'new'` y solo llegan a los agentes cuando el owner de Central los aprueba (`POST feedback/:id/approve`). `feedback_pull.py` vuelca solo los aprobados.
  - `POST feedback/:id/merge {into: código}` une un duplicado: lo cierra y quien lo informó pasa a apoyar el original. `dismiss` de uno nuevo lo deja como `rejected`.
  - `GET feedback?review=true&app=all` (solo el owner de Central) devuelve los nuevos y los pendientes de verificar de todas las apps.
  - `context.routeRaw` (la ruta real sin consulta) se guarda aparte en `route_raw` y solo vuelve, como `routeRaw`, al revisor y a quien informó.
  - Lo operativo no espera revisión.
- **`sync-client` 0.4:** `onSessionEnd(userId)` avisa al cerrar sesión o al entrar otra persona. El resumen de sincronización para el contexto es `status()`, con `pendingCommands`, `conflicts`, `lastPullAt` y `cursor`.


### 3.8 Uso semántico de funcionalidades (migración `0071`, diseño en `coordinacion/ampliacion/USO.md`)

- **Catálogo:**
  - Lo genera el kit al compilar (`dist/feature-catalog.json`, con los `data-feedback-id` y los `usage.run` del código).
  - `release.yml` lo sube con `scripts/usage_catalog_ingest.py`, que llama a `core.usage_catalog_ingest`: altas, etiquetas y funciones retiradas.
  - `GEN: <id>` en un commit publicado sube la generación de esa función (`core.usage_bump_generation`).
- **`POST usage/batch {deviceId, items}`:**
  - Recibe los totales del día por dispositivo; el núcleo guarda el máximo por clave, así que es idempotente sin recibos.
  - Solo admite funciones de la propia app y días de los últimos 14.
  - La persona (`user_key`) solo se guarda si es interna, en `production` y aceptó el aviso (`POST usage/consent`). En portales, en QA y en el revisor, nunca.
- **Revisor › Uso (solo el owner de Central):**
  - `GET usage/review?app=` devuelve los insights calculados al consultar: `NEW`, `HEALTHY`, `HIGH_ACTIVITY`, `DORMANT`, `IGNORED`, `POSSIBLY_INACCESSIBLE`, `FRICTION`, `HIGH_ERROR`, `TARGET_CANNOT_REACH_FEATURE`, `TARGET_NOT_ADOPTING`, `USED_BY_WRONG_AUDIENCE`, `RARE_AS_EXPECTED`, `ORPHANED_USAGE_ID`, `KEPT` y `NOT_EVALUATED`.
  - `GET usage/features/:id` devuelve la tarjeta con `byPerson`, `byTeam` (de `central.common_team_projection`) y `byContext`.
  - `POST usage/features/:id/decision|settings` fija la decisión, la frecuencia, la audiencia o una nueva generación.
- **Retención:** el detalle por persona dura 180 días; después se agrega sin persona ni dispositivo (pg_cron mensual).

### 3.9 Proveedores de almacenamiento (migración `0072`, ALMACENAMIENTO.md fase 1)

- `core.files.storage_provider` (`supabase | r2`) dice dónde vive el objeto, y `bucket` pasa a ser lógico. En R2 hay un bucket físico, y el lógico va como prefijo: `<bucket>/<path>`.
- El kit (`_kit/storage.ts`, `createStorage`) ofrece `uploadUrl`, `readUrl`, `download` y `remove` para los dos proveedores. Las URL de R2 se prefirman con SigV4, comprobado con el ejemplo oficial de AWS.
- `uploads`, `files/:id` y el feedback ya usan la abstracción. El contrato del frontend no cambia.
- **Activación:** secretos `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` y `R2_BUCKET`, más `IKISAI_STORAGE_PROVIDER=r2` para que los archivos nuevos vayan a R2. Lo que ya está en Supabase sigue sirviéndose de allí.
- **Regla para las apps:** nunca llamar a `/storage/v1/object…` directamente. Hay que usar `createStorage(supabase).readUrl(fila)` o `.download(fila)`, con la fila de `core.files` (que lleva `storage_provider`).
- **Copias y restauración:** la copia (`scripts/cloud_backup.py backup`) incluye las cuentas sin contraseñas (`auth/users.jsonl`: id, correo y metadatos). `restore --apply` restaura en el proyecto de ensayo de `private/restore-target.json` y nunca en producción. Recrea las cuentas con contraseña aleatoria, carga los datos sin disparadores, recalcula los cursores, sube los objetos comprobando su huella y verifica los recuentos. La prueba está en `tests/scripts`.
- **Campos de archivo y huérfanos (migración `0075`):**
  - Cada app declara en su migración las columnas que guardan un `file_id`: `select core.register_file_field('<app>', '<schema>', '<tabla>', '<columna>', 'operational|legal|permanent|temporary');`.
  - Cuando las tiene todas, lo dice con `select core.enable_file_gc('<app>');`. Hasta entonces, la recogida no toca sus archivos.
  - El lint avisa de las columnas `*file_id` sin declarar.
  - El worker `files/gc` de central-api, diario, marca los huérfanos de más de 2 días. Borra del proveedor y de `core.files` los que siguen sin referencia a los 30 días, salvo que alguna vez fueran `legal` o `permanent`. Antes de borrar vuelve a comprobarlo.
- **Medición (migración `0073`):** cada semana, `core.storage_snapshot()` guarda los tamaños de la base, los esquemas, `core.changes` y los objetos por bucket lógico y proveedor. Los umbrales están en `core.storage_thresholds`. `GET admin/storage` (owner de Central) devuelve el estado actual, el nivel de cada límite (`ok | warn | critical`) y medio año de historial.

## 4. Commit

### 4.1 Firma

```sql
core.commit(
  p_app text, p_actor uuid, p_request_id text, p_digest text,
  p_expected_cursor bigint,          -- null = no comprobar
  p_operations jsonb) returns jsonb  -- { cursor, results[], changes[] }
```

### 4.2 Operación

```json
{ "op": "insert|update|delete|restore",
  "table": "invoices.invoice_lines",
  "id": "uuid",
  "expectedRevision": 7,
  "fields": { "description": "Tomate", "quantity": 20 } }

{ "op": "call", "procedure": "booking.confirm_reservation",
  "args": { "reservation_id": "uuid", "expectedRevision": 3 } }
```

Reglas:

- `insert` exige `id` generado por el cliente (uuid v4) para que el reintento sea idempotente. `expectedRevision` se ignora.
- `update`, `delete`, `restore` exigen `expectedRevision`. Si la fila no existe → `NOT_FOUND`. Si `revision` difiere → `VERSION_CONFLICT` con `{table, id, expectedRevision, currentRevision, current}`. Se aborta el lote completo.
- `fields` solo puede contener `writable_columns`. Otra cosa → `INVALID_FIELDS`.
- `call` ejecuta un procedimiento del schema de la app incluido en `core.allowed_procedures(app, procedure)`. El procedimiento **debe** aplicar sus escrituras mediante `core.apply_row_op(...)` para que queden en `core.changes` con sus revisiones. Sirve para transacciones de dominio (confirmar reserva y crear evento, importar factura, regenerar lista de compra).
- Máximo 500 operaciones por lote. Las operaciones se aplican en orden.

### 4.3 Secuencia dentro de la transacción

1. `select … from core.app_state where app = p_app for update`.
2. Releer `core.memberships(p_app, p_actor)`. Sin fila o `reader` → `FORBIDDEN`.
3. Buscar `core.receipts(p_app, p_actor, p_request_id)`. Si existe y `digest` coincide → devolver `result` guardado sin tocar nada. Si existe y `digest` difiere → `IDEMPOTENCY_REUSE`.
4. Si `p_expected_cursor` no es null y difiere del cursor actual → `CURSOR_CONFLICT`.
5. Aplicar operaciones; cada una produce una o más filas en `core.changes` con `cursor = actual + 1`.
6. Validar invariantes declarados por la app (`core.validate_hooks(app)` → procedimientos de comprobación, por ejemplo ciclos de dependencias en Tareas).
7. `update core.app_state set cursor = cursor + 1`.
8. Insertar recibo con el resultado.
9. Devolver `{cursor, results, changes}`; `changes` incluye las imágenes `after` para que el cliente actualice su espejo sin otra petición.

Cualquier error deshace todo. El SQLSTATE de los conflictos se mapea a 409 sin reintento automático de PostgREST (como hace hoy la migración 0010 de Tareas).

### 4.4 Historial y deshacer

`core.changes` guarda `before` y `after`. Deshacer el lote `cursor = N` es un nuevo commit que, para cada cambio en orden inverso, aplica `before` con `expectedRevision` igual a la revisión actual de la fila; si alguien ha tocado la fila después, es un `VERSION_CONFLICT` normal y el usuario decide. Nunca se reescribe el historial.

---

## 5. API HTTP por app

La implementa `_kit`; cada app monta sus rutas de lectura, exportación e integración debajo del mismo prefijo. Prefijo `/api/v1/`, mismo origen, `Authorization: Bearer <jwt supabase>`. Errores siempre `{ "error": { "code", "message", "details" } }`.

| Ruta | Función |
|---|---|
| `GET bootstrap` | perfil, membresía y rol, `cursor` actual, hora del servidor, `release`, tablas registradas con sus columnas |
| `GET snapshot?tables=a,b&cursor=&page=` | filas vivas (y borradas recientes si `include_deleted`) de las tablas pedidas, paginado; devuelve el `cursor` al que corresponde |
| `GET changes?after=<cursor>&limit=` | filas de `core.changes` desde el cursor, con `after`; `next` para paginar |
| `POST commands` | `{requestId, expectedCursor?, operations[]}` → `core.commit` |
| `GET history?before=&limit=` | lotes de cambios para la vista de historial |
| `POST history/{cursor}/undo-plan` / `undo` | previsualizar y ejecutar el deshacer de §4.4 |
| `POST uploads` | `{filename, mime, size, sha256}` → `{id, path, uploadUrl, method:'PUT', headers, expiresAt, duplicateOf}`; el cliente hace `PUT uploadUrl` directo al bucket |
| `POST uploads/{id}/verify` | comprueba existencia, tamaño y hash (hasta 25 MB); → `{id, sha256, size, verified, hashVerified}` |
| `GET files/{id}` | → `{id, url, expiresAt, filename, mime, size}` con URL firmada de 10 minutos, tras comprobar pertenencia |
| `POST trash/purge` | `{requestId, tables?}` → `{purged, cursor}`; solo `owner`; respeta `never_purge` |
| `GET members` / `POST members` | lista de pertenencias; alta o cambio `{userId, role, scopes?, displayName?}` solo `owner` |
| `POST members/invite` | `{email, role, scopes?, displayName?}` → crea la cuenta en Auth con contraseña temporal (se devuelve una sola vez) y la pertenencia; solo `owner` |
| `GET read/:name?where[col]=v&limit=&offset=` / `POST read/:name` | lectura registrada en `core.allowed_reads` (§5.1): función `schema.fn(p_ctx jsonb)` de la propia app o vista de proyección publicada por otra app |
| `POST invoke/:name` | acción registrada (`kind = 'action'`): procedimiento volátil fuera de `core.commit`, para colas y trabajos internos de la app; `editor`/`owner` |
| `POST worker/:name` | la misma acción ejecutada por un planificador externo sin sesión de usuario (`actor` null, rol `system`), autenticado con la cabecera `X-Ikisai-Worker-Key` igual al secreto `IKISAI_WORKER_KEY` de la Edge |
| `GET me` | usuario, correo, rol y ámbitos de la sesión |

### 5.1 Lecturas registradas

Una Edge solo ejecuta las RPC `public.core_*`. Para leer su propio schema o la proyección de otra app, la app dueña registra el objeto en una migración: `select core.allow_read('<app lectora>', '<schema>.<objeto>', 'function'|'view'|'action', roles)`. `action` registra un procedimiento volátil `schema.fn(p_ctx jsonb) returns jsonb` que se ejecuta con `invoke`/`worker`; sus escrituras sobre tablas sincronizables deben pasar por `core.apply_row_op` (las tablas internas cerradas, como colas, pueden escribirse directamente). Para dar de baja: `core.unregister_table(app, schema, tabla)` y `core.disallow_read(app, nombre)`; borrar el objeto sigue siendo cosa de la app. Las funciones reciben `{app, actor, role, args}` y devuelven `jsonb`; las vistas admiten filtros de igualdad, `limit` y `offset`. Ejemplo normativo: Booking crea `booking.food_event_projection` y registra `core.allow_read('food', 'booking.food_event_projection', 'view')`.

### 5.2 Errores SQL

Una violación de restricción (`23xxx`) llega como 422 `CONSTRAINT_VIOLATION`; un valor inválido (`22xxx`) como 422 `INVALID_VALUE`; un `raise exception` sin código `PT` como 422 `DOMAIN_ERROR` con el mensaje; cualquier otro error SQL como 422 `SQL_ERROR`. Todos llevan `details.sqlstate`. Solo los fallos de transporte y los 5xx sin SQLSTATE son 503 `BACKEND_UNAVAILABLE` y, por tanto, reintentables.

### 5.3 Contexto de petición

`RequestContext` incluye `token`, el bearer del usuario, para que un hook llame a la API de otra app (por ejemplo la de Tareas) en su nombre.

### 5.4 Código de dominio compartido

El código TypeScript que comparten la Edge y el frontend de una app vive en `supabase/functions/_domain/<app>/` (el despliegue lo empaqueta con la función). `packages/domain-<app>` solo lo reexporta para Vite.

### 5.5 Extracción de documentos con un modelo de visión

**Proveedor (6 de octubre, decisión del usuario: OpenAI de entrada).** `createDocumentExtractorFromEnv(config, Deno.env.get)` elige el proveedor por los secretos: `EXTRACTION_PROVIDER` (`openai`|`anthropic`) si está; si no, OpenAI cuando existe `OPENAI_API_KEY`, y Anthropic en otro caso. `OPENAI_MODEL` / `ANTHROPIC_MODEL` cambian el modelo sin desplegar. OpenAI usa Chat Completions (PDF como `file` con `file_data`, imágenes como `image_url`, salida `json_schema` no estricta o `json_object`); errores y forma de respuesta idénticos a los de Anthropic. Lo que sigue describe la vía Anthropic.

`supabase/functions/_kit/extract.ts` ofrece `createDocumentExtractor(supabase, { apiKey, model?, effort?, … })`, que devuelve `extract({ files, prompt, ctx, schema? }) → { document, warnings, usage }`. La app pasa archivos **ya verificados** de su bucket (PDF o imágenes `jpeg/png/gif/webp`; 5 MB por imagen y 20 MB por llamada) y su prompt de extracción; el helper los descarga con la service key, los adjunta en base64 y llama a Claude (`claude-opus-5-5` por defecto, SDK oficial de Anthropic, prompt en `system` con caché, reintento en servidor sobre otro modelo si el clasificador de seguridad rechaza la petición). Con `schema` la salida se fuerza a esa forma (salida estructurada); sin él, la prosa que el modelo escriba fuera del JSON pasa a `warnings`. El helper **no valida el documento** contra el esquema de la app: lo hace la ruta que lo llama. Errores: `EXTRACTION_UNAVAILABLE 503` (sin `ANTHROPIC_API_KEY`, clave rechazada, cuota, proveedor caído, red: la app ofrece la vía manual), `EXTRACTION_INVALID 422 {errors, warnings, usage}` (truncado, rechazo, sin JSON), `INVALID_FILE 422` (tipo, tamaño o rechazo del proveedor), `FILE_NOT_FOUND 404`. La clave vive en el secreto Edge `ANTHROPIC_API_KEY` (común al proyecto; se carga con `scripts/set_edge_secrets.py`, nunca en Git). El módulo no se reexporta desde `mod.ts`: cada función que extrae lo importa desde `../_kit/extract.ts`, y Deno resuelve `@anthropic-ai/sdk` con `supabase/functions/import_map.json`, que el despliegue sube con cada función.
| `POST auth/login` `refresh` `logout` `password` | proxy de Supabase Auth, idéntico al actual de Tareas |
| `GET health` `GET version.json` | disponibilidad, etapa y release |

Códigos de error del núcleo: `UNAUTHENTICATED 401`, `FORBIDDEN 403`, `NOT_FOUND 404`, `VERSION_CONFLICT 409`, `CURSOR_CONFLICT 409`, `IDEMPOTENCY_REUSE 409`, `INVALID_FIELDS 422`, `INVALID_OPERATION 422`, `PAYLOAD_TOO_LARGE 413`, `CONFIRMATION_REQUIRED 428`, `CONFIRMATION_NOT_NEEDED 422`, `PROPOSAL_UNAVAILABLE 409` (agentes, §3.1), `BACKEND_UNAVAILABLE 503`.

Visibilidad: la app **debe** proporcionar `visible(row, membership)` para cada tabla con ámbitos; `_kit` la aplica en `snapshot`, `changes`, `history` y `files`. Si una app no tiene ámbitos, la visibilidad es la membresía.

---

## 6. Cliente offline (`packages/sync-client`)

### 6.1 Almacenamiento local

IndexedDB `ikisai-<app>-v1` con un store por tabla registrada, más `meta` (cursor, hora de último pull, usuario), `outbox` (comandos pendientes en orden), `conflicts` (pendientes de decisión humana) y `blobs` (adjuntos pendientes de subida).

### 6.2 Ciclo

1. **Arranque:** renderizar desde el espejo local inmediatamente. Si no hay espejo, `bootstrap` + `snapshot`.
2. **Pull:** `changes?after=cursor` al arrancar, al recuperar la red, al volver a primer plano y periódicamente. Para cada cambio recibido: si la fila no tiene edición local pendiente, se aplica (`after`). Si la tiene, se guarda como «base remota» y se decide en el push.
3. **Edición:** la UI escribe en el espejo local y encola un comando con `requestId` (uuid) y `expectedRevision` igual a la revisión que tenía la fila cuando el usuario la abrió. La UI muestra la fila como «pendiente de sincronizar».
4. **Push:** FIFO, un comando en vuelo. Éxito → aplicar `changes` de la respuesta y limpiar. Red caída → esperar. 401 → refrescar y reintentar. 409 `VERSION_CONFLICT` → §6.3. Reintento del mismo `requestId` tras una respuesta perdida → el recibo devuelve el mismo resultado.
5. **Adjuntos:** las fotos se recomprimen en el cliente antes de encolarse (lado mayor 1600 px, WebP de calidad media, sin conservar el original); los PDF se encolan tal cual, con el único techo del Storage (50 MB). El blob se guarda en `blobs` y el comando referencia su `sha256`. Al reconectar: `uploads` → PUT firmado directo al bucket → `verify` → entonces se envía el comando que lo referencia. Si la subida falla, el comando no se envía y la UI lo dice.

### 6.3 Conflictos

Al recibir `VERSION_CONFLICT` con `current`:

- Si el conjunto de campos que cambió el usuario y el conjunto que cambió el servidor (comparando `current` con la base local) son **disjuntos**, el cliente rebasa automáticamente: toma `current`, aplica encima los campos propios, actualiza `expectedRevision` y reenvía. Se informa discretamente («se incorporaron cambios de otra persona»).
- Si **se solapan**, el comando pasa a `conflicts` y la UI muestra ambas versiones campo a campo: «mantener la mía», «tomar la del servidor», o edición combinada. La decisión genera un comando nuevo. Nada se pierde en silencio.
- `delete` contra una fila modificada remotamente siempre pide confirmación.

### 6.4 Lo que el cliente debe mostrar siempre

Estado de red, número de cambios pendientes, conflictos pendientes, y «guardado» solo cuando el servidor ha confirmado. Si no hay red, se puede trabajar; no se simula éxito.

---

## 7. Paquetes de dominio compartidos (`packages/domain-<app>`)

Contienen los tipos TypeScript de cada tabla (generados desde las migraciones), los esquemas de validación (Zod o equivalente ligero) y las reglas puras (cálculo de totales de factura, noches de una reserva, cantidades de la lista de compra). Los importan tanto la Edge como el frontend: la validación offline es idéntica a la del servidor, y la Edge la ejecuta otra vez antes de `core.commit` porque el cliente no es de confianza.

---

## 8. Cruces entre apps

- **Proyecciones:** vistas de solo lectura en el schema del dueño. La Edge de la app lectora las consulta con la service key y las expone en sus rutas de lectura. Ejemplo normativo: `booking.food_event_projection` con `event_id, event_code, reservation_code, title, event_type, start_date, end_date, arrival_time, departure_time, guest_count, minors_count, meal_plan, menu_style, dietary_restrictions (jsonb sin identificar), event_revision`.
- **Enlaces tipados:** `target_app, target_kind, target_id` + opcionalmente `target_revision`. La Edge del que enlaza valida al guardar que el destino existe y es visible para el usuario, llamando a la proyección (apps hermanas) o a la API del dueño con el token del usuario (Tareas).
- **Obsolescencia:** se calcula comparando `source_*_revision` con la revisión actual del origen. No se guardan flags `stale`. La revisión que expone una proyección **puede ser un contador propio del dueño** que solo avanza cuando cambia algo relevante para el lector (Booking: fechas, personas, régimen, restricciones), en vez de la `revision` de la fila, que también cambia por ediciones irrelevantes. El lector puede guardar un conjunto de revisiones de origen (`source_revisions jsonb`) cuando depende de varias filas.
- **Adjuntos en comandos:** un campo que referencia un archivo lleva el marcador `{"$blob": "<sha256>"}`; `sync-client` lo sustituye por el `file_id` cuando el blob se ha subido y verificado, antes de enviar el lote. Así una foto o una firma hecha sin red se enlaza sola a su fila al reconectar.
- **Escrituras cruzadas:** no existen. Si una app necesita que otra haga algo, lo pide por su API con el token del usuario, y la dueña decide.

---

## 9. Suite de conformidad (`packages/test-kit`)

Toda `<app>-api` **debe** pasar, contra PGlite con sus migraciones aplicadas, al menos:

1. insert con `id` de cliente; reintento con el mismo `requestId` devuelve el mismo resultado y no duplica.
2. update con `expectedRevision` correcta incrementa `revision` y produce un cambio con `before`/`after`.
3. update con `expectedRevision` antigua → 409 y la fila no cambia.
4. `expectedCursor` desactualizado → `CURSOR_CONFLICT`.
5. campo fuera de la lista blanca → `INVALID_FIELDS`.
6. `reader` no puede `commands`; sin membresía → 403; sesión cerrada → 401.
7. delete lógico desaparece de `snapshot`, aparece en `changes`, y `restore` lo devuelve.
8. `changes?after=` devuelve exactamente lo posterior al cursor y pagina.
9. undo de un lote restaura `before`; undo tras edición ajena → 409.
10. dos commits concurrentes al mismo cursor: uno confirma, el otro recibe conflicto.
11. `call` a un procedimiento no permitido → `INVALID_OPERATION`; uno permitido anota sus cambios.
12. visibilidad: una fila fuera del ámbito del usuario no aparece ni en `snapshot`, ni en `changes`, ni en `history`.

Más una batería Playwright compartida de offline: corte de red durante edición, recarga con cola pendiente, reconexión y vaciado, conflicto disjunto con rebase automático, conflicto solapado con decisión humana, subida de adjunto diferida.

---

## 10. Despliegue y operación

- Migraciones: una secuencia, inmutables, aplicadas solo por el workflow de release de `main` con la Management API (script heredado de Tareas). Lint en CI: cada archivo toca un único schema y registra sus tablas.
- Edge Functions: un slug por app (`tasks-api`, `invoices-api`, `booking-api`, `food-api`), `verify_jwt:false`, `_kit` empaquetado con cada una. Variante `-qa` con `app` sintético para ensayos contra Supabase real.
- Frontend: Cloudflare Pages por app, `_worker.js` por dominio que solo reenvía al slug de su app y rechaza orígenes cruzados.
- Backup: un trabajo cifrado que exporta `core.*` y los cuatro schemas más los tres buckets, con verificación de hashes y restauración ensayada en un proyecto vacío.
- Observabilidad mínima: `health` por app con release y estado de la base; contador de conflictos y de lotes rechazados en `core.changes`/`receipts` consultable por Core.

---

## 11. Decisiones cerradas con el usuario (5 de octubre de 2026)

1. **Retención del historial:** `core.changes` se conserva íntegro, siempre, sin compactación automática. Si algún día pesa, se decide entonces con datos reales.
2. **Papelera:** nunca se purga automáticamente. La app ofrece «Vaciar papelera» solo al rol `owner`, con confirmación que muestra el recuento. Las facturas y sus documentos no entran en la papelera: se anulan y se conservan. Purgar una fila la saca de la base y de la app, pero su antes y después siguen en `core.changes`; para un borrado real por protección de datos (huéspedes) existe `core.purge_row_history(app, table, id)`, función de Core ejecutada a petición, no un botón.
3. **Adjuntos:** PDF sin límite propio, solo el techo técnico de Supabase Storage (50 MB por archivo en el plan actual), subidos directamente al bucket con URL firmada. Las fotos se recomprimen en el cliente antes de subir a «resolución WhatsApp» (lado mayor 1600 px, calidad media, WebP; entre 100 y 300 KB) y **no se conserva el original**. Si una app necesita el original de alguna foto, se añade como opción explícita por foto, no por defecto.
4. **Fusión automática de campos disjuntos:** activada en todas las apps desde el principio, con aviso discreto y posibilidad de deshacer.

Con esto el contrato v0.1 queda **aprobado** y pasa a ser la referencia de la puerta G0.
