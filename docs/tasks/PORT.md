# Tasks · plan de port al núcleo (borrador de Core para el equipo de Tasks)

Origen: `Ikisai-apps/ikisai-tasks`, `main` `d02bf44` (v0.7.0-build.4 en producción). Copia de referencia local en `C:\Users\34606\Documents\Ikisai\App\ikisai-tasks-ref`. Destino: `apps/tasks`, `supabase/functions/tasks-api`, schema `tasks.*` sobre el núcleo. La nube está vacía de datos reales; no hay migración de datos. El esquema `ikisai.*` se retira con una migración final cuando el nuevo Tasks esté publicado y verificado.

## 1. Qué se conserva tal cual (valor probado)

- Jerarquía App → Áreas (`tabs`) → Proyectos → Tareas con un nivel de hijas; dependencias entre tareas con ciclos prohibidos y condiciones heredadas del padre (`docs/DEPENDENCIAS_TAREAS.md` del repo antiguo).
- Ámbitos por área y proyecto para editores limitados, lectores, y la regla de que un bloqueo privado se ve sin revelar contenido.
- Catálogo de etiquetas y familias, vistas guardadas, papelera por lote (`deleteBatch`), deshacer, historial.
- Interfaz completa (vanilla, módulos de UI «Taller»), fotos recomprimidas en cliente, PWA con activación coordinada, CSV e intercambio portable (adaptados al nuevo modelo).
- Agentes con clave, propuestas con aprobación humana y MCP: se portan en una fase posterior sobre `core` con columna `app`.

## 2. Qué cambia

| Antes (`ikisai.*`) | Después (`tasks.*` + núcleo) |
|---|---|
| Atributos en `data jsonb`, `replace_state` del grafo completo | Columnas tipadas, `core.commit` fila a fila |
| `data.version` + `expectedVersion` | `revision` + `expectedRevision` (mismo significado) |
| `ikisai.changes` con delta del estado | `core.changes` con `before`/`after` por fila |
| `ikisai.receipts` | `core.receipts` |
| `ikisai.members/profiles` por app | `core.memberships(app='tasks', scopes)` + `core.profiles` |
| Edge `ikisai-api` monolítica | `tasks-api` sobre `_kit` con hooks `visible`, `beforeCommit`, `validate_hooks` |
| `sync.js` propio con outbox | `packages/sync-client` compartido |
| Adjuntos base64 dentro del comando, bucket `ikisai-files/{app}/{sha}` | Ticket de subida + `core.files`; el bucket `ikisai-files` se conserva |
| Servidor Python/SQLite y paridad | Se retiran; pruebas sobre PGlite y conformidad |

## 3. Modelo `tasks.*` propuesto

```text
tasks.tabs            id, code?, name, color, position, inbox_project_id, is_inbox_protected, settings jsonb(extra)
tasks.projects        id, tab_id FK, name, color, budget numeric, position, archived_at, notes
tasks.tasks           id, tab_id FK, project_id FK, parent_id FK(self, 1 nivel; check por trigger), title, note, done bool, done_at, due date, cost numeric, position, delete_batch uuid
tasks.task_dependencies  task_id FK, depends_on_id FK, position  (pk compuesta; sincronizable como tabla con id propio o como procedimiento `tasks.set_dependencies`)
tasks.families        id, tab_id FK, name, position, archived_at
tasks.labels          id, tab_id FK, family_id FK, parent_id FK, name, color, position, archived_at
tasks.task_labels     task_id FK, label_id FK  (idem dependencias)
tasks.saved_views     id, tab_id FK, name, filters jsonb, position
```

Decisiones a cerrar en `docs/tasks/API.md`:

- Dependencias y etiquetas de tarea: tabla puente con `id` propio (sincronizable, simple) frente a procedimiento que reemplaza el conjunto (atómico). Recomendación de Core: tabla puente con `id`, y un `validate_hook` `tasks.check_dependency_cycles` que recorre el grafo del área al final de cada lote.
- Invariantes que hoy viven en SQL (`LAST_ACTIVE_TAB`, `INBOX_PROTECTED`): como `validate_hooks`.
- Completar una tarea bloqueada (`TASK_BLOCKED`): regla de `beforeCommit` leyendo el estado actual vía snapshot o consulta dedicada.
- Borrado en cascada por lote: `delete` de la tarea padre genera `delete` de las hijas en el mismo lote (lo construye la UI o un procedimiento `tasks.delete_batch`).

## 4. Ámbitos

`core.memberships.scopes` conserva el formato actual: `"*"`, lista de áreas, o `{tabs:[], projects:{tab:[ids]}}`. El hook `visible(table,row,ctx)` de `tasks-api` aplica `full_tab`/`can_read_project` como hoy en `domain.mjs`. `beforeCommit` rechaza escrituras fuera de ámbito.

## 5. Interfaz

`apps/tasks` arranca copiando `app/` del repo antiguo y sustituyendo `sync.js` + `cloud-auth.js` por un adaptador fino sobre `sync-client` que expone la misma superficie (`api()`, `Sync.mode`, `Sync.token`, cola, conflictos) para que los módulos actuales sigan funcionando. Los módulos de UI envuelven funciones globales y sustituyen fragmentos de HTML: no cambiar el marcado de `taskRow`, `projectCard`, `projectView`, `topbar`, `searchbar` sin coordinar con el agente de UI. Los tests de navegador existentes (`tests/integration.cjs`, 72 escenarios) son el criterio de no regresión; se migran a Playwright test runner.

## 6. Orden sugerido

1. `docs/tasks/API.md` (G2) a partir de este documento y del contrato.
2. Migraciones `tasks` + `validate_hooks` + procedimientos; conformidad en verde.
3. `tasks-api`: hooks de visibilidad y reglas; pruebas portadas de `tests/cloud-api.mjs`.
4. Adaptador de `sync-client` y arranque de la UI actual contra la API nueva en local.
5. Portable/CSV/backup sobre el nuevo modelo.
6. Publicar en `tasks.ikisai.com` con versión verificada; archivar el repo antiguo; migración final que retira `ikisai.*`.
