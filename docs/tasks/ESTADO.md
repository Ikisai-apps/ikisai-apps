# Tasks · estado

Actualizado: 6 de octubre de 2026 (tanda 5). **La app nueva está en producción (`tasks.ikisai.com`; el corte lo hizo la release automática y Core lo dio por bueno). 71 de los 72 escenarios de no regresión en verde, más los 6 de actualización del service worker y «Vaciar papelera». Falta el recorrido manual de aceptación en PC y Android con una cuenta real.**

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

**Service worker** (`tests/tasks/updates.spec.ts`, los 6 de `tests/updates.cjs`): un editor abierto, un borrador en línea, otra pestaña con editor o con borrador y una cola pendiente vetan la actualización; con todas las pestañas de acuerdo se recarga en el worker nuevo conservando cuenta y tareas.

**Vaciar papelera** (`POST trash/empty`, migración `0303`, botón en la papelera para la propietaria con acceso completo, con confirmación y recuento): pasa a la papelera lo que cuelga de contenedores borrados y purga en orden canónico inverso; probado en SQL, por API y en la interfaz con dos dispositivos.

Sin portar todavía: dos de `tests/cloud-browser.mjs` (foto 3200→1600 px; reintento de la importación portable desde la interfaz, que por API sí está probado).

Cambios en la interfaz heredada, todos por el paso de ids fijos a uuid o por defectos destapados por las pruebas:

- Familias equivalentes entre áreas (`familyKey`, `filterGroups`): las de la misma clave de sistema o el mismo nombre cuentan como una sola faceta en filtros y en «Mis tareas».
- La descarga de adjuntos se atiende en fase de captura (en escritorio el diálogo detenía el clic).
- Sesión caducada: la cola se conserva y se vuelve a pedir la cuenta; con cambios pendientes solo puede entrar la misma cuenta.
- Pantalla «Cuentas de personas» sobre `members` y `members/invite`.
- En el menú solo quedan ocultos accesos por clave, propuestas de agentes y registro de accesos (fase de agentes).

## Producción

- `tasks.ikisai.com` sirve la app nueva; `/version.json` y `/api/v1/health` coinciden en la versión. Comprobado sin iniciar sesión (solo lectura): carga en móvil y escritorio sin errores de JavaScript ni recursos fallidos, pide la cuenta, registra el service worker y no desborda.
- **Recorrido manual de aceptación: pendiente.** No lo he hecho con una cuenta real: supone entrar en producción con credenciales de la propietaria y crear datos y una cuenta invitada reales, y eso lo decide el usuario (ver la pregunta en `coordinacion/tasks/SALIDA.md`). Lista de lo que hay que recorrer en PC y Android:
  1. Entrar; crear la primera área; crear un proyecto y tareas con hijas; etiquetar; responsable.
  2. Dependencias: una tarea que depende de otra, completar en orden, intentar completar la bloqueada.
  3. Sin red: editar, recargar, reconectar y ver «Al día».
  4. Conflicto: editar el mismo campo en PC y móvil; resolver en «Revisar cambios».
  5. Adjuntar una foto desde el móvil y un PDF desde el PC; abrirlos en el otro dispositivo y sin red.
  6. Invitar a una persona a un solo proyecto; entrar con su cuenta y comprobar lo que ve; retirarle el acceso.
  7. Deshacer desde el aviso tras completar; historial.
  8. Papelera: borrar y restaurar; vaciar papelera.
  9. CSV, copia portable y respaldo: exportar e importar.
  10. Instalar la PWA en Android; con una versión nueva publicada, «Nueva versión disponible» con y sin un editor abierto.

## Siguiente tanda

1. Corregir lo que salga del recorrido manual.
2. `restore` con `fields` para la hija en papelera cuyo padre cambió de proyecto, cuando el kit y `sync-client` lo acepten (C22).
3. Los dos escenarios restantes de `cloud-browser`.

## Bloqueos

- Ninguno. Abiertos sin bloquear: C2 (resto), C7 (resto), C8, C9, C10, C11, C19, C20, C22.
