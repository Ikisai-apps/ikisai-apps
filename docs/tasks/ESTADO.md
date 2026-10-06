# Tasks · estado

Actualizado: 6 de octubre de 2026 (tanda 4, cierre). **`apps/tasks` pasa 71 de los 72 escenarios de no regresión en Playwright (el 29 es de la fase de agentes), con adjuntos, invitados, CSV, copia portable y respaldo de extremo a extremo. Lista para que Core la publique en `tasks-next` y se compare con la app antigua; antes del corte faltan los escenarios de actualización del service worker.**

## Hecho

- **Diseño:** `docs/tasks/API.md` (G2 aprobada; §16 resolución de Core; §17 cómo quedó el adaptador).
- **Dominio** (`supabase/functions/_domain/tasks`, reexportado por `@ikisai/domain-tasks`): tipos, ámbitos y `visible`, validación de lotes, estados y ciclos, operaciones compuestas y el puente con el modelo anidado de la interfaz (`compose`, `decompose`, `adoptLegacyIds`).
- **Base de datos:** migraciones `0300` (diez tablas), `0301` (hook `tasks.validate_batch`, `tasks.import_rows`, lectura `tasks.targets`) y `0302` (claves solo exigidas a filas vivas).
- **`tasks-api`:** hooks `visible` y `beforeCommit`, subidas a `ikisai-files`, `GET blockers`, `GET attachments/:id`, y las rutas de consulta e intercambio de `exchange.ts` (`tabs/:tabId/tasks`, `csv`, `csv/preview`, `portable`, `portable/preview`, `portable/import`, `backup`). Desplegada por Core (las de intercambio, en el próximo despliegue); Invoices ya usa `tasks.targets`.
- **`apps/tasks`** (tanda 3):
  - `public/`: la interfaz antigua copiada de `ikisai-tasks` `d02bf44` (scripts clásicos), con tres cambios mínimos (familia Persona por `system`, carga de `/sync-core.js`, caché `ikisai-shell-v12`).
  - `src/core.ts` → `/sync-core.js`: núcleo del adaptador sobre `@ikisai/sync-client` (espejo en memoria, `model()`, `plan()`, `commit()`, conflictos, rechazados, blobs, bloqueos privados).
  - `public/sync.js` reescrito: conserva `Sync`, `api`, `save`, `syncNow`, `setMode`, `persistUI`, `adopt`, `editorFields`, `cachedAttachment`, hojas de sincronización, conflicto y lote fallido, importación JSON, y traduce `history`/`undo`/`auth/password` a las rutas del núcleo.
  - `public/cloud-auth.js` reescrito: entrada por correo, «Mi cuenta», cierre de sesión que borra lo local, adjuntos como blob (fotos a WebP 1600 px) y arranque.
  - `_worker.js` hacia `tasks-api`; `vite build` deja `dist/` listo para Pages.
- **Pruebas:** 56 `node:test` de Tasks (dominio, SQL, API, conformidad 13/13, puente) dentro de las 226 del repo, y `tests/tasks/app.spec.ts` (Playwright contra la `tasks-api` real en PGlite).

## Escenarios de no regresión (72)

Playwright contra la `tasks-api` real en PGlite (solo Supabase está simulado): `tests/tasks/ui.spec.ts` (los escenarios originales con sus mismos gestos, sobre la semilla de demostración antigua con uuid: `tests/tasks/fixtures/demo.json`) y `tests/tasks/app.spec.ts` (sincronización, conflictos, rechazos y permisos). Las rutas de intercambio tienen además pruebas por API en `tests/tasks/exchange.test.ts`.

**En verde (71):** 1–28 y 30–72.

- 24, 32, 33, 44: rutas nuevas de `tasks-api` (`backup`, `portable`, `portable/preview`, `portable/import`, `csv`, `csv/preview`, `tabs/:tabId/tasks`). La copia portable es un ZIP sin compresión con el modelo anidado (`data.json`) y los adjuntos por huella; importarla crea áreas nuevas con ids independientes mediante `tasks.import_rows`, y reintentar con el mismo `requestId` no duplica.
- 27, 28, 30, 34: adaptados a cuentas con ámbitos (D6). «Quitar el acceso» deja la pertenencia sin ámbitos; el núcleo aún no tiene baja ni cierre de sesiones ajenas (C7).
- 31: historial con autor y deshacer; el filtro por tarea se hace en el cliente sobre los últimos 200 lotes (C8).
- 37: limpieza local al cerrar sesión; el registro de accesos es de la fase de agentes.
- 15: la subida a Storage se intercepta en el arnés (`routeStorage`); ticket, verificación, marcador `$blob`, fila, descarga por `attachments/:id` y apertura sin red son los reales.

**Diferido (1):** 29 (aprobación de agentes).

Sin portar todavía: `tests/updates.cjs` (6 escenarios de activación coordinada del service worker) y dos de `tests/cloud-browser.mjs` (foto 3200→1600 px; reintento de la importación portable desde la interfaz, que por API sí está probado).

Cambios en la interfaz heredada, todos por el paso de ids fijos a uuid o por defectos destapados por las pruebas:

- Familias equivalentes entre áreas (`familyKey`, `filterGroups`): las de la misma clave de sistema o el mismo nombre cuentan como una sola faceta en filtros y en «Mis tareas».
- La descarga de adjuntos se atiende en fase de captura (en escritorio el diálogo detenía el clic).
- Sesión caducada: la cola se conserva y se vuelve a pedir la cuenta; con cambios pendientes solo puede entrar la misma cuenta.
- Pantalla «Cuentas de personas» sobre `members` y `members/invite`.
- En el menú solo quedan ocultos accesos por clave, propuestas de agentes y registro de accesos (fase de agentes).

## Siguiente tanda

1. Escenarios de actualización del service worker (`tests/updates.cjs`) y los dos restantes de `cloud-browser`.
2. `POST trash/empty` (vaciar papelera con el orden de tablas de Tasks) y su entrada en la interfaz.
3. Usar `restore` con `fields` (C16, ya en el núcleo) para la hija en papelera cuyo padre cambió de proyecto.
4. Recorrido manual en PC y Android sobre `tasks-next` cuando Core la publique.

## Bloqueos

- Ninguno. Abiertos sin bloquear: C2 (resto), C7 (resto), C8, C9, C10, C11, C19.
