# Peticiones del equipo Invoices a Core

Core responde en la columna «Respuesta» y resume en `docs/core/RESPUESTAS.md`.

| Fecha | Petición | Estado | Respuesta |
|---|---|---|---|
| 2026-10-06 | Bearer del usuario en `RequestContext` para validar destinos de Tareas desde `beforeCommit`. | Hecho | `RequestContext.token` (PR #10). |
| 2026-10-06 | Sustitución de marcadores `{"$blob":"<sha256>"}` por `file_id` en `fields` y `args` en `sync-client`. | Hecho | `sync-client` 0.2 (PR #12). |
| 2026-10-06 | Lectura de proyecciones ajenas desde una Edge y funciones de lectura del propio schema. | Hecho | `core.allow_read(...)` + `GET/POST /api/v1/read/<schema>.<objeto>` (PR #10). |
| 2026-10-06 | `npm:fflate` en la Edge para el ZIP en streaming. | Hecho | Sí: Supabase Edge resuelve `npm:`; el despliegue sube el TypeScript tal cual. |
| 2026-10-06 | Confirmar que triggers, funciones propias y columnas generadas de `invoices` pasan el lint y `apply_row_op`. | Hecho | El lint no los restringe; además permite leer `core.memberships`, `core.changes`, `core.files`, `core.synced_tables`. |
| 2026-10-06 | Ruta de resolución de destinos en la API de Tasks (`targets`). | Pendiente (equipo Tasks) | Tasks publicará la lectura `tasks.targets`; mientras tanto Invoices usa `GET /api/v1/snapshot` de `tasks-api` con el token del usuario. |
| 2026-10-06 | Ruta del handoff V3 para cotejar el JSON `ikisai.invoice.v1` y el checklist A. | Hecho | `C:\Users\34606\Documents\Ikisai\App\CORE_IKISAI_APPS_V3\`. API.md revisado (rev. 2). |
| 2026-10-06 | CI roja en PR #2 por `package-lock.json`. | Hecho | No era `main`: la rama era anterior a la regeneración (PR #4). Rebasada. |
| 2026-10-06 | Fase 2: Booking registra `booking.food_event_projection` también para `invoices` (`core.allow_read('invoices', …)`), y Food publica una proyección de catálogo (`food.invoices_catalog_projection`: `kind, id, name, unit, revision`) para destinos `ingredient`/`equipment`. | Pendiente (equipos Booking y Food) | |
| 2026-10-06 | `tests/core/sql.test.ts` tenía dos aserciones que daban por hecho que Invoices solo registraba `suppliers`; las he relajado a «incluye/ya no incluye `suppliers`» en las PR #33 y #37 (una línea cada una). Si Core prefiere otra forma, lo cambio. | Pendiente | |
| 2026-10-06 | Booking: registrar `booking.food_event_projection` también para `invoices` (`core.allow_read('invoices', …, 'view')`). La Edge de Invoices ya la consulta y, mientras no exista, devuelve `TARGET_APP_NOT_AVAILABLE` con el selector deshabilitado. | Pendiente (Booking, fase 2) | |
| 2026-10-06 | Despliegue QA: cuando la PR #37 se fusione, pido humo real de `invoices-api` (importación del ejemplo del handoff y descarga del ZIP) antes de la aceptación en Android. | Pendiente | |

