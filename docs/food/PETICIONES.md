# Food · peticiones a Core y a otros equipos

Food anota aquí lo que necesita de los directorios compartidos o de otra app. Core responde en la misma fila y resume en `docs/core/RESPUESTAS.md`. El detalle de P1–P8 está en `docs/food/API.md` §14.

| # | Fecha | A quién | Petición | Estado | Respuesta |
|---|---|---|---|---|---|
| P1 | 2026-10-06 | Core | Leer `booking.food_event_projection` y las tablas propias desde la Edge. | Hecho | Lecturas registradas: `core.allow_read` y `GET/POST /api/v1/read/:name` (contrato §5.1). |
| P2 | 2026-10-06 | Core | Errores de restricción SQL como 422 en `_kit`; convención «error de dominio = 422». | Hecho | 422 con `details.sqlstate` (contrato §5.2); `sync-client` 0.2 expone los lotes rechazados. |
| P3 | 2026-10-06 | Core | Enlace blob → `file_id` en `sync-client`. | Hecho | Marcador `{"$blob": "<sha256>"}` en `sync-client` 0.2. |
| P4 | 2026-10-06 | Core | FK a `core.files` desde migraciones de app. | Hecho | El lint permite FK y lecturas a `core.files`, `core.memberships`, `core.changes` y `core.synced_tables`. |
| P5 | 2026-10-06 | Core + Booking | `event_revision` debe cambiar con cualquier dato proyectado. | Hecho | Contador propio de Booking (contrato §8). |
| P5b | 2026-10-06 | Booking | Columnas adicionales de la proyección (`API.md` §7.1): estado de la reserva o `active`, `guest_count_is_final`, `meal_notes`, forma fija de `dietary_restrictions` y catálogos cerrados de `meal_plan` y `menu_style`. | Pendiente | |
| P6 | 2026-10-06 | Core | Política para archivos sin referencia tras reemplazar una foto. | Pendiente | |
| P7 | 2026-10-06 | Core + Booking | `booking.events` en una migración anterior a `food_menus`. | Pendiente | |
| P8 | 2026-10-06 | Core | Menor: caché de lecturas no sincronizadas como función de `sync-client`. | Pendiente | |
