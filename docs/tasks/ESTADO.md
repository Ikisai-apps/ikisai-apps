# Tasks · estado

Actualizado: 6 de octubre de 2026 (tanda 4). **`apps/tasks` pasa 67 de los 72 escenarios en Playwright, con adjuntos e invitados de extremo a extremo. Faltan CSV, copia portable, respaldo y el filtro por REST (24, 32, 33, 44); el 29 es de la fase de agentes. Todavía no está lista para `tasks-next`.**

## Hecho

- **Diseño:** `docs/tasks/API.md` (G2 aprobada; §16 resolución de Core; §17 cómo quedó el adaptador).
- **Dominio** (`supabase/functions/_domain/tasks`, reexportado por `@ikisai/domain-tasks`): tipos, ámbitos y `visible`, validación de lotes, estados y ciclos, operaciones compuestas y el puente con el modelo anidado de la interfaz (`compose`, `decompose`, `adoptLegacyIds`).
- **Base de datos:** migraciones `0300` (diez tablas), `0301` (hook `tasks.validate_batch`, `tasks.import_rows`, lectura `tasks.targets`) y `0302` (claves solo exigidas a filas vivas).
- **`tasks-api`:** hooks `visible` y `beforeCommit`, subidas a `ikisai-files`, `GET blockers`, `GET attachments/:id`. Desplegada por Core; Invoices ya usa `tasks.targets`.
- **`apps/tasks`** (tanda 3):
  - `public/`: la interfaz antigua copiada de `ikisai-tasks` `d02bf44` (scripts clásicos), con tres cambios mínimos (familia Persona por `system`, carga de `/sync-core.js`, caché `ikisai-shell-v12`).
  - `src/core.ts` → `/sync-core.js`: núcleo del adaptador sobre `@ikisai/sync-client` (espejo en memoria, `model()`, `plan()`, `commit()`, conflictos, rechazados, blobs, bloqueos privados).
  - `public/sync.js` reescrito: conserva `Sync`, `api`, `save`, `syncNow`, `setMode`, `persistUI`, `adopt`, `editorFields`, `cachedAttachment`, hojas de sincronización, conflicto y lote fallido, importación JSON, y traduce `history`/`undo`/`auth/password` a las rutas del núcleo.
  - `public/cloud-auth.js` reescrito: entrada por correo, «Mi cuenta», cierre de sesión que borra lo local, adjuntos como blob (fotos a WebP 1600 px) y arranque.
  - `_worker.js` hacia `tasks-api`; `vite build` deja `dist/` listo para Pages.
- **Pruebas:** 56 `node:test` de Tasks (dominio, SQL, API, conformidad 13/13, puente) dentro de las 226 del repo, y `tests/tasks/app.spec.ts` (Playwright contra la `tasks-api` real en PGlite).

## Escenarios de no regresión (72)

Dos archivos de Playwright contra la `tasks-api` real en PGlite: `tests/tasks/ui.spec.ts` (los escenarios originales con sus mismos gestos, sobre la semilla de demostración antigua con uuid: `tests/tasks/fixtures/demo.json`) y `tests/tasks/app.spec.ts` (sincronización, conflictos, rechazos y permisos).

**En verde (67):** 1–23, 25–28, 30, 31, 34–43, 45–72.

- 31: historial con autor y deshacer; el antes/después filtrado por tarea se hace en el cliente sobre los últimos 200 lotes (C8).
- 37: limpieza local al cerrar sesión; el registro de accesos es de la fase de agentes.
- 27, 28, 30, 34: adaptados a cuentas con ámbitos (D6). «Quitar el acceso» deja la pertenencia sin ámbitos; el núcleo aún no tiene baja ni cierre de sesiones ajenas (C7).
- 15: la subida a Storage se intercepta en el arnés (`routeStorage`); ticket, verificación, marcador `$blob`, fila, descarga por `attachments/:id` y apertura sin red son los reales.

**Pendientes (4):** 24 (respaldo), 32 (copia portable), 33 (CSV), 44 (filtros por REST: `GET tabs/:tabId/tasks`). Sus entradas de menú siguen ocultas.

**Diferido (1):** 29 (aprobación de agentes).

Sin portar todavía: `tests/updates.cjs` (6 escenarios de activación del service worker) y lo que queda de `tests/cloud-browser.mjs` (foto 3200→1600 px, reintento de importación portable).

Cambios en la interfaz heredada hechos en esta tanda, todos por el paso de ids fijos a uuid o por defectos destapados por las pruebas:

- Familias equivalentes entre áreas (`familyKey`, `filterGroups` en `sync.js`; una línea en `index.html` y dos en `filters-ui.js`): antes todas las áreas compartían los ids `person`, `trade`…; ahora las de la misma clave de sistema o el mismo nombre cuentan como una sola faceta en filtros y en «Mis tareas».
- La descarga de adjuntos se atiende en fase de captura: en escritorio el diálogo detenía la propagación y el navegador abría el enlace sin sesión.
- Sesión caducada: la cola se conserva y se vuelve a pedir la cuenta; con cambios pendientes solo puede entrar la misma cuenta.
- Pantalla «Cuentas de personas» sobre `members` y `members/invite` (contraseña temporal mostrada una vez).

## Siguiente tanda

1. Rutas `tabs/:tabId/tasks` (44), CSV (33), copia portable (32), respaldo (24) y `trash/empty` en `tasks-api`, con sus entradas de menú.
2. Escenarios de actualización del service worker y los restantes de `cloud-browser`.
3. Usar `restore` con `fields` (C16, ya en el núcleo) para la hija en papelera cuyo padre cambió de proyecto.

## Bloqueos

- Ninguno. Abiertos sin bloquear: C2 (resto), C7 (resto), C8, C9, C10, C11, C19.
