# Booking · peticiones a Core

Peticiones del equipo Booking sobre lo compartido (`core`, `_kit`, `sync-client`, `test-kit`, raíz, CI). El detalle de cada una está en `API.md` §13. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

| Nº | Fecha | Petición | Estado | Respuesta |
|---|---|---|---|---|
| P1 | 2026-10-06 | Invocar funciones `booking.*` y leer la proyección desde la Edge | Hecho | `core.allow_read(app, nombre, 'function' \| 'view')` y ruta `GET/POST /api/v1/read/:name` (contrato §5.1). Booking registra sus funciones de lectura y la proyección para Food. |
| P2 | 2026-10-06 | Empaquetar el código de dominio con la función | Hecho | El dominio vive en `supabase/functions/_domain/booking/`; `packages/domain-booking` solo lo reexporta. |
| P3 | 2026-10-06 | `sync-client`: efectos locales para un `call` | Pendiente | Mientras tanto, marca propia de la app (`API.md` §10). |
| P4 | 2026-10-06 | `sync-client`: borrar el espejo al cerrar sesión | Hecho | `clearOnLogout: [tablas]` en `sync-client` 0.2. Los cambios pendientes de esas tablas se descartan: la app avisa antes si hay cola. |
| P5 | 2026-10-06 | Lint: permitir FK a `core.files`; hook de visibilidad en `files/:id` | Hecho en parte | El lint admite leer `core.files`. El hook de visibilidad en `files/:id` sigue pendiente. |
| P6 | 2026-10-06 | `core.redact_row_history` y borrado de archivos | Pendiente | No bloquea V1 (ningún dato vence antes de octubre de 2029). |
| P7 | 2026-10-06 | Secretos de `booking-api` para Calendar | Pendiente del usuario | Pedida al usuario en `coordinacion/booking/SALIDA.md`. Core la cargará como `GOOGLE_SERVICE_ACCOUNT_JSON`; hace falta también `BOOKING_CALENDAR_ID`. |
| P8 | 2026-10-06 | Rutas de sistema y planificador para reintentos de Calendar | En curso | Core pondrá un planificador cada 5 minutos sobre el tick; depende de P16. |
| P9 | 2026-10-06 | `trash/purge`: orden por dependencias FK | Pendiente | Booking envía siempre la lista ordenada. |
| P10 | 2026-10-06 | `event_revision` como contador propio y columnas extra de la proyección | Hecho | Aceptado; contrato §8 ampliado. |
| P11 | 2026-10-06 | Carga inicial desde C03/C04 | Retirada | Se empieza de cero. |
| P12 | 2026-10-06 | Tablas cerradas (`readable_roles '{}'`) | Hecho | Core confirma en la ronda 3 que es el mecanismo previsto. |
| P13 | 2026-10-06 | `sync-client`: adjunto en cola → `file_id` | Hecho | Marcador `{"$blob": "<sha256>"}` en el campo; `sync-client` 0.2 lo sustituye al reconectar. |
| P14 | 2026-10-06 | Que la CI ejecute las pruebas de cada app | Hecho | `npm run test` recorre `tests/<carpeta>/*.test.ts` (PR #34). |
| P15 | 2026-10-06 | Ejecutar funciones internas que escriben fuera de `core.commit` | Hecho | Acciones `core.allow_read(…, 'action', roles)` con `POST invoke/:name` y `POST worker/:name`. Usadas por la cola de Calendar. |
| P16 | 2026-10-06 | **Rutas `worker` con lógica en TypeScript.** Las acciones son solo SQL (`core.invoke` ejecuta `schema.fn(jsonb)`), pero el tick de Calendar necesita TypeScript: reclama por SQL, construye el payload con el dominio, llama a Google y reporta. Hoy existe como ruta propia `POST /api/v1/calendar/tick` con sesión de editor o propietario. Propuesta: `AppConfig.workerRoutes` (o que las rutas propias reciban una marca de sistema) validadas con `X-Ikisai-Worker-Key`, actor null y rol `system`, para que el planificador llame a `POST /api/v1/worker/booking.calendar_tick` | Pendiente | Mientras tanto la cola solo avanza cuando un editor lanza el tick; no afecta a nadie hasta que haya credenciales de Google. |
| P17 | 2026-10-06 | El icono de la cabecera del shell (`mark`) es un documento en las cuatro apps. Si el kit admite un icono por app, Booking usaría `calendar` | Pendiente (UI) | Cosmético. |

Otras mejoras del núcleo de la ronda G2 que Booking usa: errores SQL como 422 con `sqlstate` (nunca 503), `RequestContext.token`, alta de cuentas con `POST /api/v1/members/invite` y lotes rechazados visibles en `sync-client`.
