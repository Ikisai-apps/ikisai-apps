# Food · peticiones a Core y a otros equipos

Food anota aquí lo que necesita de los directorios compartidos o de otra app. Core responde en la misma fila y resume en `docs/core/RESPUESTAS.md`. El detalle de P1–P8 está en `docs/food/API.md` §14.

| # | Fecha | A quién | Petición | Estado | Respuesta |
|---|---|---|---|---|---|
| P1 | 2026-10-06 | Core | Leer `booking.food_event_projection` y las tablas propias desde la Edge. | Hecho | Lecturas registradas: `core.allow_read` y `GET/POST /api/v1/read/:name` (contrato §5.1). |
| P2 | 2026-10-06 | Core | Errores de restricción SQL como 422 en `_kit`; convención «error de dominio = 422». | Hecho | 422 con `details.sqlstate` (contrato §5.2); `sync-client` 0.2 expone los lotes rechazados. |
| P3 | 2026-10-06 | Core | Enlace blob → `file_id` en `sync-client`. | Hecho | Marcador `{"$blob": "<sha256>"}` en `sync-client` 0.2. |
| P4 | 2026-10-06 | Core | FK a `core.files` desde migraciones de app. | Hecho | El lint permite FK y lecturas a `core.files`, `core.memberships`, `core.changes` y `core.synced_tables`. |
| P5 | 2026-10-06 | Core + Booking | `event_revision` debe cambiar con cualquier dato proyectado. | Hecho | Contador propio de Booking (contrato §8). |
| P5b | 2026-10-06 | Booking | Columnas adicionales de la proyección (`API.md` §7.1): estado de la reserva o `active`, `guest_count_is_final`, `meal_notes`, forma fija de `dietary_restrictions` y catálogos cerrados de `meal_plan` y `menu_style`. | Hecho | `booking.food_event_projection` (migración `20261006_0006`) trae `reservation_status`, `guest_count_is_final`, `requires_meals` y `meal_notes`; las restricciones salen como `{type, subject, severity, servings, kitchen_notes}`. |
| P6 | 2026-10-06 | Core | Política para archivos sin referencia tras reemplazar una foto. | Pendiente | |
| P7 | 2026-10-06 | Core + Booking | `booking.events` en una migración anterior a `food_menus`. | Hecho | Booking fusionó `20261006_0005_booking_base.sql` (PR 16); `food_menus` es `20261006_0110`. |
| P8 | 2026-10-06 | Core | Menor: caché de lecturas no sincronizadas como función de `sync-client`. | Pendiente | |
| P9 | 2026-10-06 | Core | **Urgente.** Que la CI ejecute las pruebas de Food: hoy `npm run test` solo lanza `tests/core/*.test.ts`. Añadir `tests/food/*.test.ts` al script `test` de la raíz (o un patrón `tests/*/*.test.ts`). Son 42 pruebas en PGlite, unos 12 s. El 6 de octubre la migración de Booking que publicó la proyección dejó 7 pruebas de Food en rojo en `main` y la CI siguió en verde; se detectó solo al ejecutarlas a mano. | Pendiente | |
| P10 | 2026-10-06 | Core | Menor: la prueba de subidas de `packages/test-kit` usa siempre un PDF. Food solo admite imágenes, así que su conformidad monta la app con `allowedMime` de PDF. Un parámetro con el tipo de muestra lo evitaría. | Pendiente | |
| P11 | 2026-10-06 | Core | Poder dar de baja una tabla y una lectura registradas (`core.unregister_table`, `core.disallow_read` o equivalente) para retirar `food.stub_events` y `food.event_projection_stub`. Sin eso, borrar la tabla dejaría una fila colgando en `core.synced_tables` y el `snapshot` del owner fallaría. Mientras tanto queda inerte: vacía, solo visible para `owner` y sin uso en `food-api`. | Pendiente | |
