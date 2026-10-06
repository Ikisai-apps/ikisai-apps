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
| P7 | 2026-10-06 | Secretos de `booking-api` para Calendar | Pendiente | La clave JSON de la cuenta de servicio se pide a Víctor al llegar a Calendar; hasta entonces, adaptador falso. |
| P8 | 2026-10-06 | Rutas de sistema y planificador para reintentos de Calendar | Pendiente | Mientras tanto, reintento oportunista. |
| P9 | 2026-10-06 | `trash/purge`: orden por dependencias FK | Pendiente | Booking envía siempre la lista ordenada. |
| P10 | 2026-10-06 | `event_revision` como contador propio y columnas extra de la proyección | Hecho | Aceptado; contrato §8 ampliado. |
| P11 | 2026-10-06 | Carga inicial desde C03/C04 | Retirada | Se empieza de cero. |
| P12 | 2026-10-06 | Tablas cerradas (`readable_roles '{}'`) | Pendiente | Sin objeción de Core en la ronda G2. |
| P13 | 2026-10-06 | `sync-client`: adjunto en cola → `file_id` | Hecho | Marcador `{"$blob": "<sha256>"}` en el campo; `sync-client` 0.2 lo sustituye al reconectar. |
| P14 | 2026-10-06 | Que la CI ejecute las pruebas de cada app: hoy `npm run test` solo lanza `tests/core/*.test.ts`, así que `tests/booking/*.test.ts` (conformidad, SQL y dominio de Booking) no corren en `checks.yml`. Propuesta: script raíz `test:apps` con `tsx --test tests/booking/*.test.ts tests/…` o un patrón `tests/*/*.test.ts` que excluya los `*.spec.ts` de Playwright | Pendiente | Mientras tanto se ejecutan en local antes de cada PR (`npx tsx --test tests/booking/*.test.ts`). |
| P15 | 2026-10-06 | `core.read` es `stable`: una función registrada con `core.allow_read` no puede escribir. El worker de Calendar necesita reclamar trabajos y anotar resultados (`booking.calendar_claim`, `booking.calendar_report`) desde la Edge, fuera de `core.commit` porque son tablas cerradas. Hace falta una vía de ejecución para funciones internas de la app con service key | Pendiente | Se necesita para la fase B3; B1 y B2 no dependen de ella. |

Otras mejoras del núcleo de la ronda G2 que Booking usa: errores SQL como 422 con `sqlstate` (nunca 503), `RequestContext.token`, alta de cuentas con `POST /api/v1/members/invite` y lotes rechazados visibles en `sync-client`.
