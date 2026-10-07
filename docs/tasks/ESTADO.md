# Tasks · estado

Actualizado: 6 de octubre de 2026 (tanda 13). **La app nueva está en producción (`tasks.ikisai.com`) y aceptada por el usuario. **los 72 escenarios de no regresión en verde**, más los de actualización del service worker y «Vaciar papelera». Propuesta de agentes para el núcleo en `docs/tasks/AGENTES.md`, aceptada por Core como base y con sus decisiones cerradas (umbral de 10 elementos y caducidad de 24 horas, del usuario). Adopción del `ui-kit` empezada: la entrada ya es la del kit.**

## Hecho

- **Diseño:** `docs/tasks/API.md` (G2 aprobada; §16 resolución de Core; §17 cómo quedó el adaptador). `docs/tasks/AGENTES.md`: propuesta para llevar al núcleo las claves de agente, las propuestas con aprobación humana, el registro de accesos y el MCP de la app antigua (diseño para Core; seis decisiones abiertas en su §10).
- **Dominio** (`supabase/functions/_domain/tasks`, reexportado por `@ikisai/domain-tasks`): tipos, ámbitos y `visible`, validación de lotes, estados y ciclos, operaciones compuestas y el puente con el modelo anidado de la interfaz (`compose`, `decompose`, `adoptLegacyIds`).
- **Base de datos:** migraciones `0300` (diez tablas), `0301` (hook `tasks.validate_batch`, `tasks.import_rows`, lectura `tasks.targets`) y `0302` (claves solo exigidas a filas vivas).
- **`tasks-api`:** hooks `visible` y `beforeCommit`, subidas a `ikisai-files`, `GET blockers`, `GET attachments/:id`, y las rutas de consulta e intercambio de `exchange.ts` (`tabs/:tabId/tasks`, `csv`, `csv/preview`, `portable`, `portable/preview`, `portable/import`, `backup`), y la ruta de sistema `worker/imports/cleanup`, que retira de Storage los paquetes de importación vencidos (C23; a falta de que Core le ponga la clave de worker y la añada al planificador). Desplegada por Core (las de intercambio, en el próximo despliegue); Invoices ya usa `tasks.targets`.
- **`apps/tasks`** (tanda 3):
  - `public/`: la interfaz antigua copiada de `ikisai-tasks` `d02bf44` (scripts clásicos), con tres cambios mínimos (familia Persona por `system`, carga de `/sync-core.js`, caché `ikisai-shell-v12`).
  - `src/core.ts` → `/sync-core.js`: núcleo del adaptador sobre `@ikisai/sync-client` (espejo en memoria, `model()`, `plan()`, `commit()`, conflictos, rechazados, blobs, bloqueos privados).
  - `public/sync.js` reescrito: conserva `Sync`, `api`, `save`, `syncNow`, `setMode`, `persistUI`, `adopt`, `editorFields`, `cachedAttachment`, hojas de sincronización, conflicto y lote fallido, importación JSON, y traduce `history`/`undo`/`auth/password` a las rutas del núcleo.
  - `public/cloud-auth.js` reescrito: entrada por correo, «Mi cuenta», cierre de sesión que borra lo local, adjuntos como blob (fotos a WebP 1600 px) y arranque.
  - `_worker.js` hacia `tasks-api`; `vite build` deja `dist/` listo para Pages.
- **Pruebas:** 56 `node:test` de Tasks (dominio, SQL, API, conformidad 13/13, puente) dentro de las 226 del repo, y `tests/tasks/app.spec.ts` (Playwright contra la `tasks-api` real en PGlite).

## Escenarios de no regresión (72)

Playwright contra la `tasks-api` real en PGlite (solo Supabase está simulado): `tests/tasks/ui.spec.ts` (los escenarios originales con sus mismos gestos, sobre la semilla de demostración antigua con uuid: `tests/tasks/fixtures/demo.json`) y `tests/tasks/app.spec.ts` (sincronización, conflictos, rechazos y permisos). Las rutas de intercambio tienen además pruebas por API en `tests/tasks/exchange.test.ts`.

**En verde (72):** 1–72. El 29 y la mitad del 37 (registro de accesos), en `tests/tasks/agents.spec.ts`.

- 24, 32, 33, 44: rutas nuevas de `tasks-api` (`backup`, `portable`, `portable/preview`, `portable/import`, `csv`, `csv/preview`, `tabs/:tabId/tasks`). La copia portable es un ZIP sin compresión con el modelo anidado (`data.json`) y los adjuntos por huella; importarla crea áreas nuevas con ids independientes mediante `tasks.import_rows`, y reintentar con el mismo `requestId` no duplica.
- 27, 28, 30, 34: adaptados a cuentas con ámbitos (D6). «Quitar el acceso» deja la pertenencia sin ámbitos; el núcleo aún no tiene baja ni cierre de sesiones ajenas (C7).
- 31: historial con autor y deshacer; el filtro por tarea se hace en el cliente sobre los últimos 200 lotes (C8).
- 37: limpieza local al cerrar sesión (`app.spec.ts`) y registro de accesos (`agents.spec.ts`).
- 15: la subida a Storage se intercepta en el arnés (`routeStorage`); ticket, verificación, marcador `$blob`, fila, descarga por `attachments/:id` y apertura sin red son los reales.


**Service worker** (`tests/tasks/updates.spec.ts`, los 6 de `tests/updates.cjs` y uno más): un editor abierto, un borrador en línea, la paleta abierta, una selección múltiple, un campo de texto con el foco, otra pestaña con editor o con borrador y una cola pendiente vetan la actualización; con todas las pestañas de acuerdo se recarga en el worker nuevo conservando cuenta y tareas. Si llegan dos comprobaciones seguidas, el desbloqueo de 8 s cuenta desde la última.

**Vaciar papelera** (`POST trash/empty`, migración `0303`, botón en la papelera para la propietaria con acceso completo, con confirmación y recuento): pasa a la papelera lo que cuelga de contenedores borrados y purga en orden canónico inverso; probado en SQL, por API y en la interfaz con dos dispositivos.

**`tests/cloud-browser.mjs`:** sus escenarios quedan cubiertos; los dos últimos, en `ui.spec.ts`: una foto de 3200 px llega a Storage como WebP de 1600 px sin conservar el original, y si se pierde la respuesta final de una importación portable, reintentar desde la interfaz crea una sola copia.

Cambios en la interfaz heredada, todos por el paso de ids fijos a uuid o por defectos destapados por las pruebas:

- Familias equivalentes entre áreas (`familyKey`, `filterGroups`): las de la misma clave de sistema o el mismo nombre cuentan como una sola faceta en filtros y en «Mis tareas».
- La descarga de adjuntos se atiende en fase de captura (en escritorio el diálogo detenía el clic).
- Sesión caducada: la cola se conserva y se vuelve a pedir la cuenta; con cambios pendientes solo puede entrar la misma cuenta.
- Pantalla «Cuentas de personas» sobre `members` y `members/invite`.
- En el menú solo quedan ocultos accesos por clave, propuestas de agentes y registro de accesos (fase de agentes).

## Adopción del `ui-kit`

- **Entrada** (PR #75, agente de UI): `loginSheet()` pinta `IkisaiKit.renderLogin` a pantalla completa con los ids de siempre y el error en línea (`#loginError`). El kit llega como `/kit.js` y `/kit.css` (`src/kit.ts`, segunda pasada de `vite build`), con su CSS acotado a `.ikisai-kit` mientras conviva con el heredado.
- En escritorio la entrada ocupa todo el ancho (sin el hueco del menú lateral) y queda centrada en la ventana.
- Reglas y orden en `docs/tasks/UI_KIT.md`.

## Papelera y sincronización (tanda 7)

- **`restore` con `fields`** (C22): restaurar y corregir van en una sola operación. `restoreTaskOps` devuelve a la hija con su padre si este cambió de proyecto; la interfaz heredada, que la muestra en su proyecto antiguo, la restaura como tarea suelta. Antes daba `INVALID_PARENT`.
- **Cierre de sesión:** la app ya no se repinta mientras se vacía el espejo (dejaba un `TypeError` en la consola).
- **`syncNow()`** garantiza un ciclo empezado después de la llamada, también si se unió al final de uno en curso.

## Agentes (tandas 10 y 11)

- **Riesgo de dominio** (`_domain/tasks/risk.ts`, `tasksAgentRisk`, conectado como `hooks.agentRisk` en `tasks-api`): archivar un proyecto, una familia o una etiqueta exige aprobación aunque sea una sola fila; `affectedEstimate` cuenta lo que cuelga (tareas de un proyecto, etiquetas de una familia, todo un área, hijas vivas de una tarea borrada), solo lo visible para el agente, para que el umbral de 10 se aplique sobre el alcance real.
- **Interfaz** (`public/agents-ui.js`, sobre las rutas `agents`, `proposals` y `access-log` del núcleo; sustituye a las hojas de la app antigua): «Agentes de IA» (crear con permiso y áreas, la clave se muestra una sola vez; revocar), «Propuestas de agentes» (lista, resumen legible del ensayo, aprobar o rechazar; si ya no encaja, queda rechazada) y «Registro de accesos». Solo para la propietaria con acceso completo.
- **Escenario 29** (`tests/tasks/agents.spec.ts`): el borrado de un agente devuelve 428, queda propuesto, la propietaria lo aprueba desde la interfaz y el agente lo aplica tal cual; archivar un proyecto también exige aprobación; el registro lo cuenta; revocar corta al agente al momento.
- **Herramientas de dominio para MCP** (`_domain/tasks/tools.ts`, tanda 12): `TASK_TOOL_SPECS` (nombre, descripción, JSON Schema y pistas `destructiveHint`/`idempotentHint`) y `buildTaskTool(name, data, input)` para `tasks_create_task`, `tasks_update_task`, `tasks_complete`, `tasks_move`, `tasks_delete`, `tasks_set_labels` y `tasks_set_dependencies`. Validan la entrada no fiable (422 `INVALID_INPUT`), solo ven lo visible (404 `NOT_FOUND`) y reutilizan las operaciones compuestas de `ops.ts`; su lote pasa por el camino de siempre (validación, riesgo, propuesta, `core.commit`).
- **Compras para agentes** (tanda 27, §18 y AGENTES.md §6): `tasks_low_stock` (solo lectura), `tasks_request_purchase` (pedir, sin aprobación: la solicitud nace «pedida») y `tasks_prepare_purchase_plan` (siempre con aprobación por `agentRisk`; agrupa solo lo ya aprobado). Interfaz de compras en `public/purchases-ui.js` (tanda 26).
- **Conectadas a `/api/v1/mcp`** (`tasks-api/mcp.ts`, tanda 13): cada herramienta lee lo visible para quien llama (papelera incluida), construye el lote y lo envía como `commands`. Si necesita aprobación, devuelve `needsApproval` con la propuesta preparada, que el agente aplica después con `tasks_commit`. `requestId` opcional; los ids nuevos se derivan de él, así que reintentar antes de aplicarse construye el mismo lote, y reintentar algo ya aplicado devuelve `alreadyUsed` sin repetirlo.
- Pendiente: `describeChange` en la Edge solo si Core lo añade (hoy el resumen de una propuesta se describe en la interfaz).

## Aceptación V1 del usuario (tandas 17 a 20)

- **1 y 2** (#136): arranque con el motivo real y «Reintentar»; lecturas del espejo solapadas con un guardado ya no devuelven a su valor anterior lo que cambió otro dispositivo (caso del usuario: Tasks abierta en dos sitios).
- **3, 4, 5, 6, 8, 10, 11, 12 y 13** (#139): contraseña sin autorrelleno en el buscador; «Entrada» solo con pendientes; ✓ en los campos en línea; fila de tarea con un solo «Editar»; archivadas ocultas con «Ver archivadas»; texto de adjuntos; sin selector de área repetido; filtros de Proyectos que eligen proyectos; PWA «Tasks» con el icono de UI.
- **7, familia de responsables** (migración `0304`): interruptor en el editor de familia; una por área; mover la marca quita los responsables de la anterior.
- **9, etiquetas padre e hija**: «Padre: Hija» en chips, selectores y filtros; elegir una hija añade su padre (filtrar por el padre la incluye); varias hijas de padres distintos; dos niveles como máximo y en la misma familia (`0304`). Los vínculos antiguos entre familias (la app antigua colgaba un espacio de un edificio) se conservan y se ven sin «Padre:».
- **14, color personalizado**: pendiente del campo de color del kit (#140).
- Pruebas: `boot.spec.ts`, `areacolor.spec.ts`, `acceptance-v1.spec.ts` y las adaptadas.

## Producción

- `tasks.ikisai.com` sirve la app nueva; `/version.json` y `/api/v1/health` coinciden en la versión. Comprobado sin iniciar sesión (solo lectura): carga en móvil y escritorio sin errores de JavaScript ni recursos fallidos, pide la cuenta, registra el service worker y no desborda.
- **Recorrido manual de aceptación: hecho por el usuario** («Tareas ok», ronda 8 de Core). El repo antiguo está archivado y el esquema `ikisai.*` retirado.

## Siguiente tanda

1. Adopción del `ui-kit` (la hace el agente de UI; Tasks revisa y fusiona): tarjeta de proyecto, después la cáscara en dos pasos. Ver `docs/tasks/UI_KIT.md`.
2. Lo que salga de la aceptación en Android.

## Bloqueos

- Ninguno. Abiertos sin bloquear: C2 (resto), C7 (resto), C8, C9, C10, C11, C19, C20.

- **Sugerencias y QA, y uso de funciones** (tanda 40, `coordinacion/ampliacion/FEEDBACK.md` fase 4 y `USO.md`; referencia, Booking #227):
  - `public/feedback-ui.js` monta lo del kit 0.17: `createFeedback`, con sus capas dentro de un contenedor `.ikisai-kit` porque la hoja del kit va acotada; `createFeedbackReview`; `createUsage`; el lanzador con los dos interruptores, y la limpieza con `onSessionEnd`, ahora expuesto en `src/core.ts`.
  - «Sugerencias y QA» está en el menú (grupo Sistema) y abre el centro del kit dentro de `#kitLayer`.
  - Marcas `data-feedback-id` y `data-feedback-label` en todo control con significado: 437 funciones de 34 archivos, sin ids dinámicos (`packages/ui-kit/scripts/feature-catalog.mjs --app tasks`).
    - La cáscara y la pantalla actual las marca `feedback-ui.js` con mapas de ids literales; el resto va escrito en cada plantilla.
    - Los datos personales y lo que se copia llevan `data-feedback-ignore`.
  - `usage.track` / `usage.run` en las operaciones importantes:
    - tareas: crear, completar, reabrir, borrar, restaurar y mover;
    - compras: aprobar y recibir;
    - preparar un plan;
    - mover una petición;
    - importar y exportar la copia portable, y el respaldo.
  - **Reglas para quien toque plantillas:**
    - no metas atributos dentro de una cadena que otro módulo busque con `.replace` (`SAVED_VIEWS_BUTTON`, `quickAdd`, `dragHelp`…);
    - los `[data-tab]` heredados excluyen el centro del kit;
    - `taller.css` ya no pisa los `.segmented` del kit.
  - Pruebas: `tests/tasks/feedback-ids.test.ts` (forma y literales) y `tests/tasks/feedback.spec.ts` (interruptor, pulsación larga, envío real, centro y uso).
