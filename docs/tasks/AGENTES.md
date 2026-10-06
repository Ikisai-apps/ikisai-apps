# Agentes en el núcleo · propuesta de Tasks para Core

Fecha: 6 de octubre de 2026. Autor: equipo Tasks. Estado: **propuesta de diseño para que Core la implemente en `core`, `_kit` y `sync-client`.** No hay código de Tasks en esta propuesta; lo que Tasks hará después está en §9.

Origen: la app antigua (`ikisai-tasks` `d02bf44`) tenía tres piezas propias que ahora deben ser comunes a las cuatro apps: **claves de agente** (`ikisai.agent_keys`, `agents.mjs`), **propuestas con aprobación humana** (`ikisai.proposals`, `CONFIRMATION_REQUIRED`) y un **servidor MCP** (`mcp.mjs`), más un **registro de accesos** (`ikisai.access_events`). El contrato ya las reserva en §3 («`core.agent_keys`, `core.proposals`, `core.access_events`… con columna `app`») y reserva el error `CONFIRMATION_REQUIRED 428`.

---

## 1. Qué debe poder hacer un agente, y qué no

- Leer y escribir en una app **con el mismo contrato que una persona**: `snapshot`, `changes`, `commands`, `history`, lecturas registradas y acciones (`read/…`, `invoke/…`), dentro del rol y los ámbitos de su pertenencia. Los hooks de la app (`visible`, `beforeCommit`, `validate_hooks`) se le aplican sin cambios.
- **No** puede ser `owner`, ni administrar pertenencias o claves, ni aprobar propuestas, ni usar `auth/*`.
- Lo **destructivo o masivo** no lo ejecuta directamente: prepara una propuesta, una persona la aprueba, y solo entonces el agente envía **exactamente ese lote**. Aprobar no ejecuta.
- Todo lo que hace queda en `core.changes` con su `actor_id`, y los hitos de acceso (emitir, revocar, preparar, aprobar, consumir) en `core.access_events`.

No es objetivo: agentes entre apps con una sola llamada, ni ejecución autónoma en el servidor (eso son las rutas `worker`, §7).

---

## 2. Identidad y claves

Un agente es un usuario de Auth sintético más un perfil y pertenencias normales, como en la app antigua. Así `updated_by`, `actor_id` y las FK a `auth.users` siguen valiendo y la app no distingue más que por `profile.kind`.

```sql
core.agent_keys(
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,  -- el usuario sintético del agente
  name        text not null check (length(btrim(name)) between 1 and 100),
  digest      text not null unique check (digest ~ '^[0-9a-f]{64}$'),    -- sha256 de la clave; la clave no se guarda
  hint        text not null,                                              -- últimos 4 caracteres, para reconocerla en la lista
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz,                                                -- opcional
  last_used_at timestamptz,
  revoked_at  timestamptz)
```

- **La clave es del agente, no de una app.** A qué apps llega y con qué rol y ámbitos lo dicen sus filas de `core.memberships` (una por app). Un mismo agente puede trabajar en Tasks e Invoices con una sola clave; revocar la clave lo corta en todas. `core.profiles.kind = 'agent'` y `display_name = name`.
- **Formato:** `ika_` + 32 bytes aleatorios en base64url (43 caracteres), como hoy. Se muestra una sola vez al emitirla. Viaja en `Authorization: Bearer ika_…`.
- **Autenticación en `_kit`:** `auth.identity(token)` reconoce el prefijo y llama a `core_agent_identity(p_digest)` → `{id, kind:'agent', keyId}` si la clave existe, no está revocada ni caducada. No hay sesión ni refresco. `last_used_at` se actualiza como mucho una vez por minuto. Con clave de agente, `auth/login|refresh|logout|password` responden 403.
- **Origen:** los agentes llaman de servidor a servidor, sin cabecera `Origin`; el handler ya solo rechaza orígenes presentes y no permitidos. El `_worker.js` de Pages debe dejar pasar `/api/v1/*` y `/mcp` sin `Origin`.
- **Rol:** `reader` o `editor`. `core.set_membership` rechaza `owner` para un perfil `agent` (`INVALID_ROLE`).

---

## 3. Riesgo y propuestas

### 3.1 Qué exige aprobación

`required = destructivo || masivo || lo que diga la app`.

- **Destructivo (núcleo):** cualquier operación `delete`; cualquier `call` o acción `invoke` cuyo registro lleve `agent_confirmation = true` (columna nueva en `core.allowed_procedures` y en `core.allowed_reads` para `kind = 'action'`; por defecto `true`: un procedimiento es opaco para el núcleo).
- **Masivo (núcleo):** el lote toca 10 o más filas (`bulkThreshold`, configurable por app en `core.apps`). El umbral es por lote; no detecta un trabajo largo troceado en lotes pequeños, igual que hoy.
- **Dominio (hook nuevo de app):** `agentRisk(operations, ctx) → { required, reasons[], affectedEstimate }`. Tasks lo usará para archivar (`status: 'archived'`, `archived: true`) y para contar cascadas (hijas de una tarea, etiquetas de una familia).

`undo` de un agente pasa por la misma regla sobre las operaciones del plan.

### 3.2 Datos

```sql
core.proposals(
  id          uuid primary key default gen_random_uuid(),
  app         text not null references core.apps(id),
  user_id     uuid not null references auth.users(id),      -- el agente
  key_id      uuid references core.agent_keys(id),
  request_id  text not null,
  digest      text not null,                                 -- sha256(stable(operations)), el mismo que usa core.commit
  operations  jsonb not null,
  risk        jsonb not null,                                -- { required, destructive, affectedEstimate, bulkThreshold, reasons }
  summary     jsonb not null,                                -- antes/después por fila, del ensayo (§3.3)
  status      text not null check (status in ('pending','approved','rejected','consumed','revoked')),
  expires_at  timestamptz not null,                          -- una hora
  decided_by  uuid references auth.users(id),
  decided_at  timestamptz,
  consumed_cursor bigint,
  created_at  timestamptz not null default now(),
  unique (app, user_id, request_id))
```

`expired` no se guarda: es `pending|approved` con `expires_at < now()`.

### 3.3 Ensayo (`dry run`) en `core.commit`

Para preparar una propuesta hay que validar el lote y obtener su antes/después **sin escribir**. Propuesta: `core.commit_preview(p_app, p_actor, p_operations) returns jsonb`, que ejecuta el mismo cuerpo que `core.commit` (operaciones, `validate_hooks`) dentro de un bloque que siempre termina en excepción capturada, de modo que la subtransacción se deshace y la función devuelve `{ changes: [{table, id, op, before, after}] }`. No toca cursor, recibos ni `core.changes`.

Es útil fuera de los agentes: Tasks lo usaría para la previsualización de CSV (hoy valida solo con el código de dominio de la Edge) y cualquier app para «¿qué pasaría si…?».

### 3.4 Flujo

```text
agente:  POST proposals {requestId, operations}
           → beforeCommit + commit_preview; si no requiere aprobación → 422 CONFIRMATION_NOT_NEEDED
           → { id, status:'pending', expiresAt, risk, summary }
persona: GET proposals · GET proposals/:id · POST proposals/:id/approve | reject     (owner de esa app)
           → approve vuelve a ensayar el lote; si ya no es válido → 409 PROPOSAL_UNAVAILABLE
agente:  GET proposals/:id   (consulta el estado)
         POST commands {requestId, operations, confirmationId}
           → core.commit comprueba y consume la aprobación en la misma transacción
```

### 3.5 Dónde se impone

En `core.commit`, no en la Edge, para que no haya carrera entre aprobar y ejecutar:

- Parámetro nuevo `p_confirmation jsonb default null` = `{ required: boolean, id: uuid | null }`. `required` lo calcula `_kit` (regla del núcleo + `agentRisk` de la app); la Edge es de confianza, como hoy.
- Si el actor es `agent`, no hay recibo previo para ese `request_id` y `required` es verdadero: debe existir una propuesta con ese `id`, de ese `app` y `user_id`, `status = 'approved'`, no caducada, con el mismo `request_id` y el mismo `digest`. Si no → `CONFIRMATION_REQUIRED` (428) con `{ risk }`. Si sí → se aplica el lote y la propuesta pasa a `consumed` con `consumed_cursor`, en la misma transacción.
- Reintentar un lote ya aplicado devuelve el recibo, sin volver a pedir aprobación.
- Revocar la clave o quitar la pertenencia pasa a `revoked` las propuestas `pending|approved` de ese agente en esa app.

`sync-client` no necesita cambios: un agente no usa el cliente offline. Solo conviene que `CONFIRMATION_REQUIRED` (428) siga yendo a `rejected()` si alguna vez lo recibe.

---

## 4. Registro de accesos

```sql
core.access_events(
  id       bigint generated always as identity primary key,
  app      text references core.apps(id),        -- null si el hecho no es de una app (emitir o revocar una clave)
  actor_id uuid references auth.users(id),
  key_id   uuid references core.agent_keys(id),
  event    text not null,                        -- lista cerrada, abajo
  meta     jsonb not null default '{}',          -- sin secretos ni contenido de filas
  at       timestamptz not null default now())
```

Eventos: `key_issued`, `key_revoked`, `member_invited`, `member_changed`, `proposal_prepared`, `proposal_approved`, `proposal_rejected`, `proposal_consumed`, `session_revoked`. Los escriben las propias funciones de `core`. Ruta `GET access-log?before=&limit=` para el `owner` con acceso completo. Cubre lo que le falta al escenario 37 de Tasks.

---

## 5. Rutas del kit (por app, mismo prefijo `/api/v1/`)

| Método y ruta | Quién | Qué hace |
|---|---|---|
| `GET agents` | owner | claves con pertenencia a esta app: `{keyId, userId, name, hint, role, scopes, lastUsedAt, expiresAt, revoked}`; nunca la clave |
| `POST agents` `{name, role, scopes?, expiresAt?, userId?}` | owner | sin `userId`: crea usuario sintético, perfil `agent`, pertenencia y clave → `{…, token, shownOnce: true}`. Con `userId` de un agente existente: solo añade la pertenencia a esta app |
| `DELETE agents/:keyId` | owner | revoca la clave (en todas las apps) y sus propuestas abiertas; `?onlyMembership=1` quita solo la pertenencia a esta app |
| `POST proposals` `{requestId, operations}` | agente editor | §3.4 |
| `GET proposals` · `GET proposals/:id` | owner (todas las de la app) · agente (las suyas) | las cien más recientes |
| `POST proposals/:id/approve` · `reject` | owner humano | §3.4; `reject` también retira una aprobación aún no consumida |
| `POST commands` con `confirmationId` | agente editor | §3.5 |
| `GET access-log` | owner con acceso completo | §4 |

Hooks nuevos de `AppHooks`: `agentRisk` (§3.1) y `describeChange(table, before, after, ctx) → { title, fields }`, para que el resumen que revisa la persona sea legible («Tarea · Pintar · hecha: no → sí») sin que el núcleo sepa de dominio. El resumen se filtra con `visible` para quien lo lee.

---

## 6. MCP

Una ruta `POST /mcp` por app en `_kit` (JSON-RPC 2.0; versiones de protocolo `2025-03-26`, `2025-06-18`, `2025-11-25`; `initialize`, `ping`, `tools/list`, `tools/call`), con la misma autenticación que la API. Herramientas genéricas, que el kit monta sobre lo que ya existe:

| Herramienta | Equivale a | Notas |
|---|---|---|
| `<app>_snapshot` | `GET snapshot` | con `tables`, paginado |
| `<app>_changes` | `GET changes?after=` | |
| `<app>_history` | `GET history` | |
| `<app>_read` `{name, args}` | `read/:name` | una entrada por lectura registrada en `core.allowed_reads` para esa app |
| `<app>_commit` `{requestId, operations, confirmationId?}` | `POST commands` | solo `editor` |
| `<app>_prepare_batch` `{requestId, operations}` | `POST proposals` | solo agentes editores |
| `<app>_proposals` | `GET proposals` | |
| `<app>_undo_plan`, `<app>_undo` | `history/:cursor/undo-plan`, `undo` | |
| `<app>_invoke` `{name, args}` | `invoke/:name` | acciones registradas (`kind = 'action'`) |

`AppConfig.mcpTools` permite a cada app añadir herramientas **de dominio**. Hacen falta: con tablas tipadas y filas puente, pedirle a un agente que construya a mano las operaciones de fila de «mover una tarea con sus hijas» es frágil. Tasks añadirá `tasks_tree`, `tasks_create_task`, `tasks_update_task`, `tasks_complete`, `tasks_move`, `tasks_delete`, `tasks_set_labels` y `tasks_set_dependencies`, que construyen el lote con `_domain/tasks/ops.ts` y lo envían por el mismo camino (riesgo, propuesta, `commit`).

Las herramientas se anuncian según el rol (`readOnlyHint`, `destructiveHint`). La aprobación **no** se expone por MCP: es de la interfaz o de la API con cuenta de persona.

---

## 7. Cómo encaja con `invoke` y `worker`

- **`invoke/<schema.fn>`** (acciones volátiles): un agente editor puede invocarlas igual que una persona. Si la acción está marcada `agent_confirmation`, se le exige propuesta: `POST proposals` admite también `{requestId, invoke: {name, args}}` y `invoke` acepta `confirmationId`. El ensayo de una acción no siempre es posible; en ese caso el resumen es solo `{name, args}`.
- **`worker/<patrón>`** (planificador con `X-Ikisai-Worker-Key`, actor nulo, rol `system`): no usa claves de agente ni propuestas. Son tareas del propio sistema, ya revisadas en código. Solo comparten el registro: conviene que cada ejecución deje un `access_event` (`worker_run`) con su resultado.
- Un agente **no** puede llamar a rutas `worker`, y la clave de `worker` no sirve para la API.

---

## 8. Seguridad

- Solo el `digest` en base de datos; la clave en claro no se registra en logs ni en `access_events`.
- Revocación inmediata: la clave se consulta en cada petición. Caducidad opcional por clave.
- Límite de intentos fallidos por IP en `core_agent_identity` (los 43 caracteres ya hacen inviable la fuerza bruta; es para no llenar los logs).
- El agente nunca recibe más de lo que `visible` le deja ver, tampoco en los resúmenes de sus propias propuestas.
- Un respaldo incluye `agent_keys` (digests) y `proposals`; **al restaurarlo se revocan** todas las claves y las propuestas abiertas, como hoy.

---

## 9. Orden de implementación y qué hace cada uno

**Core** (propuesta de orden): (1) `core.agent_keys`, `core_agent_identity`, rutas `agents` y autenticación por clave; (2) `core.commit_preview`; (3) `core.proposals`, parámetro `p_confirmation` y rutas `proposals`; (4) `core.access_events` y `access-log`; (5) `/mcp` genérico con `mcpTools`. Suite de conformidad: clave válida, revocada y caducada; agente sin `owner`; lote destructivo sin aprobación → 428; aprobado con otro `digest` → 428; aprobado y consumido una sola vez; propuesta caducada; reintento idempotente tras consumir; resumen filtrado por ámbitos.

**Tasks**, cuando exista lo anterior: hook `agentRisk` (archivo y cascadas) y `describeChange`; herramientas MCP de dominio (§6); volver a mostrar en la interfaz «Accesos y permisos» (claves de agente), «Propuestas de agentes» y «Registro de accesos», que siguen en `access-ui.js` y `accounts-ui.js`, ocultas en el menú; portar el escenario 29 (operación destructiva de un agente que espera revisión humana y se aplica después tal cual) y la mitad pendiente del 37.

---

## 10. Decisiones abiertas

| # | Decisión | Propuesta de Tasks | Quién decide |
|---|---|---|---|
| A1 | Clave por agente (multiapp) o una por app | Por agente, con pertenencias por app | Core |
| A2 | Umbral de lote masivo | 10 filas, como hoy; configurable por app | Usuario |
| A3 | Caducidad de una propuesta | Una hora, como hoy | Usuario |
| A4 | ¿Los procedimientos y acciones exigen aprobación a un agente por defecto? | Sí, salvo que la app los marque como seguros | Core |
| A5 | ¿Dónde se aprueban las propuestas de un agente multiapp? | En la interfaz de cada app (cada propuesta es de una app) | Core |
| A6 | Ensayo (`commit_preview`) como pieza general del contrato | Sí; lo usarían también las previsualizaciones de importación | Core |
