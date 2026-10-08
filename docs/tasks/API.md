# Tasks · API y modelo de datos (puerta G2)

Fecha: 6 de octubre de 2026. Autor: equipo Tasks. Estado: **puerta G2 aprobada por Core de forma provisional el 6 de octubre de 2026** (`docs/core/RESPUESTAS.md`). D1, D5 y D6 aprobadas. La resolución de las peticiones y lo que cambia respecto al texto original está en §16; donde §16 contradiga a §14, manda §16.

Origen estudiado: `Ikisai-apps/ikisai-tasks` `main` `d02bf44` (v0.7.0-build.4): `supabase/migrations/2026100500{01..10}`, `supabase/functions/ikisai-api/{domain,service}.mjs`, `docs/DEPENDENCIAS_TAREAS.md`, `docs/ACCESOS_Y_AGENTES.md`, `app/` (en especial `sync.js`, `cloud-auth.js` y sus usos) y `tests/integration.cjs` (72 escenarios). Destino comprobado contra el núcleo real, no solo contra el contrato: `20261006_0001_core_base.sql`, `20261006_0003_core_files.sql`, `supabase/functions/_kit`, `packages/sync-client` y `scripts/lint_migrations.mjs`.

Sigue `docs/core/PLANTILLA_API_APP.md` (§1–§12) y añade §13 (adaptador que sustituye a `sync.js`/`cloud-auth.js`), §14 (peticiones a Core), §15 (decisiones que se apartan de `PORT.md`), §16 (resolución de Core) y §17 (el adaptador tal y como se ha construido). Donde el núcleo actual no permite lo que aquí se describe, se dice y se remite a la petición `C<n>` de §14.

---

## 1. Dominio y límites

Tasks gestiona el trabajo de Ikisai: **áreas** (`tabs`) → **proyectos** → **tareas** con un único nivel de hijas, **dependencias** entre tareas de la misma área, un **catálogo** por área de familias y etiquetas (incluida la familia Persona, de la que salen los responsables), **vistas guardadas**, **adjuntos** de proyecto y de tarea, papelera, historial y deshacer.

No hace: calendario de proyecto, duraciones ni Gantt; traslado de proyectos o tareas entre áreas (solo copia); edición simultánea en tiempo real. Las claves de agente, las propuestas con aprobación humana, el registro de accesos y MCP no entran en esta fase: se portarán sobre `core` con columna `app` (PLAN §4, PORT §1).

Datos de otras apps: ninguno. Tasks no lee de Invoices, Booking ni Food. Es leída por Invoices (destinos de asignación) a través de las rutas de §7 con el token del usuario.

Lo que se conserva tal cual del comportamiento actual: jerarquía y finalización calculada del padre, dependencias con condiciones heredadas y ciclos prohibidos, Entrada protegida por área, ámbitos por área y por proyecto, bloqueo privado visible sin revelar contenido, borrado lógico con restauración por lote, y la interfaz completa.

---

## 2. Tablas sincronizables (`tasks.*`)

App: `select core.ensure_app('tasks', 'Ikisai Tasks', 'tasks.ikisai.com')`. Todas las tablas llevan las columnas del contrato §2.1 (`id`, `revision`, `created_at`, `updated_at`, `updated_by`, `deleted_at`), que no se repiten abajo. Todos los `id` son **uuid v4 generados por el cliente**; los identificadores heredados (`p1`, `tab-…`, `person`) desaparecen. Salvo `tasks.tabs`, todas se registran con los roles por defecto (lectura `reader, editor, owner`; escritura `editor, owner`) y `never_purge = false`.

Reglas comunes:

- `tab_id` viaja desnormalizado en todas las tablas y `project_id` en todas las que cuelgan de un proyecto. Así `visible(table,row,ctx)` es una función pura de la fila (§5) y un cambio de proyecto llega al espejo de quien gana o pierde acceso como cambio de cada fila afectada. La coherencia de esas claves la comprueba el hook SQL (§4.2, `INCONSISTENT_KEYS`).
- `position numeric` es el orden manual fraccional (`order` heredado). El cliente inserta con `máximo + 1024`.
- Columnas inmutables tras el `insert`: trigger `tasks.guard_immutable` (`before update`) que llama a `core.fail('IMMUTABLE_FIELD', 422, {field})`.
- La unicidad (una Entrada por área, una familia por `system_key`, una fila puente viva por par) la comprueba el hook SQL con su código de dominio, no un índice único: todas las escrituras pasan por `core.commit`, que es serial por app, y un índice único respondería antes que el hook con un `CONSTRAINT_VIOLATION` genérico.
- Toda restricción (`check`, FK) queda como red de seguridad y tiene **delante** una validación con código de dominio (`beforeCommit` o trigger/hook con `core.fail`). Motivo: el usuario debe recibir el código de dominio y su mensaje, no un `CONSTRAINT_VIOLATION` genérico (desde C4 un SQLSTATE no previsto llega como 422 definitivo, ya no como 503).

### 2.1 `tasks.tabs` · áreas

| Columna | Tipo y restricciones |
|---|---|
| `name` | `text not null`, 1–200 tras `btrim` |
| `color` | `text null`, `^#[0-9a-fA-F]{6}$` |
| `position` | `numeric not null default 0` |

`writable_columns`: `name, color, position`. **`writable_roles = {owner}`** (solo el propietario administra áreas). Índice: `(position) where deleted_at is null`.

### 2.2 `tasks.projects`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `title` | `text not null`, 1–300 |
| `note` | `text not null default ''` |
| `status` | `text not null default 'active' check (status in ('active','paused','archived'))` |
| `priority` | `text not null default 'normal' check (priority in ('normal','high','critical'))` |
| `due` | `date null` |
| `owner_label_id` | `uuid null references tasks.labels(id)` (responsable: etiqueta de la familia Persona) |
| `color` | `text null`, hex de seis cifras |
| `budget` | `numeric(14,2) null check (budget >= 0)` |
| `position` | `numeric not null` |
| `system` | `text null check (system in ('inbox'))` · inmutable |

`writable_columns`: `tab_id, title, note, status, priority, due, owner_label_id, color, budget, position, system`. Índices: `(tab_id, position) where deleted_at is null`; `(tab_id) where system = 'inbox'`.

Entrada: cada área viva tiene exactamente un proyecto con `system = 'inbox'`, título `Entrada`, vivo y no archivado. Lo crea el cliente en el mismo lote que el área (§3.1) y lo vigila el hook (`INBOX_PROTECTED`).

### 2.3 `tasks.tasks`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `project_id` | `uuid not null references tasks.projects(id)` |
| `parent_id` | `uuid null references tasks.tasks(id)`, `check (parent_id <> id)` |
| `title` | `text not null`, 1–1000 (`text` heredado) |
| `note` | `text not null default ''` |
| `done` | `boolean not null default false` |
| `done_at` | `timestamptz null` · **no escribible**; lo mantiene el trigger `tasks.touch_done_at` |
| `priority` | como en proyectos |
| `due` | `date null` |
| `owner_label_id` | `uuid null references tasks.labels(id)` |
| `cost` | `numeric(14,2) null check (cost >= 0)` |
| `position` | `numeric not null` |

`writable_columns`: `tab_id, project_id, parent_id, title, note, done, priority, due, owner_label_id, cost, position`. Índices: `(project_id, position) where deleted_at is null`; `(parent_id) where parent_id is not null`; `(tab_id)`; `(owner_label_id) where owner_label_id is not null`.

Finalización del padre: una tarea con hijas vivas es un contenedor; su estado se **calcula** (`todas las hijas vivas hechas`) y su columna `done` se ignora mientras tenga hijas vivas. Nadie escribe `done` en un padre: «completar un padre» se traduce en actualizar cada hija viva (§3.1). Al colgar la primera hija de una tarea hecha, el cliente escribe `done = false` en el padre en el mismo lote, para que al perder sus hijas reaparezca como pendiente (comportamiento actual de `canonical()`).

Papelera por lote: `core.commit` es una transacción, así que todas las filas borradas en un lote comparten exactamente el mismo `deleted_at`. El «lote de borrado» de una tarea son las filas de su proyecto con su mismo `deleted_at`; sustituye a la columna `deleteBatch`.

### 2.4 `tasks.task_dependencies`

Una fila por arista «`task_id` depende de `depends_on_id`».

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `project_id` | `uuid not null references tasks.projects(id)` · proyecto de `task_id` |
| `task_id` | `uuid not null references tasks.tasks(id)` · inmutable |
| `depends_on_id` | `uuid not null references tasks.tasks(id)`, `check (task_id <> depends_on_id)` · inmutable |
| `position` | `numeric not null default 0` |

`writable_columns`: `tab_id, project_id, task_id, depends_on_id, position`. Índices: `(task_id, depends_on_id) where deleted_at is null`; `(depends_on_id)`; `(tab_id)`.

Quitar una dependencia es un `delete` de la fila. Borrar la tarea de la que se depende **no** borra la arista ni la cumple: la tarea sigue bloqueada y la interfaz la muestra como «condición en papelera».

### 2.5 `tasks.families`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `name` | `text not null`, 1–100 |
| `color` | `text not null`, hex de seis cifras |
| `archived` | `boolean not null default false` |
| `position` | `numeric not null default 0` |
| `system_key` | `text null check (system_key in ('person','trade','phase','building','space'))` · inmutable |

`writable_columns`: `tab_id, name, color, archived, position, system_key`. Índices: `(tab_id, position)`. Una sola familia viva por `system_key` y área (`INVALID_FAMILY`).

`system_key` sustituye a los `id` fijos heredados. `person` identifica la familia de la que salen los responsables. Las cinco familias por defecto (Persona `#6f5a8f`, Oficio `#b76b3d`, Fase `#6b7b54`, Edificio `#4e6f72`, Espacio `#9c744e`) las inserta el cliente al crear el área.

### 2.6 `tasks.labels`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `family_id` | `uuid not null references tasks.families(id)` |
| `parent_id` | `uuid null references tasks.labels(id)`, `check (parent_id <> id)` |
| `name` | `text not null`, 1–200 (`text` heredado) |
| `archived` | `boolean not null default false` |
| `archived_before_family` | `boolean null` (estado previo mientras su familia está archivada; `beforeFamilyArchive` heredado) |
| `position` | `numeric not null default 0` |

`writable_columns`: `tab_id, family_id, parent_id, name, archived, archived_before_family, position`. Índices: `(tab_id, family_id, position)`; `(parent_id) where parent_id is not null`.

Familias y etiquetas se **archivan**, no se borran: `beforeCommit` rechaza `delete`/`restore` sobre ellas (`ARCHIVE_REQUIRED`). El único `delete` que les llega es el inverso de su creación al deshacer (el deshacer del núcleo no pasa por `beforeCommit`), y el hook impide dejar referencias vivas a una etiqueta borrada (`LABEL_IN_USE`).

### 2.7 `tasks.task_labels` y `tasks.project_labels`

`task_labels`: `tab_id` (inmutable), `project_id` (proyecto de la tarea), `task_id` (inmutable), `label_id` (inmutable); todas `uuid not null` con FK. `writable_columns`: las cuatro. Índices: `(task_id, label_id) where deleted_at is null`; `(label_id)`; `(project_id)`.

`project_labels` (etiquetas propias del proyecto, `ownLabels`): `tab_id`, `project_id`, `label_id`, todas inmutables. `writable_columns`: las tres. Índices: `(project_id, label_id) where deleted_at is null`; `(label_id)`.

Tablas puente con `id` propio (recomendación de Core en PORT §3): dos dispositivos que añaden etiquetas distintas a la misma tarea no chocan.

### 2.8 `tasks.saved_views`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `name` | `text not null`, 1–100 |
| `search` | `text not null default ''`, hasta 1000 |
| `filters` | `jsonb not null default '{}'`, objeto |
| `group_by` | `text not null default 'project'`: `project`, `state` o el uuid de una familia del área |
| `position` | `numeric not null default 0` |

`writable_columns`: `tab_id, name, search, filters, group_by, position`. Índice: `(tab_id, position) where deleted_at is null`.

`filters`: claves `_state` (`pending|done`), `_availability` (`ready|blocked`), `_project` (uuid de proyectos del área) o el uuid de una familia del área (uuid de sus etiquetas); valores, listas de cadenas. Forma en `beforeCommit`; pertenencia al área en el hook (`INVALID_VIEW`).

### 2.9 `tasks.attachments`

| Columna | Tipo y restricciones |
|---|---|
| `tab_id` | `uuid not null references tasks.tabs(id)` · inmutable |
| `project_id` | `uuid not null references tasks.projects(id)` |
| `task_id` | `uuid null references tasks.tasks(id)` (null = adjunto del proyecto) · inmutable |
| `name` | `text not null`, 1–255 |
| `mime` | `text not null` · inmutable |
| `size` | `bigint not null check (size >= 0)` · inmutable |
| `sha256` | `text not null check (sha256 ~ '^[0-9a-f]{64}$')` · inmutable |
| `file_id` | `uuid not null references core.files(id)` · inmutable. El cliente envía `{"$blob": "<sha256>"}` y `sync-client` lo sustituye por el `file_id` al verificar la subida |
| `position` | `numeric not null default 0` |

`writable_columns`: `tab_id, project_id, task_id, name, mime, size, sha256, file_id, position`. Índices: `(project_id) where deleted_at is null`; `(task_id) where task_id is not null`; `(file_id)`.

### 2.10 Correspondencia con el modelo heredado

| Heredado (`data jsonb`) | Nuevo |
|---|---|
| `version`, `updatedAt` | `revision`, `updated_at` |
| `deleted`, `deletedAt` | `deleted_at` |
| orden del array de áreas; `order` | `position` |
| `project.title/note/status/priority/due/color/budget/system` | columnas homónimas |
| `project.owner`, `task.owner` | `owner_label_id` |
| `project.ownLabels[]` | filas de `project_labels` |
| `task.text` | `tasks.title` |
| `task.parentId`, `projectId` contenedor | `parent_id`, `project_id` |
| `task.labels[]` | filas de `task_labels` |
| `task.dependsOn[]` | filas de `task_dependencies` (`position` = índice) |
| `task.deleteBatch` | derivado: mismo `deleted_at` (§2.3) |
| `task.done` de un padre (ausente) | columna ignorada mientras tenga hijas vivas |
| `attachments[] {id,name,sha256,mime,size}` | filas de `attachments` |
| `family.id` fijo (`person`…) | `system_key` |
| `label.text/family/parent/beforeFamilyArchive` | `name/family_id/parent_id/archived_before_family` |
| `view.groupBy` | `saved_views.group_by` |

Códigos humanos: Tasks no registra prefijos en `core.next_code`.

Orden canónico de tablas (snapshot, importación, purga en sentido inverso): `tabs, families, labels, projects, tasks, project_labels, task_labels, task_dependencies, saved_views, attachments`.

---

## 3. Procedimientos (`call`) y operaciones compuestas

Criterio: **todo lo que el usuario hace desde la interfaz son operaciones de fila**. Dos razones comprobadas en el núcleo: `sync-client` no puede aplicar un `call` al espejo local (`applyLocally` devuelve `null`), así que un procedimiento no funciona sin red; y un lote que contiene un `call` no se puede deshacer (`core.undo_plan` → `UNDO_UNAVAILABLE`). Las cascadas las construye el cliente con funciones puras de `packages/domain-tasks` y el servidor las **verifica** en el hook SQL (§4.2); un lote incompleto se rechaza entero.

### 3.1 Operaciones compuestas (filas, sin `call`)

Las genera `domain-tasks` (`ops.ts`); el adaptador de §13 y cualquier otro cliente usan las mismas funciones. Máximo una operación por `(tabla, id)` en un lote (`DUPLICATE_OPERATION`).

| Acción | Operaciones del lote | Lo verifica |
|---|---|---|
| Crear área | `insert tabs` + `insert projects` (`system:'inbox'`, `title:'Entrada'`) + `insert families` ×5 con `system_key` | `INBOX_PROTECTED` |
| Crear tarea | `insert tasks` + `insert task_labels` por cada etiqueta elegida; si no se eligió ninguna, una por cada `project_labels` del proyecto | `PROJECT_UNAVAILABLE`, `INVALID_LABELS` |
| Completar o reabrir un padre | `update tasks {done}` en cada hija viva; nunca en el padre | `TASK_BLOCKED` |
| Colgar una hija de una tarea hecha | además `update` del padre con `done:false` | — |
| Mover tarea de proyecto | `update tasks {project_id, position}` en la tarea y en sus hijas vivas, y `update {project_id}` en sus `task_labels`, `task_dependencies` (como `task_id`) y `attachments` vivos | `INCONSISTENT_KEYS`, `PROJECT_UNAVAILABLE`, ámbito en origen y destino |
| Borrar tarea | `delete` de la tarea y de sus hijas vivas | `INVALID_PARENT` (hija viva con padre borrado) |
| Restaurar tarea | `restore` de la tarea, de todas las filas de su proyecto con su mismo `deleted_at` (su lote de borrado) y, si es hija, de su padre | `INVALID_PARENT` |
| Archivar familia | `update families {archived:true}` + por cada etiqueta `update {archived:true, archived_before_family:<archived previo>}` | `FAMILY_ARCHIVED` |
| Reactivar familia | `update families {archived:false}` + por cada etiqueta `update {archived:<archived_before_family>, archived_before_family:null}` | — |
| Cambiar etiquetas o dependencias | `insert`/`delete` de filas puente (o `restore` de la arista borrada) | `INVALID_LABELS`, `INVALID_DEPENDENCIES`, `DEPENDENCY_CYCLE` |
| Archivar proyecto | `update projects {status}` | `INBOX_PROTECTED` |

Un guardado que supere 500 operaciones (solo ocurre en importaciones JSON/Keep y duplicados grandes) se trocea en orden canónico de tablas, padres antes que hijas y puentes al final: cada trozo deja un estado válido. No es atómico entre trozos; el fallo de uno se muestra como lote rechazado.

### 3.2 `tasks.import_rows` (único procedimiento)

Para importar una copia portable como áreas nuevas, que puede superar con mucho las 500 operaciones y debe ser atómica.

- `args`: `{ "mode": "portable", "rows": { "tasks.tabs": [ { "id": uuid, "fields": {…} } ], "tasks.families": […], … } }`. Las filas llegan ya remapeadas a uuid nuevos por la Edge (§6).
- Toca: inserta cada fila en orden canónico mediante `core.apply_row_op` (con el `role` del contexto); las filas con `deleted_at` en origen se insertan y se borran. Marca `set_config('tasks.import_mode', 'portable', true)` para que `TASK_BLOCKED` y `PROJECT_UNAVAILABLE` no rechacen estados históricos (una copia puede conservar tareas terminadas cuya condición se reabrió).
- Resultado: `{ "inserted": { "<tabla>": n } }`.
- Errores: `INVALID_IMPORT` (422: tabla desconocida, fila sin `id`, más de 20 000 filas), cualquier error de `apply_row_op` y cualquier error del hook de §4.2 (los ciclos, la jerarquía, el catálogo y los ámbitos se validan igual).
- Lista blanca: `core.allow_procedure('tasks', 'tasks.import_rows')`. **Solo lo invoca la ruta `portable/import`**: `beforeCommit` rechaza cualquier `call` que llegue por `/commands` (`INVALID_OPERATION`).
- No se puede deshacer con «Deshacer»; se revierte enviando a la papelera las áreas importadas (C11 lo mejoraría).

«Vaciar papelera» no es un procedimiento de Tasks: ver ruta `trash/empty` en §6.

---

## 4. Hooks de validación

### 4.1 `beforeCommit` (TypeScript, `packages/domain-tasks/validate.ts`)

El mismo código corre en el cliente antes de encolar (el error aparece al instante y el lote no entra en la cola) y en la Edge antes de `core.commit`. Solo ve las operaciones y el contexto; no lee la base.

| Regla | Código (422 salvo indicación) |
|---|---|
| `call` recibido por `/commands` | `INVALID_OPERATION` |
| Más de una operación sobre la misma `(tabla, id)` | `DUPLICATE_OPERATION` |
| `insert` sin sus columnas obligatorias (`tab_id`, `project_id`, `title`, `name`, `position`…) | `REQUIRED_NAME`, `REQUIRED_TEXT`, `INVALID_FIELDS` |
| Textos vacíos tras `trim` o fuera de longitud; `note` no textual | `REQUIRED_NAME`, `REQUIRED_TEXT`, `INVALID_NOTE` |
| Referencias (`*_id`) que no son uuid | `INVALID_ID` |
| `color` distinto de `null` o `#rrggbb` (obligatorio en familias) | `INVALID_COLOR`, `INVALID_FAMILY` |
| `budget`/`cost` no numérico, no finito o negativo | `INVALID_AMOUNT` |
| `due` que no es una fecha `YYYY-MM-DD` real | `INVALID_DATE` |
| `priority`, `status`, `system`, `system_key` fuera de su lista | `INVALID_PRIORITY`, `INVALID_STATUS`, `INVALID_FIELDS` |
| `done`, `archived` no booleanos; `position` no finito | `INVALID_DONE`, `INVALID_FLAG`, `INVALID_ORDER` |
| `saved_views`: nombre, `search`, forma de `filters` y `group_by` | `INVALID_VIEW` |
| `attachments`: `mime` no admitido, `size` fuera de límite, `sha256` mal formado | `INVALID_ATTACHMENT` |
| `delete`/`restore` sobre `families` o `labels` | `ARCHIVE_REQUIRED` |
| Escritura que el ámbito del contexto ya permite descartar (acceso por proyecto sobre `tabs`, `families`, `labels`, `saved_views`, o sobre una fila cuyo `tab_id`/`project_id` del propio `insert` queda fuera) | `FORBIDDEN` (403) |

### 4.2 `validate_hooks` SQL

Un único hook registrado, `tasks.validate_batch(jsonb)`, porque `core.commit` recorre `core.validate_hooks` sin orden definido. Llama en este orden a las comprobaciones siguientes. Trabaja sobre **las filas tocadas por el lote** (antes y después) y el estado final: lee `core.changes` del cursor del lote y los `scopes` del actor en `core.memberships` (lecturas que el lint admite desde C1).

Es la autoridad de las reglas de dominio: se ejecuta dentro de la transacción (sin carrera entre comprobar y escribir) y también cuando el lote viene de un deshacer o de `tasks.import_rows`, casos en los que `beforeCommit` no corre.

**a) `tasks.check_scope` · ámbitos de escritura** → `FORBIDDEN` (403). Con `full(tab)` y `proj(tab, project)` de §5:

| Tabla | Regla para el actor |
|---|---|
| `tabs` | `insert`: `scopes = "*"`. Resto: `full(id)`. (El rol `owner` ya lo exige `writable_roles`.) |
| `families`, `labels`, `saved_views` | `full(tab_id)` |
| `projects` | `insert`: `full(tab_id)`. Resto: `proj(tab_id, id)` |
| `tasks` | `proj` sobre el `project_id` de antes **y** el de después (mover exige permiso en origen y destino) |
| `task_labels`, `project_labels`, `attachments` | `proj` sobre el `project_id` de antes y de después |
| `task_dependencies` | lo anterior y, en `insert`/`restore`, `proj` sobre el proyecto de `depends_on_id` («una dependencia está fuera de tu acceso») |

**b) `tasks.check_structure`**

| Código | Invariante |
|---|---|
| `LAST_ACTIVE_TAB` | si existe alguna área, al menos una está viva |
| `INBOX_PROTECTED` | cada área viva tiene exactamente un proyecto `system='inbox'`, vivo, no archivado y con título `Entrada` |
| `TAB_DELETED` | no se toca contenido de un área que ya estaba borrada antes del lote («restaura el área antes de editar su contenido») |
| `PROJECT_UNAVAILABLE` | no se crean tareas ni se mueven a un proyecto borrado o archivado (salvo `tasks.import_mode`) |
| `INVALID_PARENT` | el padre no tiene padre a su vez; una hija viva está en el mismo proyecto que su padre y no cuelga de un padre borrado. Una hija que estaba en la papelera cuando su padre cambió de proyecto no se puede restaurar tal cual: se restaura con `fields` (contrato §4.2), bien con el `project_id` de su padre (`restoreTaskOps`), bien suelta con `parent_id: null` (lo que hace la interfaz heredada) |
| `INCONSISTENT_KEYS` | `tab_id` de cada fila = el de su área real; `project_id` de `task_labels`, `task_dependencies` y `attachments` **vivos** = el de su tarea. Las filas en papelera conservan el proyecto que tenían (el núcleo no deja actualizarlas): no se reutilizan si quedaron en otro proyecto, se inserta una fila nueva |

**c) `tasks.check_catalog`**

| Código | Invariante |
|---|---|
| `INVALID_LABEL` | la familia de una etiqueta es de su misma área |
| `INVALID_LABEL_PARENT` | la etiqueta superior es de la misma área y la cadena de superiores no forma ciclo. Desde la migración 0304, al crear una etiqueta con padre o cambiarle el padre: el padre es de la **misma familia** y no tiene padre (dos niveles como máximo), y una etiqueta con hijas no puede tener padre |
| `FAMILY_ARCHIVED` | ninguna etiqueta activa en una familia archivada |
| `INVALID_LABELS` | `task_labels`/`project_labels` vivas apuntan a etiquetas de la misma área |
| `LABEL_IN_USE` | ninguna fila viva (`task_labels`, `project_labels`, `owner_label_id`, `parent_id`) referencia una etiqueta o familia con `deleted_at` |
| `INVALID_OWNER` | `owner_label_id` es una etiqueta de la familia `system_key='person'` de la misma área. Esa marca («familia de responsables») se puede mover a otra familia sin clave de sistema (migración 0304); quien la mueve quita en el mismo lote los responsables de la familia anterior |
| `INVALID_VIEW` | `filters` y `group_by` solo referencian proyectos, familias y etiquetas de su área |

**d) `tasks.check_dependencies`** (solo si el lote tocó `task_dependencies`, `parent_id` o creó/restauró tareas)

| Código | Invariante |
|---|---|
| `INVALID_DEPENDENCIES` | ambas tareas existen y son de la misma área; sin autodependencia ni arista viva duplicada |
| `DEPENDENCY_CYCLE` | el grafo de cada área afectada es acíclico con las aristas de `domain.mjs`: tarea → cada dependencia **efectiva** (las suyas y las de su padre) y padre → hija. Incluye ciclos inducidos por la jerarquía (padre→su hija, hija→su padre) |

**e) `tasks.check_completion`** → `TASK_BLOCKED` (422), detalles `{taskId, blockedBy}` con solo los bloqueos de proyectos accesibles para el actor. Para cada tarea hoja viva, de proyecto vivo, que el lote deja con `done = true` y antes no lo estaba: todas sus dependencias efectivas deben existir, estar vivas, en proyecto vivo y hechas (hecha = `done`, o todas sus hijas vivas hechas si es padre). Se evalúa el estado final, así que completar un padre y sus condiciones en un mismo lote funciona. No se aplica con `tasks.import_mode`. Reabrir una condición no reabre lo ya terminado.

**f) `tasks.check_attachments`** → `FILE_NOT_UPLOADED` (422): `file_id` corresponde a un archivo verificado de la app `tasks` en `core.files` cuyo `sha256` y `size` coinciden.

### 4.3 Errores de dominio

Además de los del núcleo: 403 `FORBIDDEN`; 422 `REQUIRED_NAME`, `REQUIRED_TEXT`, `INVALID_ID`, `INVALID_COLOR`, `INVALID_AMOUNT`, `INVALID_DATE`, `INVALID_PRIORITY`, `INVALID_STATUS`, `INVALID_DONE`, `INVALID_FLAG`, `INVALID_ORDER`, `INVALID_NOTE`, `INVALID_FAMILY`, `INVALID_LABEL`, `INVALID_LABEL_PARENT`, `INVALID_LABELS`, `INVALID_OWNER`, `INVALID_VIEW`, `INVALID_ATTACHMENT`, `INVALID_PARENT`, `INVALID_DEPENDENCIES`, `DEPENDENCY_CYCLE`, `TASK_BLOCKED`, `PROJECT_UNAVAILABLE`, `TAB_DELETED`, `LAST_ACTIVE_TAB`, `INBOX_PROTECTED`, `FAMILY_ARCHIVED`, `ARCHIVE_REQUIRED`, `LABEL_IN_USE`, `INCONSISTENT_KEYS`, `IMMUTABLE_FIELD`, `DUPLICATE_OPERATION`, `FILE_NOT_UPLOADED`, `INVALID_IMPORT`. Se conservan los nombres de `domain.mjs` para que los mensajes de la interfaz sigan valiendo; los textos en castellano se añaden a los mensajes de `tasks-api`.

---

## 5. Visibilidad

### 5.1 Formato de `core.memberships.scopes`

Se conserva el actual:

```jsonc
"*"                                   // toda la app, incluidas áreas futuras
["<tabId>", "<tabId>"]                // áreas completas (forma heredada)
{ "tabs": ["<tabId>"],                // áreas completas
  "projects": { "<tabId>": ["<projectId>", "…"] } }   // proyectos sueltos por área
```

`null` equivale a `"*"` (es lo que crea `core.set_membership` cuando no se indican ámbitos, igual que en las demás apps). Cualquier otra forma se trata como sin acceso. Administrador = `owner` humano con `"*"`.

### 5.2 `visible(table, row, ctx)`

```ts
const full = (s, tab) => s == null || s === '*' || (Array.isArray(s) ? s.includes(tab) : !!s.tabs?.includes(tab));
const proj = (s, tab, project) => full(s, tab) || (!Array.isArray(s) && !!s?.projects?.[tab]?.includes(project));
const some = (s, tab) => full(s, tab) || (!Array.isArray(s) && !!s?.projects?.[tab]?.length);

export function visible(table, row, { membership: { scopes: s } }) {
  switch (table) {
    case 'tasks.tabs':        return some(s, row.id);
    case 'tasks.families':
    case 'tasks.labels':      return some(s, row.tab_id);
    case 'tasks.saved_views': return full(s, row.tab_id);
    case 'tasks.projects':    return proj(s, row.tab_id, row.id);
    default:                  return proj(s, row.tab_id, row.project_id); // tasks, puentes, dependencias, adjuntos
  }
}
```

Mismas funciones en SQL (`tasks.scope_full`, `tasks.scope_project`) para el hook de §4.2. Viven en `domain-tasks` y las usa también el cliente para marcar un área como `restricted` (acceso por proyecto) y desactivar lo que no puede hacer.

Qué ve y hace un acceso por proyecto: su área sin vistas guardadas, sus proyectos (también archivados o borrados, para poder recuperarlos), las tareas, etiquetas aplicadas, dependencias y adjuntos de esos proyectos, y **el catálogo completo de familias y etiquetas del área en solo lectura** (decisión D1 de §15: hoy solo recibe las etiquetas ya usadas en sus proyectos). Puede crear, editar, completar, borrar, restaurar y ordenar tareas en sus proyectos y editarlos; no crea proyectos ni áreas, no toca el catálogo ni las vistas.

### 5.3 Bloqueos privados

Una dependencia es visible si lo es el proyecto de `task_id`, aunque `depends_on_id` apunte a una tarea de un proyecto privado: esa tarea no llega al espejo. El cliente la presenta como «bloqueada por una tarea a la que no tienes acceso», sin título ni proyecto. Si esa condición oculta está cumplida lo dice la ruta `GET blockers` (§6), cuya última respuesta se guarda en local; sin dato, la tarea se considera bloqueada. El servidor es quien decide en todo caso (`TASK_BLOCKED`), con `blockedBy` limitado a lo que el actor puede ver.

### 5.4 Lo que el núcleo aún no resuelve

- **Fila que sale del ámbito** (tarea movida a un proyecto privado): `_kit` filtra el cambio y el espejo conserva la copia vieja para siempre. Hace falta que `changes` emita una retirada (C2).
- **Cambio de `scopes` o de rol**: las filas no cambian, así que el espejo no se entera. Hace falta resincronizar cuando cambia `membership.revision` (C3).
- **Plan de deshacer**: `undo-plan` no aplica `visible` y devuelve valores anteriores de filas ajenas al ámbito; el `undo` sí queda protegido por `tasks.check_scope` (C2).
- **`files/{id}`**: solo comprueba la pertenencia a la app. Tasks no usa esa ruta (sirve adjuntos por `attachments/:id`), pero sigue alcanzable (C5).

---

## 6. Rutas propias (`/api/v1/...`)

Todas con `Authorization: Bearer`, sobre el contexto de `_kit`. Las lecturas compuestas se resuelven en la Edge con `sync.snapshot` (que ya aplica `visible`) y `domain-tasks`; no hay SQL propio expuesto por PostgREST.

| Método y ruta | Rol mínimo | Entrada → salida | Errores |
|---|---|---|---|
| `GET tree` | reader | → `{cursor, tabs:[…]}`: árbol anidado (área → familias, etiquetas, vistas, proyectos → tareas) con `done`, `blocked`, `blockedBy`, `hiddenBlockers` calculados. Para otras apps, pruebas y futuros agentes; la interfaz se compone desde el espejo | — |
| `GET tabs/:tabId/tasks` | reader | `q, state=pending\|done, availability=ready\|blocked, projectId, label (repetible), family.<id>, includeDeleted, limit≤500, offset` → `{items, total}` | `NOT_FOUND`, `INVALID_FILTER` |
| `GET blockers` | reader | → `{cursor, items:[{taskId, hidden}]}`: por cada tarea visible, cuántas condiciones no cumplidas están fuera del ámbito. Vacío con acceso completo | — |
| `GET read/tasks.targets` | reader | lectura registrada (`core.allow_read('tasks', 'tasks.targets', 'function')`). `args` opcionales: `{kind: tab\|project\|task, id}` para validar un destino, `{tabId}` para limitar a un área → `{tabs:[{id, name, color, revision, deleted, projects:[{id, title, status, system, color, revision, deleted, tasks:[{id, parentId, title, done, revision, deleted}]}]}]}` (por defecto sin papelera ni proyectos archivados; `includeDeleted`, `includeArchived`), o un único `{kind, id, tabId, projectId, title, revision, deleted, archived}` con `kind` + `id`. Limitado a lo visible para el usuario | `NOT_FOUND` con `kind` + `id` si no existe o no es visible |
| `GET attachments/:id` | reader | → bytes del archivo (`Content-Disposition` con `name`), tras comprobar que la fila de `tasks.attachments` es visible | `NOT_FOUND` |
| `GET csv?tabId=` | reader | → `text/csv` con las tareas visibles del área | `NOT_FOUND` |
| `POST csv/preview?tabId=` | editor con área completa | cuerpo `text/csv` ≤ 2 MB → `{operations: RowOperation[], summary:{projects, tasks, labels}, warnings}`. No escribe: el cliente envía `operations` por `commands` (se puede deshacer). Un nivel de hijas | `FORBIDDEN`, `PAYLOAD_TOO_LARGE`, `INVALID_CSV`, `CSV_TOO_LARGE` (> 500 operaciones) y los de §4.1 |
| `GET portable` | reader | → ZIP: `manifest.json` (formato `ikisai.tasks.portable.v2`, hashes), filas visibles por tabla y archivos | — |
| `POST portable/preview` | administrador | ZIP ≤ 32 MB → `{ticket, expiresAt, summary:{tabs, projects, tasks, files}, unresolved:[…]}`. Verifica hashes, remapea todos los `id` y rechaza dependencias externas sin resolver. El paquete queda en `ikisai-files/tasks/imports/<sha256>.zip`; `ticket` es `{sha256, exp}` firmado con HMAC (sin tabla propia) | `FORBIDDEN`, `BUNDLE_TOO_LARGE`, `INVALID_BUNDLE`, `UNRESOLVED_DEPENDENCIES` |
| `POST portable/import` | administrador | `{ticket, requestId}` → sube los archivos, los registra y ejecuta `call tasks.import_rows` → `{cursor, inserted}`. Reintento con el mismo `requestId` = mismo resultado (recibo del núcleo) | `IMPORT_UNAVAILABLE` (ticket caducado o alterado) y los de §3.2 |
| `GET backup` | administrador | → ZIP como `portable` pero con todas las áreas y la papelera. Copia de comodidad; el respaldo cifrado sigue siendo el de Core | `FORBIDDEN` |
| `POST trash/empty` | owner con `"*"` | `{requestId}` → borra lógicamente (un `commit`) el contenido vivo de áreas y proyectos en papelera y después llama a `core.purge_deleted` con las tablas en orden canónico inverso → `{purged, cursor}` | `FORBIDDEN` |
| `POST worker/imports/cleanup` | planificador (`X-Ikisai-Worker-Key`, sin usuario) | Borra de Storage los paquetes de `tasks/imports/` vencidos hace más de diez minutos → `{deleted, kept}`. Hasta mil por pasada, los más antiguos primero | `UNAUTHENTICATED` |

La interfaz usa `trash/empty` y no `trash/purge` del núcleo, porque purgar un proyecto borrado con tareas vivas dejaría filas huérfanas o violaría FK (C10).

Rutas heredadas que **no** porta Tasks: `state`/`export` (sustituidas por `snapshot` + `tree`), el CRUD REST `tabs/:id/<colección>` de escritura (todo va por `commands`), `users*`, `auth/sessions*` (C7), `accesses*`, `proposals*`, `access-log`, `/mcp` (fase de agentes).

---

## 7. Proyecciones y enlaces

- **Proyecciones:** ninguna en V1. Según el contrato §8, Invoices valida y lista destinos de Tasks llamando a su API con el token del usuario, de modo que los ámbitos se respetan solos.
- **Destinos tipados que Tasks acepta:** `target_app = 'tasks'`, `target_kind ∈ {'tab','project','task'}`, `target_id` uuid, `target_revision` = `revision` devuelta por `GET read/tasks.targets`, que sirve tanto para elegir destino (árbol área → proyecto → tarea) como para validar uno (`args.kind` + `args.id`). Un destino borrado o archivado sigue resolviéndose (`deleted`, `archived`) para que el enlace no se rompa.
- **Enlaces que Tasks consume:** ninguno. «Crear tarea desde Booking/Food» es V2 y será una petición de esas apps a `commands` de Tasks con el token del usuario.

---

## 8. Archivos

- Bucket `ikisai-files` (se conserva), rutas del núcleo `tasks/<año>/<fileId>/<nombre>`; los paquetes de importación en `tasks/imports/` (los retira `worker/imports/cleanup` cuando vencen).
- `uploads: { bucket: 'ikisai-files', maxBytes: 25 MB, allowedMime }` con `allowedMime` = imágenes (`image/webp`, `image/jpeg`, `image/png`), `application/pdf`, texto y CSV, ofimática (OOXML y OpenDocument) y `application/zip`. 25 MB es el techo hasta el que la Edge verifica el hash (D5).
- Fotos: se recomprimen en el cliente antes de encolarse (lado mayor 1600 px, WebP de calidad media, sin conservar el original; contrato §11.3). `photos.js` ya lo hace a 1600 px; se ajusta para emitir siempre WebP y entregar un `Blob` en lugar de un `data:` URL.
- Flujo: `client.stageBlob(blob)` → `sha256`; el `insert` en `tasks.attachments` viaja con `blobs` y se envía solo cuando la subida está verificada. El `file_id` lo rellena `sync-client` tras la subida (C5).
- Lectura: `GET attachments/:id` con comprobación de ámbito. El adaptador guarda en local lo descargado para abrirlo sin red.
- Borrar un adjunto es `delete` de su fila; el objeto permanece en el bucket (historial íntegro).

---

## 9. Pantallas y navegación

La interfaz actual se conserva sin cambios de marcado (`taskRow`, `projectCard`, `projectView`, `topbar`, `searchbar` son contrato con el agente de UI), con su navegación y su menú de cinco grupos tal como están. Vistas (`state.view`): **Inicio** (`home`: indicadores, proyectos, semana, personas, bloqueos y actividad del área), **Proyectos** (`projects`: tarjetas fijables y ordenables; `project`: página del proyecto en lista o tablero por fecha, alta en línea, lote; `inbox` es el acceso directo a Entrada), **Tareas** (`tasks`: todas o «Mis tareas», con filtros combinables, disponibilidad y vistas guardadas) y **Etiquetas** (`labels`: familias y etiquetas del área). Además, el área «General» que reúne todas las áreas, la paleta Ctrl K, el tema claro/oscuro y el acento derivado del color del área o proyecto.

Modo lectura primero: todo se abre en lectura y se edita en línea o en hoja; móvil con barra inferior y hojas inferiores, escritorio con barra lateral y diálogos arriba al centro. Sin cambios funcionales en esta fase.

---

## 10. Offline

- **Espejo local:** las diez tablas de §2 (todas las legibles del `bootstrap`). Base `ikisai-tasks-v1` de `sync-client`.
- **Sin red se puede:** todo lo que es operación de fila: crear, editar, completar, mover, ordenar, borrar y restaurar áreas, proyectos y tareas; etiquetas y dependencias; catálogo; vistas guardadas; adjuntar (el blob espera en la cola de blobs); importar JSON y texto de Keep; duplicar proyectos y plantillas. La validación local (`domain-tasks`: tipos, ciclos, bloqueo, jerarquía) es la misma del servidor y se aplica antes de encolar.
- **Solo con red:** historial y deshacer, CSV, copia portable, respaldo, vaciar papelera, cuentas y sesiones, refresco de bloqueos privados, y abrir adjuntos nunca descargados en el dispositivo.
- **Adjuntos:** el comando que referencia un blob no se envía hasta verificar la subida; si falla, la interfaz lo dice y el comando sigue en cola.
- **Pendientes y conflictos:** la insignia `#syncBadge` muestra red, lotes pendientes, conflictos y rechazos (§13.4). «Al día» solo cuando el servidor ha confirmado. Campos disjuntos se fusionan solos con aviso discreto; los solapados abren «Revisar cambios» campo a campo; un `delete` contra una fila modificada pide confirmación. Un lote rechazado por el servidor (por ejemplo `TASK_BLOCKED` porque la condición se reabrió mientras se trabajaba sin red) no se pierde: queda en «Revisar lote fallido» para exportarlo o descartarlo (C6).
- **Un escritor por navegador:** se conserva el candado `navigator.locks` `ikisai-writer`; las demás pestañas quedan en solo lectura y reciben el estado por `BroadcastChannel`.
- **Cambio de cuenta:** no se admite entrar con otro usuario mientras haya cola pendiente; cerrar sesión exige cola vacía y borra espejo y adjuntos locales (C3).

---

## 11. Aceptación

### 11.1 No regresión: los 72 escenarios de `tests/integration.cjs`

Se migran a Playwright test runner en `tests/tasks/e2e`, contra `tasks-api` sobre PGlite (`packages/test-kit`) en lugar del servidor Python. La semilla `demo.json` se convierte en un fixture con uuid deterministas y un mapa `alias → uuid` (`p1`, `t2`, `ikisai`…) para no reescribir los selectores. El acceso inicial es por correo y contraseña sintéticos en vez de clave.

Marca: **=** se porta tal cual · **A** adaptado (misma intención, mecanismo nuevo) · **D** diferido a otra fase.

| # | Escenario | | Nota |
|---|---|---|---|
| 1 | Arranque autenticado y semilla del servidor | A | Entrada por cuenta; semilla PGlite |
| 2 | Botón de filtros con recuento y nombre accesible | = | |
| 3 | Crear tarea desde la interfaz persiste por la API | = | |
| 4 | Crear etiqueta dentro del selector conserva el borrador | = | |
| 5 | Renombrar, archivar y restaurar etiqueta conserva id y referencias | = | |
| 6 | Menú móvil con cinco grupos e iconos | = | |
| 7 | Un segundo dispositivo ve los datos canónicos | = | |
| 8 | Edición sin red y recarga conservan cola y shell | = | |
| 9 | Al reconectar se sincroniza lo hecho sin red | = | |
| 10 | Ediciones concurrentes de campos distintos se fusionan | = | Rebase de `sync-client` |
| 11 | Ediciones del mismo campo exigen resolución explícita | A | Hoja de conflicto sobre `conflicts()` |
| 12 | Mover entre proyectos confirma y refresca | = | |
| 13 | Un área nueva conserva una Entrada protegida | = | |
| 14 | Jerarquía: completar, borrar y restaurar | = | |
| 15 | Responsable y adjuntos persisten; el adjunto descargado se abre sin red | A | Subida por ticket; `attachments/:id` |
| 16 | Protecciones de edición de Entrada | = | |
| 17 | Una sola pestaña escribe en la cola compartida | A | Pestañas secundarias sin cliente |
| 18 | Lector: interfaz y API en solo lectura | = | |
| 19 | Renombrar, borrar y restaurar un área conserva su contenido | = | |
| 20 | Orden de proyectos por menú y arrastre entre dispositivos | = | |
| 21 | Agrupación por familia y filtros combinables guardados y reabiertos | = | |
| 22 | Vistas guardadas: borrado y restauración | = | |
| 23 | Importar texto de Keep: casillas, niveles y padre calculado | = | |
| 24 | El propietario descarga el respaldo completo en ZIP | A | `GET backup` sobre `tasks.*` |
| 25 | Shell, agrupación y vistas sobreviven a una recarga sin red | = | |
| 26 | Maquetación móvil sin errores de JavaScript | = | |
| 27 | El propietario crea un editor limitado a un proyecto | A | Cuenta con ámbitos, no clave (C7, D6) |
| 28 | El invitado solo ve su proyecto, crea tareas y no toca lo privado ni el catálogo | A | Por cuenta; catálogo según D1 |
| 29 | Operación destructiva de un agente espera aprobación humana | D | Fase de agentes |
| 30 | Revocar el acceso del invitado y rechazo del servidor | A | Retirar membresía y cerrar sesiones (C7) |
| 31 | Historial de tarea con antes y después; deshacer revisado | A | `history` del núcleo traducido (§13.3, C8) |
| 32 | Copia portable: descarga, previsualización e importación independiente | A | Formato v2 |
| 33 | CSV: previsualizar, importar un nivel de hijas y exportar | A | `preview` devuelve operaciones de fila |
| 34 | Cuenta con contraseña limitada a un proyecto entra desde el móvil | A | C7 |
| 35 | Respuesta perdida tras confirmar: reintento exacto sin duplicar | = | Recibos del núcleo |
| 36 | Sesión caducada conserva la cola; la misma cuenta reenvía | A | C3 |
| 37 | Cerrar sesión borra datos locales; registro de accesos | A / D | Limpieza: C3. Registro: fase de agentes |
| 38 | Escritorio: barra lateral, ancho completo y diálogos arriba | = | |
| 39 | Al estrechar vuelve la navegación inferior | = | |
| 40 | Borrador de proyecto y etiqueta nueva sobreviven a una sincronización | = | |
| 41 | Una edición remota solapada mantiene el borrador y no sobrescribe | = | `editorFields` |
| 42 | El editor guarda solo lo cambiado y conserva una edición remota ajena | = | |
| 43 | Dependencias entre proyectos; completar bloqueada se rechaza en interfaz y API | = | `TASK_BLOCKED` vía `commands` |
| 44 | Filtros de disponibilidad en interfaz y REST | A | `GET tabs/:tabId/tasks` |
| 45 | Una dependencia circular mantiene el borrador y no entra en la cola | = | Validación local |
| 46 | La selección de dependencias sobrevive al selector de etiquetas | = | |
| 47 | Disponibilidad muestra hijas y deja al padre de contexto no accionable | = | |
| 48 | Condiciones del padre heredadas y explicadas en las hijas | = | |
| 49 | Dependencias y finalización en secuencia sobreviven sin red | = | |
| 50 | Condición reabierta en remoto rechaza la finalización sin red y conserva el lote | A | C6 |
| 51 | Selector de dependencias en móvil sin desbordes | = | |
| 52 | Copia JSON remapea dependencias y etiquetas | = | |
| 53 | Importar JSON rechaza dependencias externas sin resolver | = | |
| 54–67 | Filtros en vivo, «Todas», tema, área General, alta en línea, edición en sitio, fijar y colores, barra de facetas, lote, duplicar y plantillas, alias y recuentos, coste y presupuesto, un único evento atómico, coste vaciado | = | 60, 65 y 66 comprueban además lo guardado en el servidor; 62 y 66, un solo lote |
| 68 | Completar ofrece Deshacer; atajos de teclado | A | Deshacer del núcleo |
| 69 | Inicio: indicadores, semana, personas, bloqueos y actividad | A | Actividad desde `history` traducido |
| 70 | Acento derivado, barra de prioridad y chips pastel | = | |
| 71 | Paleta Ctrl K y tablero por fecha | = | |
| 72 | Las copias conservan dependencias externas de la misma área e importes | = | |

Resumen: 53 tal cual, 18 adaptados (uno de ellos, el 37, con una parte diferida) y 1 diferido. El 29 y la mitad del 37 vuelven con la fase de agentes.

También se portan `tests/cloud-browser.mjs` (sesión, refresco, edición, cola tras recarga, subida de documento, foto 3200→1600 px, reintento de importación, cierre de sesión) y `tests/updates.cjs` (6 escenarios de activación coordinada del service worker). `tests/cloud-api.mjs` y `tests/cloud-domain.mjs` se convierten en pruebas de `tasks-api` y de `domain-tasks`.

### 11.2 Conformidad y dominio (backend, PGlite)

1. Suite de conformidad del núcleo (`packages/test-kit`) contra `tasks-api`.
2. Una prueba por código de §4.3, incluido el lote completo rechazado sin cambios parciales.
3. Ciclos: directo, de varios pasos, por herencia del padre, padre→hija e hija→padre; al mover, al cambiar de nivel y al restaurar.
4. Bloqueo: una y varias condiciones, entre proyectos, condición padre, heredada, borrada, restaurada y reabierta; cascada de un padre en un lote.
5. Ámbitos: lector, editor por área, editor por proyecto; mover entre proyecto propio y ajeno; dependencia hacia proyecto ajeno; deshacer un lote con filas ajenas → 403.
6. Visibilidad en `snapshot`, `changes`, `history`, `tree`, `blockers`, `attachments`, `csv` y `portable`.
7. Importación portable: ida y vuelta, reintento idempotente, dependencias externas rechazadas.

### 11.3 Escenarios offline automatizados (Playwright)

Batería compartida del contrato §9 más los propios: corte de red durante la edición (8), recarga con cola (8, 25, 49), reconexión y vaciado (9), conflicto disjunto (10, 42), conflicto solapado (11, 41, 67), adjunto diferido (15), lote rechazado conservado (50), respuesta perdida (35), sesión caducada con cola (36), una sola pestaña escritora (17).

### 11.4 Definición de hecho

Recorrido manual en PC y Android sobre `tasks.ikisai.com`: entrar, crear área, proyecto y tareas con hijas, etiquetar, encadenar dependencias, trabajar sin red, reconectar, provocar y resolver un conflicto, adjuntar una foto, deshacer, invitar a una persona a un solo proyecto y comprobar lo que ve. Misma versión en `/api/v1/health` y `/version.json`.

---

## 12. Reparto entre agentes

| Agente | Directorios | Entrega |
|---|---|---|
| **Backend Tasks** | `supabase/migrations/*_tasks_*`, `supabase/functions/tasks-api`, `supabase/functions/_domain/tasks` (código de dominio; `packages/domain-tasks` solo lo reexporta), `tests/tasks` | Migraciones y hook SQL; `domain-tasks` (tipos de fila, `validate.ts`, `scopes.ts`, `graph.ts` con ciclos y estados, `ops.ts` con las operaciones compuestas de §3.1, `legacy.ts` con la composición fila ↔ modelo anidado); `tasks-api` con hooks y rutas de §6; pruebas de §11.2 |
| **Frontend Tasks** | `apps/tasks`, `tests/tasks/e2e` | Copia de `app/` a Vite/PWA con `_worker.js`; adaptador de §13; ajustes mínimos de los módulos (uuid, familia Persona, adjuntos como `Blob`); migración de los 72 escenarios, `cloud-browser` y `updates` |

Frontera: `supabase/functions/_domain/tasks` es del backend y es el único código que comparten; el frontend pide cambios por PR. El contrato entre ambos son §2–§6 de este documento y la firma de `ops.ts`/`legacy.ts`. El marcado de la interfaz se coordina con el agente de UI.

Orden: (1) `domain-tasks` con tipos, `scopes`, `validate` y `legacy`, que desbloquea a ambos; (2) en paralelo, backend: migraciones, hook y conformidad; frontend: adaptador contra el servidor simulado de `tests/sync-client/fake-server.ts`; (3) `tasks-api` con rutas de lectura y adjuntos, y frontend contra la API en PGlite; (4) CSV, portable y respaldo; (5) escenarios completos y publicación. Después, por verticales: cuentas y ámbitos, intercambio, agentes.

`docs/tasks/ESTADO.md` lo mantienen ambos.

---

## 13. Adaptador: de `sync.js` + `cloud-auth.js` a `packages/sync-client`

### 13.1 Planteamiento

La interfaz actual no habla con la API: muta un modelo anidado en memoria (`state.tabs`: área → `families`, `labels`, `views`, `projects[].tasks[]`) y llama a `save()`. `sync.js` calcula `differences(Sync.last, state.tabs)`, encola operaciones por entidad y, al sincronizar, vuelve a descargar el estado completo. El adaptador conserva ese contrato y cambia lo de debajo:

```text
módulos de UI ──(state.tabs, save(), api(), Sync.*)──▶ adaptador ──▶ sync-client ──▶ /api/v1
                                                          ▲                │
                               compose(filas) ◀── onTable ┘      espejo IndexedDB por tabla
```

- **Lectura:** `compose(rows)` (`domain-tasks/legacy.ts`) construye `state.tabs` desde el espejo con los nombres heredados (`text`, `order`, `parentId`, `labels[]`, `dependsOn[]`, `ownLabels[]`, `owner`, `family`, `parent`, `groupBy`, `deleted`, `deletedAt`, `version`, `attachments[]`, `system`, `restricted`) y los calculados `done` del padre, `blocked`, `blockedBy`, `hiddenBlockers`. Cada `onTable` recompone y llama a `adopt()` + `render()`, agrupado en un microtick.
- **Escritura:** `save()` hace `differences()` como hoy sobre el modelo anidado y `decompose(ops, rows)` traduce cada diferencia a operaciones de fila con `ops.ts` (§3.1); valida con `validate.ts`; y llama a `client.commit(rowOps, {requestId, blobs})`. Un `save()` = un lote = un evento atómico, como hoy.
- **Identificadores:** `uid(prefijo)` devuelve un uuid v4 puro, salvo para los prefijos de petición (`req-`, `undo-`, `csv-`, `import-`), que conservan el prefijo (válido para `requestId`).

Se entrega como `apps/tasks/src/adapter/` (TypeScript) empaquetado en un único script clásico `sync.js` que define los mismos globales, cargado en la misma posición (tras `cloud-config.js`, antes de `features.js`). `cloud-auth.js` deja de ser un parche condicional: su contenido (entrada por correo, «Mi cuenta», cambio de contraseña) pasa al adaptador y `window.IKISAI_CLOUD` es siempre `true`. El servidor local Python y la entrada por clave desaparecen.

### 13.2 Superficie que se conserva

Inventario obtenido buscando cada identificador en `app/*.js` e `index.html` fuera de `sync.js` y `cloud-auth.js`.

| Global | Lo usan | Implementación nueva |
|---|---|---|
| `Sync.token` | `features.js`, `history-ui.js`, `csv-ui.js`, `photos.js`, `accounts-ui.js` (peticiones `fetch` con `Bearer`) | *getter* de `client.session()?.token`; el adaptador fuerza el refresco antes de exponerlo (C9) |
| `Sync.actor` `{id, name, role, scopes, kind, session}` | `access-ui`, `accounts-ui`, `features` (`canEdit`), `navigation-ui`, `extras-ui`, `photos` | de `client.bootstrap()`: `profile.userId`, `displayName`, `membership.role`, `membership.scopes`, `profile.kind`; `session: true` |
| `Sync.mode` | `extras-ui`, pruebas (`Sync.mode==='online'`) | derivado de `SyncStatus` (§13.4) |
| `Sync.busy` | `accounts-ui`, `extras-ui`, `updates.js` | `status().network === 'syncing'` |
| `Sync.record.queue.length` | `accounts-ui`, `csv-ui`, `features`, `history-ui`, `extras-ui`, `updates.js` | `Sync.record.queue` es la lista sombra de lotes propios aún no confirmados; su longitud coincide con `status().pendingCommands` |
| `Sync.record.conflict`, `Sync.record.failure` | `updates.js` | primer elemento de `client.conflicts()` y primer lote rechazado (C6), con la forma heredada |
| `Sync.record` (asignación al cerrar sesión), `writeRecord()` | `accounts-ui.js` | *setter* que limpia la sombra; `writeRecord()` persiste el estado de interfaz |
| `Sync.last` | `dependencies-ui.js` (validar y revertir) | último modelo compuesto adoptado |
| `Sync.secondary` | `access-ui`, `accounts-ui`, `features`, `navigation-ui`, `updates.js` | igual: candado `navigator.locks` `ikisai-writer` |
| `Sync.updateLocked`, `Sync.chain` | `updates.js` | `updateLocked` detiene `client.sync()`; `chain` es la promesa de la última escritura local |
| `Sync.db` (store `attachments`) | `accounts-ui.js` (vaciar al salir) | base propia `ikisai-tasks-ui-v1` con los stores `app` (estado de interfaz y sombra) y `attachments` (blobs descargados) |
| `api(path, options)` | `access-ui`, `accounts-ui`, `csv-ui`, `extras-ui`, `history-ui`, `home-ui` | sobre `client.api()`, con traducción de rutas heredadas (§13.3) y errores con `.status` y `.details` como hoy |
| `save()` | `index.html` (23 usos) y ocho módulos; `dependencies-ui.js` lo envuelve | §13.1; sigue devolviendo `true`/`false` |
| `syncNow()` | `csv-ui`, `history-ui` | `client.sync()` |
| `setMode(mode)` | `accounts-ui`; `updates.js` lo envuelve | pinta `#syncBadge` (`data-mode`) y `#app[data-readonly]` |
| `persistUI()` | ocho módulos | guarda `{activeTab, view, currentProject, search, filters, groupBy}` en el store `app` |
| `adopt(tabs)`, `cloneModel` | `dependencies-ui`, `features`, `filters-ui`, `palette-ui` | sin cambios |
| `editorFields`, `editorExtraFields` | `index.html`, `navigation-ui.js` | sin cambios (funciones puras de borrador) |
| `cachedAttachment(id, write?)` | `photos.js` | sobre el store `attachments` |
| `pickedAttachment(file)` (`photos.js`) | editores de tarea y de proyecto | devuelve `{id, name, mime, size, sha256, url:'/api/v1/attachments/<id>'}` tras `client.stageBlob`; ya no hay `data:` |
| `loginSheet`, `logoutAccount`, `sessionsSheet`, `passwordSheet`, `userEditor`, `createAccessSheet` | `accounts-ui.js`, `access-ui.js` | versiones de `cloud-auth.js`, sobre `client.login/logout` y C7 |
| `showServerHistory`, `manageTab`, `showSync`, `showConflict`, `showFailure`, `exportLocal`, `importSheet`, `boot` | `history-ui`, `cards-ui`, `navigation-ui`, menú | misma función; `showConflict` y `showFailure` sobre `conflicts()` y C6 |
| Envolturas de `render`, `bind`, `handleTopAction`, `openTaskEditor`, `openProjectEditor`, `showTrash` | cadena de módulos posteriores | idénticas (solo lectura para `reader` y pestaña secundaria, responsable, adjuntos, áreas en papelera) |
| Interceptor de clics en `a[href^="/api/v1/attachments/"]` | adjuntos de editores | descarga con `Bearer`, caché local y apertura sin red |

Cambios mínimos fuera del adaptador: sustituir la comparación con el `id` fijo `'person'` por `family.system === 'person'` (dos puntos en `index.html` y uno en `extras-ui.js`; el cuarto está en el editor de proyecto, que ya es parte del adaptador).

### 13.3 Traducción de `api()`

| Ruta heredada | Nueva |
|---|---|
| `state` | no va a la red: `{actor, tabs, cursor}` compuesto del espejo tras `client.sync()` |
| `commands` (operaciones de `csv/preview`) | `client.commit(operations, {requestId})` |
| `history`, `history?kind=&id=&tabId=&before=` | `GET history` del núcleo (con los filtros de C8) y traducción de cada lote a `{cursor, at, actor, actorName, delta:[{kind, tabId, id, before, after}], undoOf, canUndo}`. `undoOf` se deduce del prefijo `undo-` del `requestId`; `canUndo` es falso para `reader` y para lotes con `call` o `purge` |
| `history/:n/undo-plan` (GET) | `POST history/:n/undo-plan`; las operaciones de fila se traducen a la forma heredada para la revisión |
| `history/:n/undo` | igual: `{requestId, planHash}` |
| `auth/login`, `auth/logout` | `client.login`, `client.logout` |
| `auth/password` `{currentPassword, password}` | `{currentPassword, newPassword}`; la interfaz sigue exigiendo 12 caracteres |
| `users*`, `auth/sessions*` | rutas de cuentas del núcleo (C7) |
| `portable/import`, y los `fetch` a `csv`, `csv/preview`, `portable`, `portable/preview`, `backup` | mismas rutas (§6) |
| `accesses*`, `proposals*`, `access-log` | fase de agentes: las entradas del menú se ocultan |

### 13.4 Estado, conflictos y rechazos

`Sync.mode` se deriva en este orden: `conflict` (hay `client.conflicts()`), `error` (hay lote rechazado o `lastError` que no es de red), `unauthorized` (sin sesión), `offline`, `syncing`, `pending` (`pendingCommands > 0`), `online`. La insignia muestra «Revisar cambios», «Revisar guardado», «Sin acceso», «Sin conexión», «Sincronizando», «N pendientes» o «Al día», como hoy.

- **Fusión automática:** la hace `sync-client`; el adaptador muestra el aviso discreto cuando sube `autoMerged`.
- **Conflicto solapado:** `showConflict` enseña `base`, `current` y `overlapping` campo a campo con los nombres heredados y ofrece «Conservar el servidor» (`resolveConflict(id, {choice:'theirs'})`), «Aplicar mis cambios» (`'mine'`) y «Revisar más tarde».
- **Borrador abierto:** `editorFields` sigue impidiendo que un guardado pise un campo cambiado en remoto mientras el editor estaba abierto.
- **Lote rechazado:** `showFailure` lista sus operaciones con «Exportar copia» y «Descartar este lote» (C6).
- **Copia local:** `exportLocal` exporta el modelo compuesto y la sombra de lotes pendientes en el formato `IkisaiTareasBackup`.

### 13.5 Arranque y cuentas

`boot()`: candado de escritor → abre la base propia → `createSyncClient({app:'tasks', apiBase:'/api/v1'})` → `client.start()`. Con espejo, pinta al instante; sin sesión, `loginSheet()`. Las pestañas secundarias no crean cliente: reciben del escritor `{tabs, actor, status}` por `BroadcastChannel('ikisai-tasks')`.

Reglas que hoy garantiza `sync.js` y deben mantenerse: no cambiar de usuario con cola pendiente; cerrar sesión solo con la cola vacía, borrando espejo, sombra y adjuntos locales; no cambiar la contraseña con cola pendiente. `sync-client` no las ofrece todavía (C3). `updates.js` sigue decidiendo cuándo es seguro activar una versión nueva leyendo `Sync.busy`, la cola, el conflicto y el rechazo.

---

## 14. Peticiones a Core

Resumen en `docs/core/PETICIONES.md`. **B** = bloquea lo indicado; **M** = mejora.

| # | | Petición | Motivo | Bloquea |
|---|---|---|---|---|
| C1 | B | Hooks SQL: añadir al payload `role`, `scopes` y `requestId`; helper `core.batch_changes(p_app, p_cursor)` (filas del lote con `before`/`after`) admitido por `lint_migrations`; orden determinista de `validate_hooks` | El lint impide a `tasks.*` leer `core.changes` y `core.memberships`; sin ello no hay `TASK_BLOCKED` por diferencia ni ámbitos en SQL. Alternativa propia para los cambios: triggers con tabla temporal. Para los ámbitos no hay alternativa atómica | Migraciones de Tasks |
| C2 | B | `changes` emite una retirada (`after: null`) cuando `visible(before)` y no `visible(after)` (requiere `before` en `core.changes_since`); `undo-plan` y `undo` aplican `visible` | §5.4: copias viejas permanentes y fuga de valores en el plan de deshacer | Accesos por proyecto (27, 28, 34) |
| C3 | B | `sync-client`: resincronizar (vaciar y `snapshot`) si cambia `membership.revision` o el usuario; `logout()` borra espejo y cola; `login` con otro usuario y cola pendiente → error; `resync()` público | Hoy `setSession` solo guarda el token: otra persona en el mismo navegador vería el espejo anterior | 30, 36, 37 |
| C4 | B | `_kit` `translate`: SQLSTATE de clase 22 y 23 → 422 `CONSTRAINT_VIOLATION`, no 503 | Un `check` no previsto deja la cola reintentando para siempre | Fiabilidad de las cuatro apps |
| C5 | B | Enlace comando ↔ archivo: `sync-client` sustituye `{"$file":"<sha256>"}` por el `fileId` tras verificar la subida (o helper `core.file_for(app, sha256)`); el lint admite `references core.files(id)`; hook de visibilidad en `files/{id}` | El comando se encola antes de existir el `fileId`; una tabla de app no puede resolverlo ni referenciarlo | Adjuntos (15) |
| C6 | B | `sync-client`: conservar los lotes rechazados (422, 403 de dominio, 404, 413, 428) en `rejected` con `rejected()`, `discardRejected()`, `retryRejected()`; `pending()` con los lotes en cola; aviso por lote confirmado o rechazado | Hoy un 422 retira el lote y revierte el espejo dejando solo `lastError`, y un 403 detiene la cola sin fin. Contrato §6.3: nada se pierde en silencio | 50 y `Sync.record.failure` |
| C7 | B | Cuentas en `_kit`: alta con correo y contraseña inicial, edición de nombre, rol y ámbitos, desactivación, restablecer contraseña, `GET/DELETE auth/sessions`; hook `validateScopes(scopes, ctx)` en `POST members` | Hoy `members` solo asigna pertenencia a un `userId` existente. Es común a las cuatro apps | 27, 30, 34, «Mi cuenta» |
| C8 | M | `history` con filtros `table`, `id`, `match=<columna>:<valor>` y `actorId` | Historial de una tarea o de un proyecto sin recorrer todo el log (el índice `changes_row_idx` ya existe) | 31 con paginación correcta |
| C9 | M | `client.fetch(path, init)` → `Response` con `Bearer` y refresco; opción de pestaña única | Descargas binarias (CSV, ZIP, adjuntos) no caben en `api<T>()` | — |
| C10 | M | Purga por app: orden de tablas o hook `beforePurge`, o poder desactivar `trash/purge` | Purgar un contenedor con hijos vivos | — |
| C11 | M | Deshacer lotes con `call` cuyas escrituras pasaron por `core.apply_row_op` | Importaciones reversibles | — |
| C12 | — | Constancia: `core.agent_keys`, `core.proposals`, `core.access_events` son necesarias para recuperar 29 y el registro de accesos de 37 | Ya previsto en PLAN §4 | Fase de agentes |

Lo que no depende de ninguna petición y puede empezar al aprobarse este documento: `domain-tasks`, las migraciones de tablas e invariantes que no necesitan el lote (ciclos, jerarquía, catálogo, Entrada), `tasks-api` con `visible` y rutas de lectura, y el adaptador para un propietario con acceso completo (escenarios marcados **=**).

---

## 15. Decisiones que se apartan de `PORT.md` o del comportamiento actual

| # | Decisión | Motivo | Quién confirma |
|---|---|---|---|
| D1 | Un acceso por proyecto ve en solo lectura **todo** el catálogo de familias y etiquetas de su área, no solo las etiquetas ya usadas en sus proyectos | Hace de `visible` una función pura de la fila; la regla actual es derivada y no se puede mantener con sincronización incremental. Además le deja etiquetar con cualquier etiqueta del área. Expone nombres de etiquetas (personas, oficios, espacios), no tareas | Usuario |
| D2 | `archived boolean` en familias y etiquetas y `status` en proyectos, en lugar de `archived_at`; `projects.system = 'inbox'` en lugar de `tabs.inbox_project_id`; sin `delete_batch` (mismo `deleted_at`); sin `color` en etiquetas (lo da la familia); se añade `tasks.attachments`, `tasks.project_labels` y `families.system_key` | Fidelidad al modelo que usa la interfaz; un booleano no depende del reloj del cliente sin red; se evita una FK circular | Core |
| D3 | Cascadas como operaciones de fila construidas en el cliente y verificadas por el hook; un único procedimiento | Los `call` no funcionan sin red ni se pueden deshacer (§3) | Core |
| D4 | `TASK_BLOCKED` y los ámbitos de escritura en el hook SQL, no en `beforeCommit` | `beforeCommit` no tiene acceso a la base, no es atómico y el deshacer lo omite | Core |
| D5 | Adjuntos hasta 25 MB y lista cerrada de tipos (hoy 1 MB y cualquier tipo) | El ticket de subida elimina el límite del cuerpo del comando | Usuario |
| D6 | Las claves de acceso para personas desaparecen: un invitado es una cuenta con ámbitos. Las claves quedan para agentes, en su fase | Un solo sistema de identidad (Supabase Auth + `core.memberships`) | Usuario |
| D7 | `scopes = null` equivale a `"*"` | Coherencia con `core.set_membership` y las demás apps | Core |
| D8 | El `done` almacenado de una tarea con hijas vivas se ignora en lugar de eliminarse | Una columna no puede estar «ausente»; evita un hook que rechazaría ediciones concurrentes legítimas | Core |

---

## 16. Resolución de Core (6 de octubre de 2026)

Fuente: `docs/core/RESPUESTAS.md`, PR #10 (núcleo G2) y #12 (`sync-client` 0.2). El seguimiento de las peticiones está en `docs/tasks/PETICIONES.md`.

| # | Resolución | Qué cambia en este documento |
|---|---|---|
| C1 | **Resuelta de otra forma.** El lint permite a `*_tasks_*` leer `core.memberships`, `core.changes`, `core.files` y `core.synced_tables` y llamar a `core.allow_read`. El payload del hook sigue siendo `{app, actor, cursor}` | `tasks.validate_batch` lee el lote en `core.changes` (`app = 'tasks'`, `cursor` del payload) y los ámbitos en `core.memberships`. No hacen falta `core.batch_changes` ni triggers de captura. Sigue siendo un único hook, por el orden |
| C2 | **Parcial.** `sync-client` 0.2 rehace el snapshot si cambia `membership.revision` o una tabla deja de ser legible | Queda abierto: una fila que sale del ámbito por un movimiento (tarea a un proyecto privado) no se retira del espejo hasta el siguiente snapshot, y `undo-plan` no aplica `visible`. Mitigación propia: el adaptador de un acceso por proyecto descarta al componer las filas cuyo proyecto ya no está en sus ámbitos |
| C3 | **Resuelta.** `clearOnLogout` y vaciado del espejo si entra otra persona (`USER_CHANGED`) | Tasks usa `clearOnLogout: true`. La regla «no cerrar sesión ni cambiar de cuenta con cola pendiente» la sigue aplicando el adaptador antes de llamar a `logout()` |
| C4 | **Resuelta.** Errores SQL como 422 definitivos (`CONSTRAINT_VIOLATION`, `INVALID_VALUE`, `DOMAIN_ERROR`, `SQL_ERROR`, con `details.sqlstate`) | Los hooks siguen usando `core.fail('<CÓDIGO>', 422)` para conservar el código de dominio (`TASK_BLOCKED`, `DEPENDENCY_CYCLE`…); un `raise exception` simple llegaría como `DOMAIN_ERROR` |
| C5 | **Resuelta.** Marcador `{"$blob": "<sha256>"}` en cualquier campo; referencia a `core.files` admitida | `tasks.attachments.file_id` se escribe con el marcador (§2.9). El hook de visibilidad en `files/{id}` sigue sin existir: Tasks sirve por `attachments/:id` |
| C6 | **Resuelta.** `rejected()`, `retryRejected()`, `discardRejected()`; `SyncStatus.rejected`; un 403 ya no detiene la cola | `Sync.record.failure` y `showFailure` (§13.4) salen de `rejected()`. No existe `pending()`: el adaptador mantiene su lista sombra |
| C7 | **Parcial.** `POST members/invite {email, role, scopes?, displayName?}` crea la cuenta con contraseña temporal (devuelta una sola vez) y la pertenencia | «Cuentas de personas» usa `GET members`, `POST members` y `POST members/invite`. La lista y el cierre de sesiones, restablecer contraseña y la desactivación quedan para más adelante: «Mi cuenta» ofrece cambio de contraseña y cierre de sesión |
| C8–C11 | Sin respuesta todavía (mejoras) | Sin cambio; no bloquean |

Convenciones nuevas que este documento adopta:

- **Código de dominio** en `supabase/functions/_domain/tasks/` (`mod.ts` y módulos); `packages/domain-tasks` solo lo reexporta. Donde el texto dice `domain-tasks` o `packages/domain-tasks`, léase ese código.
- **Lecturas registradas:** las funciones de lectura SQL de Tasks se registran con `core.allow_read('tasks', 'tasks.<fn>', 'function')`, reciben `{app, actor, role, args}` y se sirven en `GET/POST /api/v1/read/tasks.<fn>`. La primera es `tasks.targets` (§6, §7), que Invoices necesita. `tree`, `blockers` y `tabs/:tabId/tasks` podrán pasar a lecturas registradas si resulta más barato que componer en la Edge; se decide al implementar `tasks-api`.
- **`RequestContext.token`** disponible; Tasks no lo necesita porque no llama a otras apps.
- **Peticiones** en `docs/tasks/PETICIONES.md`.

Implementado en `supabase/migrations/20261006_0300_tasks_schema.sql` (tablas, triggers, registro) y `20261006_0301_tasks_rules.sql` (`tasks.scope_*`, `tasks.validate_batch`, `tasks.import_rows`, `tasks.targets`).

Orden de construcción (PR pequeñas dentro del territorio de Tasks): (1) `_domain/tasks` + `packages/domain-tasks`; (2) migraciones `*_tasks_*` con `tasks.validate_batch` y `tasks.targets`, con lint y conformidad; (3) `tasks-api` con `visible` y `beforeCommit`; (4) adaptador sobre `sync-client`.

---

## 17. El adaptador tal y como se ha construido (tanda 3)

Precisa §13 con lo que hay en `apps/tasks`. Donde difiera de §13, manda esta sección.

- **Dos piezas, no un único `sync.js`.** `src/core.ts` se compila a `/sync-core.js` (IIFE, `window.IkisaiTasks`) y contiene todo lo que tiene tipos y pruebas: `sync-client`, el dominio y una copia en memoria del espejo. `public/sync.js` sigue siendo un script clásico: es el pegamento con los globales de la interfaz y conserva casi literalmente las hojas y envolturas del original. `public/cloud-auth.js` sustituye las hojas de cuenta y arranca la app.
- **Guardar** (`save()`): `core.plan(state.tabs)` = `adoptLegacyIds` + `decompose` contra la copia en memoria + `validateOperations`; si falla, se readopta el último modelo y se avisa (el lote no entra en la cola). Si hay operaciones, `core.commit()` las aplica al instante a la copia en memoria y las encola; un `save()` son uno o dos lotes (dos solo cuando una misma fila cambia campos y además se borra o restaura).
- **`decompose` confía en el modelo.** La interfaz ya propaga en `state.tabs` el borrado a las hijas, la restauración a todo el lote (`deleteBatch` = `deleted_at`) y el archivo de familia a sus etiquetas. `decompose` solo garantiza, de forma idempotente, lo que el servidor exige: ninguna hija viva bajo un padre borrado, ninguna etiqueta activa en una familia archivada, y el `done` de un contenedor no se escribe. Repetir un guardado con el modelo aún sin refrescar no envía nada. (Sustituye a las cascadas por transición descritas en §3.1 para el camino de la interfaz; `ops.ts` las sigue ofreciendo a otros clientes.)
- **Revisiones encadenadas:** las operaciones del segundo lote llevan la misma `expectedRevision` que tenía el espejo; `sync-client` la ajusta al confirmar el primero.
- **Refresco:** cada cambio de tabla del espejo recarga la copia en memoria (nunca mientras haya un guardado local en vuelo), recompone el modelo y, solo si cambió, hace `adopt()` + `render()`.
- **Estado:** `Sync.mode` se deriva en el orden `conflict`, `error` (lote rechazado), `unauthorized`, `offline`, `syncing`, `pending`, `online`. `Sync.record.queue.length` = comandos en cola + guardados locales en vuelo. `Sync.record.conflict` y `Sync.record.failure` salen de `conflicts()` y `rejected()`.
- **Pestaña secundaria:** no arranca la sincronización; lee el espejo y se refresca por `BroadcastChannel('ikisai-tasks')`.
- **Primera entrada:** con la app vacía, el propietario con acceso completo ve «Primera área» (área + Entrada + familias en un lote).
- **Almacenamiento propio:** estado de interfaz en `localStorage` (`ikisai-tasks-ui`), adjuntos descargados en IndexedDB `ikisai-tasks-ui-v1`, bloqueos privados en `localStorage`. El espejo es `ikisai-tasks-v1`, de `sync-client`, con `clearOnLogout: true`.
- **Historial:** se piden hasta 200 lotes a `history` y el filtro por tarea o proyecto se aplica en el cliente (hasta que exista C8). `canUndo` es falso para lectores y para lotes con `call` o `purge`.
- **Menú:** CSV, copia portable, respaldo, cuentas, accesos, propuestas y registro de accesos están ocultos hasta que existan sus rutas o su fase.
- **Pruebas de extremo a extremo:** `tests/tasks/e2e-server.ts` sirve `apps/tasks/dist` y atiende `/api/v1` con la `tasks-api` real sobre PGlite; `tests/tasks/app.spec.ts` lleva el número del escenario original en cada paso.
- **Consulta e intercambio** (`supabase/functions/tasks-api/exchange.ts`, tanda 4). Todas las rutas componen el modelo anidado con lo que el usuario puede ver:
  - `GET tabs/:tabId/tasks` con `q`, `state`, `availability`, `projectId`, `label`, `includeDeleted`, `limit`, `offset`.
  - `GET csv?tabId=` y `POST csv/preview?tabId=`: mismo formato de columnas que la app anterior; la familia de una etiqueta se escribe por su clave de sistema o, si es propia, por su nombre. La previsualización aplica el CSV al modelo, pasa por `decompose` y devuelve un único lote de operaciones de fila que el cliente confirma por la cola (se puede deshacer).
  - `GET portable` y `GET backup` (este, solo administrador): ZIP sin compresión con `manifest.json` (formato `ikisai.tasks.portable.v2`, huellas), `data.json` (`{tabs}` en el modelo anidado) y `files/<sha256>`.
  - `POST portable/preview`: verifica huellas y dependencias, guarda el paquete en `ikisai-files/tasks/imports/<caducidad>.<sha256>.zip` y devuelve ese identificador como `ticket` (sin HMAC: el paquete se direcciona por su contenido y solo un administrador puede previsualizar e importar).
  - `POST portable/import {ticket, requestId}`: remapea todos los ids de forma determinista (hash de `ticket` + id de origen), reutiliza el archivo verificado con la misma huella si ya existe, y confirma con `call tasks.import_rows`. Las áreas importadas llevan el sufijo « (copia)»; lo que estaba en la papelera sigue en la papelera.
  - `POST trash/empty {requestId}` (propietaria con acceso completo): `call tasks.empty_trash_prepare` (migración `0303`) pasa a la papelera, fila a fila, todo lo que cuelga de contenedores borrados (tareas de un proyecto borrado, contenido de un área borrada, etiquetas, dependencias y adjuntos de tareas borradas) y después `core.purge_deleted` purga las diez tablas en orden canónico inverso. Las dependencias hacia una tarea purgada desaparecen con ella. Durante ese lote el hook no aplica `TAB_DELETED`.
  - `POST worker/imports/cleanup` (ruta de sistema del kit, C23): lista `tasks/imports/` por la API de Storage y borra los paquetes cuyo nombre (`<caducidad>.<sha256>.zip`) venció hace más de diez minutos. No hay tabla ni acción SQL: el nombre ya lleva la caducidad, y borrar por la API de Storage elimina también el binario. Solo existe si la función tiene el secreto `IKISAI_WORKER_KEY`.
- **Actualización de la PWA**: `updates.js` se conserva tal cual; sus 6 escenarios están en `tests/tasks/updates.spec.ts` (el servidor de pruebas cambia el nombre de la caché de `sw.js` para simular una versión nueva, como hace el despliegue con el hash del frontend).


## 18. Compras no alimentarias (propuesta para revisión de Core, 6 de octubre de 2026)

Ampliación aprobada por el usuario tras la aceptación V1 (ronda 25). Revisada por Core (ronda 26) y con las decisiones del usuario en §18.7 (ronda 27). Se construye después de cerrar la cadena de la V1.

### 18.1 Qué resuelve

- **Solicitudes de compra** previas a la factura: alguien pide algo (qué, cuánto, para qué área, proyecto o tarea, con qué urgencia), se aprueba, se compra y se recibe. Después, Invoices asigna la línea de la factura a la solicitud como destino, igual que hoy a un área, proyecto o tarea.
- **Stock ligero de suministros** no alimentarios (limpieza, piscina, mantenimiento, textil): qué hay, dónde, el mínimo y cuánto reponer, con aviso cuando baja del mínimo y un botón para pedir lo que falta.

Fuera de alcance: alimentos (Food), precios de proveedor y pedidos a proveedores.

### 18.2 Tablas nuevas (`tasks.*`, migración `0305`)

Mismas convenciones que las diez tablas actuales: uuid, `tab_id` desnormalizado (y `project_id` donde aplica) para que la visibilidad se decida por fila, papelera normal y `writable_columns` explícitas.

**`tasks.purchase_requests`**

| Columna | Tipo | Notas |
|---|---|---|
| `tab_id` | `uuid not null` | Área. Inmutable. |
| `project_id` | `uuid null` | Proyecto destino. `null` = del área en general. |
| `task_id` | `uuid null` | Tarea que lo necesita (mismo proyecto). |
| `supply_item_id` | `uuid null` | Si es reposición de un suministro. |
| `title` | `text not null` | Qué se pide (1–300). |
| `note` | `text not null default ''` | Para qué, modelo, enlace. |
| `quantity` | `numeric(12,3) null` | Mayor que 0. |
| `unit` | `text null` | «ud», «l», «kg», «m»… |
| `estimated_amount` | `numeric(12,2) null` | Importe estimado, 0 o más. |
| `priority` | `text not null default 'normal'` | `normal`, `high`, `critical`: la urgencia, con la misma estrella que las tareas. |
| `status` | `text not null default 'requested'` | `requested` (pedida), `approved` (aprobada), `purchased` (comprada), `received` (recibida), `rejected` (rechazada). |
| `needs_invoice` | `boolean not null default true` | Si se espera factura: Tasks avisa si no llega (§18.6). |
| `repeat_days` | `int null` | Recurrente: al pasar a `received`, la app ofrece crear la siguiente, y las vencidas entran en el próximo plan (§18.7 y §18.8). |
| `due` | `date null` | Para cuándo hace falta. |
| `approved_at`, `purchased_at`, `received_at` | `timestamptz null` | Los pone un trigger al cambiar `status`, como `done_at` en tareas. No son escribibles. |
| `position` | `double precision not null` | Orden manual (decisión del usuario sobre el orden manual). |

**`tasks.supply_items`**

| Columna | Tipo | Notas |
|---|---|---|
| `tab_id` | `uuid not null` | Área. Inmutable. |
| `name` | `text not null` | 1–200. Único entre los vivos del área (hook). |
| `category` | `text not null default 'other'` | `cleaning`, `pool`, `maintenance`, `textile`, `other`. |
| `unit` | `text not null default 'ud'` | |
| `location` | `text not null default ''` | Dónde está («Almacén piscina»). |
| `min_quantity` | `numeric(12,3) not null default 0` | 0 o más. Bajo mínimo: la suma de sus movimientos vivos es menor que `min_quantity`. |
| `reorder_quantity` | `numeric(12,3) null` | Mayor que 0. Cuánto pedir al reponer; sin ello, lo que falta hasta el mínimo. |
| `archived` | `boolean not null default false` | |
| `position` | `double precision not null` | |

**`tasks.supply_movements`** (solo se insertan; corregir es crear otro movimiento o enviarlo a la papelera)

| Columna | Tipo | Notas |
|---|---|---|
| `tab_id` | `uuid not null` | Desnormalizado. |
| `supply_item_id` | `uuid not null` | |
| `kind` | `text not null` | `in` (entrada), `out` (consumo), `adjust` (ajuste de recuento). |
| `delta` | `numeric(12,3) not null` | Distinto de 0: positivo en `in`, negativo en `out`, cualquiera en `adjust`. |
| `purchase_request_id` | `uuid null` | Entrada que viene de recibir una solicitud. |
| `note` | `text not null default ''` | |

**El stock no se guarda en una columna:** es la suma de los movimientos vivos y la calcula quien lee (la app, `tasks.low_stock`). Un valor mantenido por un trigger no pasaría por `core.changes` y los espejos se quedarían con el valor antiguo (cambio respecto a la primera propuesta, migración `0305`).

Por qué movimientos y no un número editable: dos personas sin red que gastan a la vez dos bolsas de cloro generan dos inserciones que se suman al sincronizar. Editar `current_quantity` en ambos dispositivos sería un conflicto, y el último ganaría restando solo una. Un recuento («quedan 7») se guarda como `adjust` con la diferencia frente a lo actual, calculada en el cliente; si dos recuentos se cruzan sin red, basta con volver a contar.

### 18.3 Reglas del hook (`tasks.validate_batch`, migración `0305`)

- Mismas reglas de área y ámbitos que el resto: área coherente con el proyecto, la tarea y el suministro; la tarea, del mismo proyecto; el suministro, de la misma área.
- Estado: se puede pasar entre los cinco estados, pero `approved` y `rejected` solo los pone el **responsable de compras del área** o, si no hay, la propietaria (§18.7, punto 2). Quien tiene acceso a un solo proyecto pide y marca comprada o recibida.
- Movimientos: `delta` con el signo de su `kind`; una vez creados no se editan, salvo `note`.
- Al pasar a `received` una solicitud con suministro, la app añade en el **mismo lote** una entrada `in` de su cantidad con `purchase_request_id`. El hook comprueba que no haya dos entradas vivas para la misma solicitud.

### 18.4 Visibilidad

- Solicitudes con proyecto: como las tareas (`scope_project`). Sin proyecto: solo con acceso completo al área.
- Suministros y movimientos: con acceso completo al área. Quien tiene un solo proyecto no ve el almacén.

### 18.5 Interfaz y rutas

- **Interfaz:**
  - Grupo nuevo «Compras» en el menú, con «Solicitudes» (lista por estado, con filtros de área, proyecto y urgencia, y orden manual) y «Suministros» (stock, mínimo y ubicación; lo que está bajo mínimo, resaltado).
  - Desde una tarea: «Pedir material».
  - Desde un suministro: «Pedir» (crea la solicitud con la cantidad de reposición o lo que falta hasta el mínimo), «Gastar» y «Recontar».
  - Aviso en Inicio: «N suministros bajo mínimo».
- **Lectura registrada** (`core.allow_read`):
  - `tasks.low_stock`: suministros vivos bajo mínimo, con su solicitud abierta si la hay. La usan Inicio y los agentes.
- **Herramientas MCP** (con `buildTaskTool`):
  - `tasks_request_purchase`.
  - `tasks_record_supply` (entrada, consumo o recuento).
  - Rechazar una solicitud o borrar un suministro pasan por la aprobación de siempre.

### 18.6 Proyección para Invoices

Invoices ya asigna líneas a destinos de Tasks (`target_app = 'tasks'`, `target_kind` `area|project|task`), validando con `tasks.targets` y el token del usuario. Propuesta:

- **`tasks.targets` admite `kind = 'purchase_request'`**:
  - Búsqueda por id: devuelve `{kind, id, tabId, projectId, taskId, title, status, quantity, unit, estimatedAmount, needsInvoice, revision, deleted}`.
  - Modo lista: con ese `kind` y sin id, devuelve las solicitudes visibles aprobadas, compradas o recibidas que requieren factura, para el buscador «Asignar a…» de Invoices. Admite `q`, `tabId` y `limit`.
  - Lo que ya devuelve para los otros tipos no cambia.
- **Invoices** añade el par `tasks` / `purchase_request` a sus destinos. Es un cambio suyo, que pido vía Core.
- **«Facturada» se ve en Tasks sin copiar datos.** Tasks lee una lectura nueva de Invoices, `invoices.allocations_by_target {targetApp: 'tasks', targetKind, ids}`, que devuelve por id el código de factura, su estado y el importe asignado, filtrado por lo que el usuario puede ver en Invoices. Tasks la consulta al abrir «Solicitudes» y la guarda en caché local para verla sin red. Ninguna app escribe en la otra. **Petición a Invoices vía Core.**
- Si una solicitud requiere factura y no tiene asignación en Invoices pasados 15 días desde que se recibió, Tasks la marca «Falta factura». El plazo se puede ajustar.

### 18.7 Decisiones (ronda 27)

1. **Reposición: aviso y botón.** Cuando un suministro baja de su mínimo, se avisa en el propio suministro y en Inicio con palabras sencillas: «Queda poco: pedir». El botón crea la solicitud de compra precargada (suministro, cantidad de reposición o lo que falta hasta el mínimo, y su proveedor preferente). No se crea nada solo.
2. **Aprueba solo el responsable de compras del área.**
   - **Qué es:** una persona por área, elegida entre las **cuentas** con acceso a esa área. Si no hay ninguna elegida, aprueba la propietaria.
   - **Modelo:** columna nueva `tasks.tabs.purchase_approver_id uuid null` (escribible solo por la propietaria, como el resto de `tabs`).
   - **Hook:** `approved` y `rejected` solo los pone ese usuario o, si es `null`, una propietaria con acceso completo al área.
   - **Por qué una cuenta y no la familia de responsables:** los responsables de tareas son **etiquetas** y pueden no tener cuenta (un fontanero externo). Aprobar es una acción con autoría, así que tiene que ser una cuenta.
3. **Plan de compras por proveedor y hoja de ruta** (en lugar de un planificador):
   - **Recurrentes:** al recibir una solicitud recurrente, la app ofrece crear la siguiente. Las que vencen entran solas en el próximo plan que se prepare.
   - **Plan:** agrupa por proveedor las solicitudes aprobadas sin plan y las recurrentes vencidas.
   - **Hoja de ruta:** una lista por proveedor, en el orden de visita que el usuario elige a mano, con cantidades y casillas para marcar lo comprado. Imprimible y usable en el móvil.

### 18.8 Proveedor y plan de compras

**Proveedor (enlazado al maestro de Invoices, sin copiarlo):**
- `tasks.supply_items` y `tasks.purchase_requests` ganan `supplier_id text null` y `supplier_name text null`. El id es el de `invoices.suppliers`; el nombre es de cortesía, para verlo sin red, igual que Invoices guarda `target_label` de los destinos de Tasks.
- **Petición a Invoices vía Core:** una lectura `invoices.supplier_options {q, limit}` → `[{id, name, slug}]` con los proveedores vivos. `tasks-api` la consulta con el token del usuario (`GET suppliers?q=`), igual que Invoices consulta `tasks.targets`. Sin Invoices o sin red, se puede escribir un nombre libre (`supplier_id` nulo) y enlazarlo después.
- Así Food podría usar el mismo maestro para sus listas de compra. No se unifica ahora, pero nada lo impide.

**Tablas nuevas (migración `0305`, junto a las de §18.2):**

`tasks.purchase_plans`

| Columna | Tipo | Notas |
|---|---|---|
| `tab_id` | `uuid not null` | Área. Un plan es de un área, por la visibilidad. Si hiciera falta un plan de varias áreas, se vería en «General» como varios planes. |
| `title` | `text not null` | «Compra del 14 de octubre». |
| `planned_for` | `date null` | Día previsto. |
| `status` | `text not null default 'draft'` | `draft` (preparando), `shopping` (de compras), `done` (terminado). |
| `note` | `text not null default ''` | |

`tasks.purchase_plan_stops` (una parada por proveedor, en el orden de visita)

| Columna | Tipo | Notas |
|---|---|---|
| `tab_id` | `uuid not null` | Desnormalizado. |
| `plan_id` | `uuid not null` | |
| `supplier_id` | `text null` | El de Invoices, o nulo con un nombre libre. |
| `supplier_name` | `text not null` | |
| `position` | `double precision not null` | Orden de visita, ordenado a mano (lista reordenable del kit). |
| `note` | `text not null default ''` | «Abre a las 8». |

`tasks.purchase_requests` gana `plan_stop_id uuid null`: la parada del plan donde se comprará. El plan se deduce de la parada.

**Flujo:**
1. **«Preparar plan»:**
   - Crea un plan en `draft` con una parada por proveedor y asigna las solicitudes aprobadas sin parada.
   - Para cada recurrente vencida (recibida, con `repeat_days`, y `received_at + repeat_days` ya pasado o dentro del plan), crea la solicitud siguiente ya aprobada y la asigna.
   - Lo que no tiene proveedor va a una parada «Sin proveedor».
   - Todo es un lote con las operaciones de dominio de siempre.
2. **Editar el plan:** reordenar paradas a mano, mover una solicitud de parada y quitar o añadir solicitudes.
3. **Hoja de ruta:**
   - En el móvil: lista por parada, en orden, con cantidad, unidad, nota y una casilla. Marcar la casilla pasa la solicitud a `purchased` (sin red también).
   - Imprimible: la misma lista con `renderPrintPage` del kit.
4. **Al recibir:** `received`, con su entrada de stock si es de un suministro (§18.3), y la oferta de crear la siguiente si es recurrente. Con todo comprado o recibido, el plan pasa a `done`.

**Reglas del hook añadidas:**
- Parada, plan y solicitud de la misma área.
- Una solicitud solo entra en un plan si está aprobada.
- No se puede borrar un plan con solicitudes compradas: se termina.

**Visibilidad:** planes y paradas, con acceso completo al área (como los suministros).

### 18.9 Orden de construcción

1. Migración `0305`:
   - tablas de §18.2 y §18.8;
   - `tabs.purchase_approver_id`;
   - triggers, hook y `tasks.targets` ampliada;
   - pruebas SQL.
2. Dominio y `tasks-api`:
   - tipos, validación y operaciones (`requestPurchaseOps`, `receivePurchaseOps`, `supplyMovementOps`, `preparePlanOps`);
   - ruta `GET suppliers` con su caída a nombre libre;
   - conformidad.
3. Interfaz con el kit y Playwright:
   - Solicitudes;
   - Suministros con «Queda poco: pedir»;
   - Plan y hoja de ruta, con lista reordenable e imprimible;
   - responsable de compras en el gestor de áreas.
4. Integración con Invoices cuando existan sus tres piezas: destino `purchase_request`, `invoices.allocations_by_target` e `invoices.supplier_options`.


## 19. Trabajo pedido desde otras apps (petición P5 de Central; visto bueno de Core en la ronda 36, construido el 7 de octubre de 2026)

Central quiere crear tareas en Tasks desde su módulo de cumplimiento, sin duplicarlas al reintentar, y leer el estado de varias a la vez. Lo hace con el token de la persona, como Invoices con `tasks.targets`.

### 19.1 Por qué una ruta y no una acción registrada

Una acción registrada (`invoke/:name`, `kind = 'action'`) corre **fuera de `core.commit`** (`docs/core/CONTRATO_SINCRONIZACION.md`, `POST invoke/:name`). Una tarea creada así no llegaría a `core.changes`, y por tanto tampoco a los espejos offline, al historial ni a «deshacer». Por eso la propuesta es una **ruta de `tasks-api`** que construye el lote con el dominio (`createTaskOps`) y lo envía por el camino de siempre: `beforeCommit`, hook SQL y `core.commit`.

### 19.2 `POST /api/v1/requests/task`

Rol `editor` u `owner`, con alcance sobre el destino (las reglas de siempre del hook). Cuerpo:

| Campo | Obligatorio | Notas |
|---|---|---|
| `source` | sí | App que pide: `[a-z][a-z0-9_-]{1,30}`, por ejemplo `central`. Es un espacio de nombres para `external_ref`, no una credencial. |
| `external_ref` | sí | Referencia de la app que pide, de 1 a 150 caracteres. Por ejemplo, el id de la obligación de cumplimiento. |
| `title` | sí | Hasta 500 caracteres. |
| `note` | no | La «notes» de la petición. Hasta 20 000 caracteres. |
| `due` | no | `AAAA-MM-DD`. |
| `priority` | no | `normal`, `high` o `critical`. |
| `project_id` | uno de los dos | Proyecto destino. |
| `tab_id` | uno de los dos | Área destino. La tarea va a su **Entrada** (proyecto de sistema `inbox`). Si vienen los dos, deben ser coherentes. |

**Idempotencia:**
- El id de la tarea es **determinista**, un uuid derivado por SHA-256 de `ikisai-tasks-request:<source>:<external_ref>`, igual que los ids de las herramientas MCP (`tasks-api/mcp.ts`).
- El `requestId` del lote también se deriva de él.
- Repetir la petición, aunque sea a la vez desde dos sitios, nunca crea dos tareas: el núcleo devuelve el recibo del lote ya aplicado, o el id choca.

**Respuesta:** `{ created, task }`.
- `task` tiene la forma de `tasks.targets` para una tarea: `{kind: 'task', id, tabId, projectId, title, done, revision, deleted, archived}`, más `externalRef`.
- `created: false` si ya existía. **No se modifica nada**: ni el título, ni la fecha, ni el destino.
- Si está en la papelera, se devuelve con `deleted: true` y no se recrea. Sacarla de la papelera es cosa de una persona en Tasks; Central decide si pide otra con otra referencia.
- Si existe pero no es visible para quien llama: `409 EXTERNAL_REF_IN_USE`, sin datos de la tarea.

**Procedencia visible:** columna nueva `tasks.tasks.external_ref text` (migración `0307`).
- Contenido: `<source>:<external_ref>`, inmutable, con índice único entre las tareas **vivas** (decisión de Core). La que está en la papelera conserva su referencia.
- Así la tarjeta muestra «Pedida desde Central» y la idempotencia no depende solo de cómo se deriva el id.
- No es escribible desde la interfaz ni desde `commands`: solo la rellena esta ruta. El hook rechaza fijarla o cambiarla por otro camino.

**Alternativa sin migración** (descartada en la ronda 36): solo el id determinista. Funcionaba, pero la tarea no diría de dónde viene.

### 19.3 `tasks.targets` con lista de ids

- `{kind: 'task', ids: [uuid, …]}`, con 200 como máximo, devuelve `{items: [ … ]}`.
- Cada elemento tiene la forma de una tarea por id (§19.2), con `done` calculado (una tarea padre está hecha si lo están sus hijas) y `externalRef`.
- Las que no existen o no son visibles se omiten y se listan en `missing`, para que Central distinga «borrada» (viene con `deleted: true`) de «no la ves».
- El modo por un `id` y el árbol no cambian.

Central puede guardar el `id` que le devuelve §19.2 o recalcularlo. No hace falta buscar por `external_ref`; si lo prefiere, `{kind: 'task', externalRefs: […]}` sale casi gratis con la columna.

### 19.4 Fuera de alcance

- **Avisos a Central cuando una tarea se completa:** no hay webhooks entre apps. Central consulta `tasks.targets` con su lista cuando lo necesita, por ejemplo al abrir su panel.
- **Herramienta MCP equivalente:** los agentes ya tienen `tasks_create_task`.

### 19.5 Construcción (una PR, tras el visto bueno)

1. Migración `0307`:
   - `external_ref`, con índice y regla en `tasks.validate_batch`;
   - `tasks.targets` copiada entera, con `ids` y `externalRef`;
   - pruebas SQL.
2. Ruta `requests/task` en `tasks-api`, con las pruebas de idempotencia, papelera, alcance y concurrencia.
3. La tarjeta muestra «Pedida desde Central», con el nombre de la app sacado del catálogo `GET /api/v1/apps`.
4. Ejemplo de llamada en este apartado, para Central.

### 19.6 Tal y como se ha construido

- **Migración `20261007_0307_tasks_external_requests.sql`:**
  - columna `external_ref`, con su comprobación de formato, índice único entre las vivas e inmutable (`guard_immutable`);
  - procedimiento `tasks.request_task`, que solo lanza la ruta: los `call` no pasan por `commands`;
  - regla en `tasks.validate_batch`: `external_ref` solo se fija en el insert de ese procedimiento;
  - `tasks.targets` con `ids` y `externalRef`.
- **Ruta:** `supabase/functions/tasks-api/requests.ts`.
  - Primero lee `tasks.targets` con el id derivado. Si no existe, confirma el `call` con un `requestId` nuevo cada vez: la idempotencia la da el id de la tarea, no el recibo.
  - Si dos peticiones chocan a la vez, la segunda devuelve la tarea de la primera.
- **Agentes:** el núcleo pide aprobación para cualquier `call` de un agente, así que esta ruta es para personas (Central llama con el token de la persona). Un agente ya tiene `tasks_create_task`.
- **Interfaz:** el editor de la tarea muestra «Pedida desde Central · LEG_2026_004». El nombre de la app sale de `GET /api/v1/apps`.

Ejemplo para Central (desde su Edge, con `ctx.token`):

```http
POST https://tasks.ikisai.com/api/v1/requests/task
Authorization: Bearer <token de la persona>
Content-Type: application/json

{"source": "central", "external_ref": "LEG_2026_004", "title": "Renovar la licencia de la piscina",
 "note": "Vence el 30 de noviembre", "due": "2026-11-15", "priority": "high", "tab_id": "<área>"}
```

→ `200 {"created": true, "task": {"kind": "task", "id": "…", "tabId": "…", "projectId": "<Entrada>", "title": "…", "revision": 1, "deleted": false, "archived": false, "done": false, "externalRef": "central:LEG_2026_004"}}`

Errores:
- `422 INVALID_INPUT` si la entrada no vale;
- `403` sin permiso de edición o fuera de su alcance (la Entrada es del área entera);
- `404` si el proyecto o el área no existen;
- `409 EXTERNAL_REF_IN_USE` si la referencia es de una tarea que no ve.

Estado de varias: `POST /api/v1/read/tasks.targets` con `{"kind": "task", "ids": ["…", "…"]}` → `{"items": [...], "missing": [...]}`.


## 20. Enrutado de las peticiones de otras apps (ronda 38, decisión del usuario; visto bueno de Core en la ronda 39, 7 de octubre de 2026)

Hoy `POST requests/task` (§19) obliga a quien pide a decir `project_id | tab_id`. Central, Booking o Food tendrían que conocer la organización de Tasks, y la integración se rompería al reorganizarla. Con este cambio, **la petición dice qué es y Tasks decide dónde va**, con reglas que configura el usuario. Lo que no tiene regla espera en **«Por clasificar»**.

### 20.1 Una decisión de modelo: «Por clasificar» guarda peticiones, no tareas

Core sugería un contenedor de sistema que no aparezca como área. Propongo otra cosa con el mismo resultado para quien lo usa, por una restricción de Tasks: **una tarea no cambia de área**.
- `tab_id` es inmutable, y las etiquetas, las dependencias y el responsable (familia Persona) son de cada área.
- Un contenedor que fuera un área obligaría a permitir mover tareas entre áreas, solo para este caso, en el trigger, el hook, el deshacer y la cascada.
- Además habría que esconder ese área en la tira, el modelo heredado, la exportación portable, la papelera y los contadores.

Lo que propongo:
- Lo que llega sin regla se guarda como **petición pendiente** en una tabla propia.
- **«Mover a…»** crea la tarea en el área y el proyecto elegidos, con el **mismo id** (el que se deriva de la referencia, §19.2), y marca la petición como clasificada.
- Para quien mira es igual: una lista agrupada con chips de origen, «Mover a…» y «Crear regla para este tipo». Por dentro no hay áreas falsas ni movimientos entre áreas.
- Lo que no se puede hacer con una pendiente es trabajarla (completarla, comentarla) antes de clasificarla, que es lo esperable en una bandeja de entrada.

### 20.2 Tablas nuevas (`tasks.*`, migración `0308`)

**`tasks.requests`**: peticiones que esperan clasificación. Es una tabla sincronizada.

| Columna | Notas |
|---|---|
| `id` | El id derivado de `source:external_ref` (§19.2). Será el de la tarea. |
| `source`, `kind`, `kind_label` | `kind` = `<source>.<nombre>` (`central.compliance_due`). `kind_label` es el nombre legible que manda quien pide («Vencimientos»), opcional. |
| `external_ref` | `<source>:<referencia>`, única entre las pendientes. |
| `external_url` | Opcional: enlace al elemento que la generó. Solo `https://` en `*.ikisai.com`. |
| `title`, `note`, `due`, `priority`, `suggested_project_id`, `suggested_tab_id` | Lo que traía la petición. |
| `requested_by` | Quien pidió (lo rellena el procedimiento). |
| `status`, `task_id` | `status`: `pending`, `routed` o `dismissed`. `task_id` es la tarea creada al clasificar. |

**`tasks.request_routes`**: reglas de entrada, una por `kind` viva.

| Columna | Notas |
|---|---|
| `kind`, `kind_label` | El tipo, y su nombre para la pantalla. |
| `tab_id`, `project_id` | Destino. Sin proyecto, la Entrada del área. |
| `owner_label_id` | Responsable opcional: una etiqueta de la familia Persona de esa área. |
| `position` | Orden en la pantalla. |

**Columnas nuevas en `tasks.tasks`:**
- `external_kind`: inmutable; solo la fijan el procedimiento y la clasificación.
- `external_url`.

La tarea **conserva siempre su origen**: `external_ref`, tipo y enlace. Se mueva de proyecto o no, el editor sigue diciendo «Pedida desde Central · Vencimientos · LEG_2026_004», con enlace.

### 20.3 `POST requests/task` (compatible con §19)

Campos nuevos:
- **`kind`**: obligatorio en las peticiones nuevas. Si falta, vale `<source>.general`, para no romper a quien ya llama.
- `kind_label` y `external_url`, opcionales.
- `project_id | tab_id` pasan a ser **opcionales**: son una sugerencia.

**Destino, en este orden:**
1. **La regla** del `kind`, si hay una viva y su destino existe. La configuración del usuario manda sobre lo que sugiere la otra app.
2. **La sugerencia** `project_id | tab_id`, si la trae y es válida. Así siguen valiendo las peticiones de §19.
3. **«Por clasificar»**: se crea una petición pendiente.

**Respuesta:** `{created, routed: 'rule' | 'hint' | 'pending', task}`.
- Una pendiente se devuelve con la forma de una tarea y `pending: true`.
- La idempotencia de §19 no cambia: la misma referencia devuelve lo que haya, sea tarea o pendiente.

**`tasks.targets` con `ids`:**
- También devuelve las pendientes, con `pending: true`, a quien tenga acceso completo y **a quien las pidió**.
- Así Central puede mostrar «en Tasks, por clasificar».

### 20.4 Permisos

- **Pedir:** cualquier `editor` u `owner` de Tasks, como en §19.
- **Destino que quien pide no ve:** una regla puede llevar la tarea a un área que quien pide no ve, y una pendiente solo la ve quien tiene acceso completo. Propongo que **la petición entre igualmente**, como en un buzón. El procedimiento escribe esa única tarea, o esa pendiente, aunque el área quede fuera del alcance de quien pide.
  - La respuesta, en ese caso, no trae datos: `{created, routed, task: {id, visible: false}}`.
  - Es una excepción acotada, porque solo la hace `tasks.request_task`, que no se puede lanzar desde `commands`. Si Core prefiere no hacerla, la alternativa es: «si no ve el destino de la regla, va a Por clasificar».
- **Ver y gestionar «Por clasificar» y las reglas:** `owner` con acceso completo, como pide la ronda 38. Las pendientes no tienen área, así que el hook las trata como «toda la app» (`scope_all`).
- **Clasificar («Mover a…»):** `owner` con acceso completo, o un `editor` con acceso completo. Pregunta para Core: ¿basta con el `owner`?

### 20.5 Interfaz

- **Menú:** «Por clasificar», con contador. Desaparece si está a cero. Solo lo ven quienes tienen acceso completo.
- **Vista «Por clasificar»**, como la de un proyecto:
  - grupos por origen y tipo («Central · Vencimientos (3)»);
  - en cada fila, el chip de origen, el título, la fecha y el enlace «Abrir en Central» (`external_url`);
  - **«Mover a…»** por fila: elegir área, proyecto y responsable; crea la tarea y marca la petición como clasificada, en un solo lote;
  - **«Crear regla para este tipo»** por grupo: abre «Gestionar entradas» rellena. Al guardar, ofrece **«Mover también las N que esperaban»**, que clasifica en un lote todas las pendientes de ese tipo;
  - «Descartar» por fila, con `status = 'dismissed'`: para lo que no es trabajo. Central lo ve como «descartada en Tasks» mediante `targets`;
  - arriba, el enlace «Gestionar entradas».
- **«Gestionar entradas»** (hoja; `owner` con acceso completo):
  - una lista de tipos conocidos: los que han llegado alguna vez y los que ya tienen regla;
  - por cada tipo, su destino o «Por clasificar»;
  - alta, edición y papelera de reglas.
  - Si se borra el área o el proyecto de una regla, la regla deja de aplicarse: lo nuevo de ese tipo vuelve a «Por clasificar» y la pantalla lo marca.
- **Editor de tarea:** el aviso de §19.6 suma el tipo y el enlace.

### 20.6 Hook y dominio

- **Reglas:** el `tab_id` y el `project_id` deben ser coherentes, y el responsable, una etiqueta Persona de esa área.
- **Clasificar:** un lote que pasa la petición a `routed` debe insertar la tarea con el mismo id, en un área viva, con `external_ref` y `external_kind` iguales a los de la petición.
  - Es la única forma, además de `tasks.request_task`, de fijar esas columnas: la regla de §19 se amplía a «insert de la tarea de una petición pendiente en el mismo lote».
- **Dominio:** `classifyRequestOps(data, requestId, {project_id, owner_label_id?})` y `routeKindOps(data, kind, rule)`, usados por la interfaz y probados contra el hook.
- **Vaciar papelera:**
  - una regla cuyo destino está borrado no se purga sola: se ve marcada;
  - las peticiones `routed` o `dismissed` con más de 90 días se purgan con la papelera;
  - las pendientes, nunca.

### 20.7 Construcción (tras el visto bueno)

1. Migración `0308` y dominio, con pruebas SQL y de la ruta (destino por regla, por sugerencia y pendiente; buzón; idempotencia con pendientes).
2. Interfaz: «Por clasificar», «Gestionar entradas» y el editor, con Playwright.

Una PR por paso.

### 20.8 Preguntas para Core

1. ¿Vale el modelo de §20.1, con peticiones pendientes en vez de un área de sistema?
2. Destino que quien pide no ve: ¿buzón, como en §20.4, o a «Por clasificar»?
3. ¿Puede clasificar un `editor` con acceso completo, o solo el `owner`?
4. Precedencia: ¿la regla del usuario por encima de la sugerencia de la otra app, como propongo?

### 20.9 Respuestas de Core (ronda 39) y construcción

**Respuestas:**
1. Peticiones pendientes en `tasks.requests`, sí.
2. Buzón, sí: quien pide recibe solo el estado.
3. Clasifican el `owner` y el `editor` con acceso completo.
4. La regla del usuario manda sobre la sugerencia.

**Una precisión mía:** una **sugerencia** solo vale si quien pide ve ese destino; si no, la petición queda por clasificar. El buzón es solo para lo que decide una regla del usuario, para que una app no pueda meter trabajo donde quien llama no alcanza.

**Paso 1, construido (migración `20261007_0308_tasks_request_routing.sql`):**
- Tablas `tasks.requests` y `tasks.request_routes`, y en `tasks.tasks` las columnas `external_kind` y `external_url`, inmutables.
- `tasks.request_task` aplica este orden: regla, sugerencia visible, pendiente. Siempre deja registrada la petición.
- **Hook:**
  - buzón para el insert de `tasks.request_task`;
  - el origen de una tarea solo se fija por el procedimiento o al clasificar su petición en el mismo lote;
  - una petición solo cambia de estado: `routed` si tiene su tarea viva, y `pending` o `dismissed` si no;
  - en las reglas, destino coherente, sin proyecto archivado, y como responsable una etiqueta Persona de esa área.
- **`tasks.targets` con `ids`:**
  - quien tiene acceso completo ve también las pendientes y descartadas, con sus datos (`pending`, `request`);
  - quien las pidió recibe `{kind: 'task', id, visible: false, request: 'pending' | 'created' | 'dismissed'}`;
  - las tareas traen `externalKind`, `externalUrl`, `visible` y, si vienen de una petición, `request: 'created'`.
- **Dominio** (`_domain/tasks/requests.ts`): `pendingRequests`, `requestGroups`, `routeFor`, `routeTarget`, `classifyRequestOps`, `dismissRequestOps`, `reopenRequestOps`, `saveRouteOps`, `deleteRouteOps` y `routeWaitingOps`.
- **Ruta:** campos `kind` (por defecto `<source>.general`), `kind_label` y `external_url`. `project_id | tab_id` son opcionales. La respuesta incluye `routed: 'rule' | 'hint' | 'pending'`.
- **Purga:** no hay purga automática de las peticiones enrutadas o descartadas. Son pocas, y la app que pidió necesita seguir leyendo su estado.

**Paso 2:** la interfaz («Por clasificar», «Gestionar entradas» y el origen en el editor).

## 21. Indicadores para el panel de Dirección de Central (contrato `docs/central/API.md` §7.2)

La vista `tasks.central_kpi_projection` se crea en la migración `20261007_0309_tasks_central_kpis.sql` y se registra con `core.allow_read('central', 'tasks.central_kpi_projection', 'view')`.
- Solo publica agregados: ningún título, nombre ni importe.
- Todas las filas son la foto de hoy en hora de Madrid (`period = 'actual'`).
- Solo cuenta lo vivo: sin papelera, sin áreas borradas y, en tareas, sin proyectos archivados.
- Todos los indicadores son recuentos (`unit = 'count'`).

| Clave | Etiqueta | Fórmula | Sentido | Enlace |
|---|---|---|---|---|
| `tasks.open` | Tareas pendientes | Tareas vivas **sin hijas vivas** y sin completar, en proyectos vivos y no archivados de áreas vivas. Un padre no cuenta aparte: se calcula por sus hijas. | — | `#/tasks` |
| `tasks.overdue` | Tareas vencidas | Las de `tasks.open` con `due` anterior a hoy. | menos es mejor | `#/tasks` |
| `tasks.purchase_requests_open` | Compras pedidas sin recibir | Solicitudes de compra vivas en estado `requested`, `approved` o `purchased`. | menos es mejor | `#/purchases` |
| `tasks.supplies_below_min` | Suministros bajo mínimo | Suministros vivos y no archivados cuyo stock (la suma de los movimientos vivos) es menor que su mínimo. | menos es mejor | `#/supplies` |
| `tasks.requests_pending` | Peticiones por clasificar | Peticiones de otras apps en «Por clasificar» (`tasks.requests` vivas en estado `pending`, §20). | menos es mejor | `#/triage` |

**Enlaces directos.** `https://tasks.ikisai.com/#/<vista>` abre la vista en cuanto hay modelo y limpia el hash. Vistas admitidas: `home`, `projects`, `tasks`, `triage`, `purchases`, `supplies` y `plans`.

Cambiar el significado de una clave es crear otra (regla del contrato).


## 22. Puente con Feedback (fase 1b de `coordinacion/ampliacion/FEEDBACK.md`; propuesta, 7 de octubre de 2026)

**Alcance (decisión del usuario, mismo día):** solo lo operativo, `feedback.space.*` y `feedback.event.*`. **Los fallos de aplicación no van a Tasks**: van a la vista de QA y al buzón de cada agente. Las reglas `qa.*` y la estructura recomendada de QA (§22.5) no se construyen; quedan como opción futura que el `owner` podría activar.

Tasks pone el destino de las tareas que nacen de un reporte de Feedback, reutilizando lo de §20: `tasks.request_task`, las reglas de entrada y «Por clasificar». No hay un enrutador paralelo y no se guarda el reporte entero, solo el resumen operativo, la categoría y el enlace.

### 22.1 Identidad de servicio (objeción de la fase 0, resuelta por Core)

`POST /api/v1/worker/requests/task` no tiene sesión, pero `tasks.request_task` escribe por `core.commit`. Eso lo deja en `core.changes`, los espejos y el historial, y por eso no se puede hacer como acción de sistema: las acciones van fuera de `core.commit`. Además, `core.commit` exige que quien escribe tenga **pertenencia** a la app.

Propongo que Core aporte una **identidad de servicio formal**, que es la opción 2 de la especificación §14.5, en su migración `0066`:
- un perfil `core.profiles` con `kind = 'service'` y nombre «Feedback (sistema)»;
- una pertenencia `tasks` con rol `editor` y ámbito `*`;
- una función, por ejemplo `core.service_actor('feedback') → uuid`, para que la Edge lo encuentre sin ids escritos en el código.

Con eso:
- la ruta de worker confirma con ese actor, y en el historial y en «Actualizado por» se lee «Feedback (sistema)»;
- no es un agente, así que no pide aprobación por `call`;
- no puede hacer nada más que lo que permite esta ruta, porque nadie tiene su sesión.

Si Core prefiere otra forma (por ejemplo, que `core.commit` admita un actor de sistema para una lista cerrada de procedimientos), me adapto. Lo que no cabe es escribir `tasks.*` desde Core ni usar una clave de agente (especificación §14.5).

### 22.2 `POST /api/v1/worker/requests/task` (construido, con el contrato de Core)

- Clave `X-Ikisai-Worker-Key` (`IKISAI_WORKER_KEY`), de servidor a servidor.
- **Cuerpo**, solo con estos campos: `{source: 'feedback', kind, kind_label?, external_ref, title, note?, external_url?, on_behalf_of: {kind: 'internal' | 'organizer' | 'guest', report_code}}`.
  - `title` hasta 120 caracteres y `note` hasta 1000.
  - `external_ref` es el código del reporte.
  - `external_url` solo puede ser `https://tasks.ikisai.com/#/feedback/<código>`.
  - `kind` puede ser `feedback.space.{damage, cleaning, missing, utilities, safety, other}` o `feedback.event.{setup, accommodation, cleaning, food, technical, operation, other}`.
  - Sin `project_id | tab_id`: decide la regla del usuario y, sin regla, va a «Por clasificar».
- **Quién escribe:** la identidad de servicio de Feedback (`core.service_actor('feedback')`, de Core, migración `0067`), por `core.commit` con `tasks.request_task`.
  - La ruta la obtiene con la acción de sistema `tasks.service_actor` (migración `0311`), que la busca en `core.profiles` (`kind = 'service'`, `service_name = 'feedback'`, con pertenencia a Tasks). No llama a `core.service_actor` porque el lint de migraciones solo deja usar los ayudantes de `core` de su lista.
  - Mientras no exista: `503 SERVICE_NOT_READY`.
- **`on_behalf_of`** es un metadato, nunca el actor. Se guarda en `tasks.requests.on_behalf_of` y, su `kind`, en `tasks.tasks.external_on_behalf`.
  - Los dos son inmutables y forman parte del origen: solo se fijan por el procedimiento o al clasificar la petición.
  - El editor de la tarea dice «Reporte de huésped · Espacio · Avería · FB_2026_000429».
- **Respuesta:** `{taskId, status}`.
  - `taskId` es el id derivado de `feedback:<código>`, también para una pendiente, porque será el de su tarea.
  - `status` es el de §22.3.
- **Idempotente por `external_ref`:** un reintento devuelve lo que hay sin tocar nada, y dos a la vez crean una sola petición.

**Orígenes de sistema (ampliación de Core, ronda del mismo día):** la ruta acepta una lista cerrada de pares `(source, kind)`, y cada par escribe con su identidad de servicio.

| `source` | `kind` | Servicio (Core) | `external_url` | `on_behalf_of` |
|---|---|---|---|---|
| `feedback` | `feedback.space.*`, `feedback.event.*` | `feedback` (`0067`) | `https://tasks.ikisai.com/#/feedback/<código>` | obligatorio |
| `booking` | `booking.ses_deadline` y, desde los portales de organizadores (T3), `booking.organizer_dates`, `booking.organizer_confirm` y `booking.proposal_comment` | `booking` (`0068`) | `https://booking.ikisai.com/#/…` | opcional (para los de organizadores, `{kind: 'organizer', report_code}`) |

Los dos orígenes admiten además `due` (`AAAA-MM-DD`) y `priority` (`normal`, `high` o `critical`), opcionales y con la misma validación que `requests/task`.

**Enrutado de los portales (T3):** «Gestionar entradas» enseña los tipos de Booking aunque aún no haya llegado ninguno.
- Al crear la regla de uno de organizadores, propone el área cuyo nombre contiene «Comercial», sin ids fijos en el código. La propietaria la confirma en un toque.
- La regla no se crea por migración: un id de área no se escribe en el código, ni se crean datos en producción.

La acción `tasks.service_actor {name}`, de la migración `0311` y solo para los servicios de la lista, busca la identidad. Añadir un origen es una fila más en `SYSTEM_SOURCES` (`tasks-api/requests.ts`) y en esa acción.

### 22.3 `POST /api/v1/worker/requests/status {externalRefs}` (construido)

- Hasta 200 referencias, solo de `feedback:` o `booking:`.
- Devuelve `{items: [{externalRef, status, taskId, doneAt, updatedAt}]}`. `status` puede ser:
  - `pending`: por clasificar;
  - `open`;
  - `done`: hecha (en una tarea con hijas, cuando están hechas todas);
  - `dismissed`: descartada;
  - `deleted`: en la papelera o purgada;
  - `unknown`: Tasks no la conoce.
- Sin títulos ni notas.
- Por dentro es la acción `tasks.requests_status` (migración `0310`), registrada sin roles de persona (`{}`): solo la lanza el worker como sistema. Una persona recibe 403 por `invoke`.

### 22.4 `#/feedback/<código>` (reservado)

- La ruta ya existe en la app.
- Hoy enseña el código y la tarea que lo trabaja, si quien mira la ve.
- Cuando existan el componente del kit y la API de Core, pintará el reporte con sus permisos.

### 22.5 «Crear estructura recomendada de QA» (no se construye; opción futura)

- Acción del `owner` con acceso completo, en «Gestionar entradas», e idempotente.
- Propone el área «Depuración de aplicaciones», con un proyecto por app (Tasks, Invoices, Booking, Food, Central, Organizers, Guests) y las 7 reglas `qa.<app>` hacia esos proyectos.
- Antes de crear nada, enseña qué falta y permite elegir un área y proyectos que ya existan, en vez de crearlos.
- Sin ids escritos en el código: busca por nombre y deja elegir.
- Es un lote del dominio: área, proyectos y reglas con `saveRouteOps`.
- Las reglas `feedback.space.*` y `feedback.event.*` las configura el usuario cuando sepa adónde quiere mandarlas (operaciones). La pantalla las lista como tipos conocidos en cuanto llega el primero.

## 23. Proyecto por retiro y tareas de sus extras (fase 3 de los portales; peticiones T1 y T2 de `docs/organizers/PETICIONES.md`, para B13 de Booking)

Booking, con su identidad de servicio y la clave de worker, pide a Tasks el proyecto de cada retiro confirmado y una tarea por cada extra contratado. El área la fija la regla del usuario. Lo construye la migración `20261008_0313_tasks_retreat_projects.sql`.

### 23.1 `POST /api/v1/worker/requests/project`

- **Cuerpo:** `{source: 'booking', kind: 'booking.retreat_project', external_ref: 'RES<código>', date: 'AAAA-MM-DD', title (1–280), note? (≤ 1000), state?: 'confirmed' | 'cancelled'}`.
- **Nombre:** lo compone Tasks como `AAAAMMDD-<título>`, con `date` como día de entrada.
- **Idempotente por `external_ref`, en la misma llamada.** El id del proyecto se deriva de la referencia. Según cómo esté el proyecto:
  - no existe: se crea en el área de la regla del usuario para `booking.retreat_project` (de la regla solo cuenta el área) → `created`. Sin regla → `no_route`, sin crear nada; Booking reintenta;
  - existe y cambian la fecha o el título: se renombra → `renamed`; si no cambia nada → `unchanged`;
  - llega `state: 'cancelled'` (reserva cancelada o perdida): se **archiva** y sus tareas quedan como están → `archived`;
  - se vuelve a confirmar: se desarchiva → `restored`;
  - está en la papelera: no se resucita → `deleted`.
- **Respuesta:** `{projectId, status}`. `projectId` es el id del proyecto, para que Booking lo guarde.
- Si el usuario renombra el proyecto a mano, la siguiente llamada de Booking le devuelve su nombre. El nombre del retiro lo manda Booking.

### 23.2 Extras: `POST /api/v1/worker/requests/task` con `booking.retreat_extra`

- **Cuerpo:** el de §22.2, más `project_ref: 'RES<código>'`. Es obligatorio en este tipo y no vale en ningún otro.
  - `external_ref` = `RES<código>-EXTRA-<línea>`.
  - `due` = día de entrada.
- **Destino:** la tarea va al proyecto de esa reserva (con las etiquetas del proyecto), sea cual sea la regla. Si el proyecto aún no existe → `409 PROJECT_NOT_READY`, sin dar de alta nada: primero el proyecto.
- **Idempotente por línea.** Un reenvío no toca la tarea, así que quien la trabaja puede cambiar la fecha o cualquier otra cosa.
- **Respuesta:** `{taskId, status}`. El estado posterior se consulta con `worker/requests/status` (`booking:RES…-EXTRA-…`).

### 23.3 Datos y reglas

- `tasks.projects.external_ref` (`booking:RES<código>`): inmutable y única entre los proyectos vivos.
  - Solo la fija el procedimiento `tasks.request_project`: el hook la rechaza por cualquier otro camino.
  - `tasks.request_task` acepta `projectRef`.
- **«Gestionar entradas»** enseña `booking.retreat_project` («Retiro · Proyecto») como tipo conocido, con la nota de que solo cuenta el área. La regla la confirma la propietaria.



## 24. Estructura definitiva de áreas y proyectos (decisión del usuario, 8-10-2026)

| Área | Proyectos |
|---|---|
| Obras y mejoras | uno por intervención o zona |
| Mantenimiento | Jardinería, Piscina, Instalaciones, Anti-incendios, Reparaciones |
| Retiros | uno por retiro confirmado (los crea Booking, §23) |
| Gestiones | Comercial, Administración y fiscal, Cumplimiento |
| Aplicaciones | uno por app (Tasks, Booking, Food, Finance, Central, Organizers, Guests) |
| *Compras* | no es un área: el módulo de Compras (§18) |

### 24.1 Reglas de entrada propuestas (hecho)

«Gestionar entradas» enseña como tipos conocidos los que pueden llegar de otras apps. Al crear la regla de cada uno, propone el destino de esta estructura: primero un proyecto cuyo nombre case y, si no hay, un área. Siempre por nombre, sin ids fijos.

| Tipo | Destino propuesto |
|---|---|
| Organizador · Fechas posibles, Quiere confirmar y Comentario a la propuesta | proyecto «Comercial» (o área «Comercial» o «Gestiones») |
| SES · Plazo legal (`booking.ses_deadline`) | proyecto «Administración y fiscal» (o área «Gestiones») |
| Central · Vencimientos (`central.compliance_due`) | proyecto «Cumplimiento» (o área «Gestiones») |
| Espacio · … (`feedback.space.*`) | proyecto «Reparaciones» (o área «Mantenimiento») |
| Retiro · … (`feedback.event.*`) | área «Retiros» (lo que no traiga su reserva; ver 24.3) |
| Retiro · Proyecto (`booking.retreat_project`) | área «Retiros» (ya puesta) |

### 24.2 Compras por proveedor (hecho)

«Solicitudes de compra» se puede ver **por proveedor**, además de por estado: lo pendiente (pedido, aprobado o comprado sin recibir) de cada proveedor, esté o no en un plan.
- Se agrupa por el proveedor del catálogo de Finance o por su nombre libre; lo que no tiene proveedor va al final.
- La elección se recuerda por dispositivo.

### 24.3 Feedback de un retiro, al proyecto del retiro (hecho en Tasks; falta el kit)

`worker/requests/task` acepta `project_ref: 'RES<código>'` opcional en `feedback.event.*`.
- Si el proyecto de esa reserva existe, la tarea va ahí.
- Si no, el reporte no se bloquea: va por su regla o a «Por clasificar».
- **Petición a Core o UI:** que `taskRequestFor` (`_kit/feedback.ts`) añada `project_ref` con el código de la reserva cuando el reporte de evento lo tenga en su ámbito.

### 24.4 Convertir un área en proyecto de otra (hecho; aprobado por el usuario el 8-10-2026)

Para «Jardinería» y «Anti-incendios», que pasan a ser proyectos de Mantenimiento. **Acción de la propietaria con acceso completo, desde la app:** «Editar área» › «Convertir en proyecto de…». Nadie la ejecuta en producción por otra vía.

**Vista previa** (antes de confirmar): área de destino (propone «Mantenimiento»), nombre del proyecto (el del área) y recuentos:
- proyectos que se reúnen, tareas pendientes y hechas, etiquetas nuevas que se crearán en el destino;
- fotos y adjuntos, solicitudes de compra, suministros (y los que se renombran por repetidos), reglas de entrada;
- **Finance:** cuántas asignaciones a tareas se conservan y la **lista de las líneas asignadas al área o a sus proyectos** (factura, fecha, importe y a qué estaban asignadas), con enlace a cada factura. Esas hay que reasignarlas a mano en Finance. Si no se puede consultar Finance (sin red o sin acceso), lo dice.

**Qué hace** `POST tabs/:tabId/convert {targetTabId, title, requestId, projectId?}` → `{projectId, counts, cursor}` (procedimiento `tasks.convert_tab_into_project`, migración `0314`), en un solo lote y con historial:
- crea el proyecto al final del área de destino;
- pasa a él las tareas vivas de todos los proyectos del área de origen (incluida su Entrada) **con los mismos ids**: historial, notas, subtareas, fotos y enlaces de Finance a tareas siguen;
- etiquetas por nombre: la del destino con el mismo nombre en la misma familia (por su clave de sistema, como Persona o Fase, o por el nombre de la familia); las que faltan, se crean. La responsable pasa a la «Ana» del destino;
- dependencias y adjuntos (de las tareas y de los proyectos) al proyecto nuevo;
- suministros, movimientos, planes, paradas y solicitudes de compra vivos al destino (lo que era de un proyecto del origen, al proyecto nuevo). Un suministro con el nombre de uno del destino se renombra «<nombre> · <área de origen>»;
- las reglas de entrada que apuntaban al origen pasan al proyecto nuevo;
- el área de origen, vacía, va a la papelera con sus proyectos. **Restaurarla no deshace la conversión:** vuelve vacía (con su Entrada) y lo convertido sigue en el destino.

Lo que estaba en la papelera se queda con el área antigua. Si una tarea viva dependía de una en la papelera, esa dependencia se retira; un enlace de una compra a una tarea o a un suministro en la papelera se suelta.

`tab_id` sigue siendo inmutable fuera de este procedimiento (`tasks.guard_immutable` solo lo permite en su modo conversión). Prueba fuerte en PGlite: `tests/tasks/convert.test.ts`; interfaz: `tests/tasks/convert.spec.ts`.

### 24.5 Pasos para el usuario (crear la estructura)

Hoy se crea desde la app, en pocos minutos: no hace falta un asistente.
1. Menú › «Áreas de trabajo» › nueva área. Crear **Obras y mejoras**, **Mantenimiento**, **Gestiones** y **Aplicaciones**. «Retiros» y «General» ya están.
2. En cada área, «+ Proyecto»:
   - Mantenimiento: Piscina, Instalaciones, Reparaciones. Jardinería y Anti-incendios llegan con la conversión (24.4): «Editar área» de cada una › «Convertir en proyecto de…» › Mantenimiento;
   - Gestiones: Comercial, Administración y fiscal, Cumplimiento;
   - Aplicaciones: Tasks, Booking, Food, Finance, Central, Organizers, Guests;
   - Obras y mejoras: uno por obra cuando empiece.
3. Menú › Trabajo › «Por clasificar» › «Gestionar entradas»: abrir cada tipo y **Guardar**. El destino de 24.1 sale ya propuesto.
