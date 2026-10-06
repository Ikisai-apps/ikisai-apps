# Tasks · estado

Actualizado: 6 de octubre de 2026 (tanda 3). **Backend completo para el uso diario; `apps/tasks` arranca sobre el núcleo y pasa 28 de los 72 escenarios en Playwright. No está lista para el corte.**

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

Portados y en verde (28): 1, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 19, 22, 26, 31 (historial y deshacer; falta el antes/después por tarea), 35, 37 (limpieza local; el registro de accesos es de la fase de agentes), 43, 45, 49, 50, 58, 60, 65, 68.

Pendientes (43): 2, 4, 6, 15, 20, 21, 23, 24, 25, 27, 28, 30, 32, 33, 34, 36, 38–42, 44, 46–48, 51–57, 59, 61–64, 66, 67, 69–72. Diferido (1): 29.

De los pendientes, la mayoría son de interfaz pura y deberían pasar sin cambios (no se han ejecutado todavía); los que necesitan trabajo son:

- **15 (adjuntos):** el flujo está escrito (blob → cola → `$blob` → fila; descarga por `attachments/:id` con caché local) pero sin prueba de extremo a extremo.
- **24, 32, 33 (respaldo, copia portable, CSV):** faltan sus rutas en `tasks-api`; las entradas del menú están ocultas.
- **27, 28, 30, 34 (invitados con ámbitos):** falta la pantalla de cuentas sobre `members` y `members/invite`; el servidor ya lo aplica y está probado por API.
- **36 (sesión caducada con cola):** sin probar.
- **44 (filtros por REST):** falta `GET tabs/:tabId/tasks`.
- `tests/updates.cjs` (6 escenarios de activación del service worker) y `tests/cloud-browser.mjs`: sin portar.

## Siguiente tanda

1. Ejecutar y portar los escenarios de interfaz pendientes (2, 4, 6, 20, 21, 23, 25, 38–42, 46–48, 51–57, 59, 61–64, 66, 67, 69–72).
2. Adjuntos de extremo a extremo (15) y sesión caducada (36).
3. Pantalla de cuentas e invitados con ámbitos (27, 28, 30, 34).
4. Rutas `tabs/:tabId/tasks`, `trash/empty`, CSV, copia portable y respaldo, y sus entradas de menú.
5. Service worker: escenarios de actualización.

## Bloqueos

- Ninguno. Abiertos sin bloquear: C2 (resto), C7 (resto), C8, C9, C10, C11, C16, C17.
